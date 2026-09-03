using System.Diagnostics;
using System.Text;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Scripting;

/// <summary>
/// Runs agent-supplied scripts (PLAN 6.1) and streams their output back.
///
/// Three things here are guardrails, not conveniences (PLAN 6.3, CLAUDE.md
/// constraint #5): the user is told on their own session indicator that a script
/// ran, output is capped so a runaway loop cannot exhaust memory, and every
/// process is killed — whole tree — on timeout or session end. The audit record
/// with the full script text is written server-side *before* the process starts,
/// which is why the applet does not need to log anything itself.
/// </summary>
internal sealed class ScriptRunner : IDisposable
{
    /// <summary>PLAN 6.1 default; a script that outlives this is killed.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(120);

    /// <summary>PLAN 6.3 output cap.</summary>
    private const int MaxOutputBytes = 1024 * 1024;

    /// <summary>How often buffered output is flushed to the agent.</summary>
    private static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(250);

    private readonly SessionClient _client;
    private readonly Action<string> _notifyUser;
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Process> _running = [];
    private readonly string _tempDir;
    private bool _disposed;

    public ScriptRunner(SessionClient client, Action<string> notifyUser)
    {
        _client = client;
        _notifyUser = notifyUser;

        // One folder per session, deleted on teardown — nothing survives the
        // session (CLAUDE.md constraint #4).
        _tempDir = Path.Combine(Path.GetTempPath(), "HelpdeskAnywhere", Guid.NewGuid().ToString("N"));
    }

    public void Run(AgentExec request) => _ = Task.Run(() => RunAsync(request));

    private async Task RunAsync(AgentExec request)
    {
        // PLAN 6.3 / constraint #5: the user must never be unaware that code was
        // executed on their machine.
        _notifyUser("The agent ran a script on this computer.");

        if (request.AsSystem)
        {
            // Phase 5 routes this over the pipe to the elevated service. Until then
            // it is refused clearly rather than silently downgraded to the user's
            // own privileges, which would be a lie about what just ran.
            SendFinal(request.Id, -1, "", "Run as SYSTEM requires elevation, which is not available yet (Phase 5).");
            return;
        }

        string scriptPath;
        try
        {
            Directory.CreateDirectory(_tempDir);
            var extension = request.Shell == "cmd" ? ".cmd" : ".ps1";
            // The id comes off the wire; ScriptStaging keeps it inside _tempDir.
            scriptPath = Path.Combine(_tempDir, $"{ScriptStaging.SafeFileName(request.Id)}{extension}");
            await File.WriteAllTextAsync(scriptPath, request.Script, new UTF8Encoding(false));
        }
        catch (Exception ex)
        {
            SendFinal(request.Id, -1, "", $"Could not stage the script: {ex.Message}");
            return;
        }

        var info = request.Shell == "cmd"
            ? new ProcessStartInfo("cmd.exe", $"/c \"{scriptPath}\"")
            : new ProcessStartInfo(
                "powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"");

        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WorkingDirectory = _tempDir;

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var total = 0;
        var truncated = false;
        var gate = new object();

        void Append(StringBuilder target, string? line)
        {
            if (line is null) return;
            lock (gate)
            {
                if (truncated) return;
                if (total + line.Length > MaxOutputBytes)
                {
                    truncated = true;
                    return;
                }
                total += line.Length + 1;
                target.AppendLine(line);
            }
        }

        using var process = new Process { StartInfo = info, EnableRaisingEvents = true };

        // Both streams are read asynchronously through the event pipeline: reading
        // one to completion synchronously deadlocks as soon as the other fills its
        // pipe buffer (PLAN 6.1).
        process.OutputDataReceived += (_, e) => Append(stdout, e.Data);
        process.ErrorDataReceived += (_, e) => Append(stderr, e.Data);

        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            SendFinal(request.Id, -1, "", $"Could not start {info.FileName}: {ex.Message}");
            Cleanup(scriptPath);
            return;
        }

        lock (_running) _running.Add(process);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        timeout.CancelAfter(Timeout);

        var timedOut = false;
        var streamer = StreamPartialsAsync(request.Id, stdout, stderr, gate, timeout.Token);

        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            timedOut = !_cts.IsCancellationRequested;
            KillTree(process);
        }

        // Let the async readers drain what the process wrote before it died.
        try { process.WaitForExit(2000); } catch (Exception) { }

        await streamer;

        lock (_running) _running.Remove(process);

        string finalOut, finalErr;
        lock (gate)
        {
            finalOut = stdout.ToString();
            finalErr = stderr.ToString();
            stdout.Clear();
            stderr.Clear();
        }

        if (truncated)
        {
            finalErr += $"\n[output truncated at {MaxOutputBytes / 1024} KB]\n";
        }

        if (timedOut)
        {
            finalErr += $"\n[killed: exceeded the {Timeout.TotalSeconds:F0}s timeout]\n";
        }

        var exitCode = timedOut ? -1 : SafeExitCode(process);
        SendFinal(request.Id, exitCode, finalOut, finalErr);
        Cleanup(scriptPath);
    }

    /// <summary>
    /// Flush whatever has arrived every 250ms so a long-running script is watchable
    /// rather than silent until it exits (PLAN 6.1).
    /// </summary>
    private async Task StreamPartialsAsync(
        string id, StringBuilder stdout, StringBuilder stderr, object gate, CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(FlushInterval);
            while (await timer.WaitForNextTickAsync(ct))
            {
                string chunkOut, chunkErr;
                lock (gate)
                {
                    if (stdout.Length == 0 && stderr.Length == 0) continue;
                    chunkOut = stdout.ToString();
                    chunkErr = stderr.ToString();
                    stdout.Clear();
                    stderr.Clear();
                }

                _client.Send(new HostExecResult
                {
                    Id = id,
                    ExitCode = -1,
                    Stdout = chunkOut,
                    Stderr = chunkErr,
                    Partial = true,
                });
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void SendFinal(string id, int exitCode, string stdout, string stderr) =>
        _client.Send(new HostExecResult
        {
            Id = id,
            ExitCode = exitCode,
            Stdout = stdout,
            Stderr = stderr,
        });

    private static int SafeExitCode(Process process)
    {
        try { return process.ExitCode; }
        catch (Exception) { return -1; }
    }

    /// <summary>Kill the whole tree: a script that spawned children must not orphan them.</summary>
    private static void KillTree(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
        }
    }

    private static void Cleanup(string scriptPath)
    {
        try { File.Delete(scriptPath); } catch (Exception) { }
    }

    /// <summary>
    /// Session end: kill everything still running and remove the staging folder.
    /// A script must not outlive the consent that authorised it.
    /// </summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try { _cts.Cancel(); } catch (ObjectDisposedException) { }

        Process[] survivors;
        lock (_running) survivors = _running.ToArray();
        foreach (var process in survivors) KillTree(process);

        try { if (Directory.Exists(_tempDir)) Directory.Delete(_tempDir, recursive: true); }
        catch (Exception) { }

        _cts.Dispose();
    }
}
