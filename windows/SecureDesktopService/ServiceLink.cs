using System.Diagnostics;
using System.Text;
using System.Text.Json;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// The service's own connection to the applet's pipe (PLAN 5.5, 6.1).
///
/// It exists for one job: running a script the agent marked <c>asSystem</c>. The
/// applet cannot — it runs as the end user, which is the whole reason elevation
/// exists — and the desktop helper is bound to the Winlogon desktop and dies on
/// every desktop switch. The service is the one process that is both SYSTEM and
/// alive for the whole session.
///
/// GUARDRAILS (PLAN 6.3, CLAUDE.md constraint #5). These are not optional:
///  * the full script text was already audited server-side, before this frame was
///    ever forwarded, so a script cannot run without a record of it existing;
///  * the user is told on their own always-visible indicator that a script ran as
///    SYSTEM — the applet posts that notice before the request reaches here;
///  * output is capped and the process is killed, whole tree, on timeout or
///    session end. A SYSTEM process that outlives the consent that authorised it
///    is exactly what constraint #4 forbids.
/// </summary>
internal sealed class ServiceLink
{
    /// <summary>PLAN 6.1: same timeout the unelevated runner uses.</summary>
    private static readonly TimeSpan ExecTimeout = TimeSpan.FromSeconds(120);

    /// <summary>PLAN 6.3 output cap.</summary>
    private const int MaxOutputChars = 1024 * 1024;

    /// <summary>
    /// How often partial output is flushed to the console (PLAN 6.1), matching
    /// the unelevated runner. Without this an `asSystem` script shows the agent
    /// nothing at all until it exits — up to the full two-minute timeout — which
    /// reads as a hung tool on exactly the scripts most worth watching.
    /// </summary>
    private static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(250);

    private readonly string _pipeName;
    private readonly Action _onSessionOver;
    private readonly List<Process> _running = [];

    /// <summary>
    /// One writer at a time. Scripts run concurrently and each replies when it
    /// finishes, so without this two results can interleave their length-prefixed
    /// frames on the same pipe and the applet reads one corrupt frame instead of
    /// two good ones.
    /// </summary>
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    /// <param name="onSessionOver">
    /// Raised when the applet says the session has ended. That is the fast path
    /// for CLAUDE.md constraint #4: the applet cannot delete a LocalSystem
    /// service itself, so it asks, and the service removes itself immediately
    /// instead of waiting for the watchdog to infer the same thing a minute later.
    /// </param>
    public ServiceLink(string pipeName, Action onSessionOver)
    {
        _pipeName = pipeName;
        _onSessionOver = onSessionOver;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var pipe = PipeChannel.CreateClient(_pipeName);
                await pipe.ConnectAsync(5000, ct).ConfigureAwait(false);

                await WriteAsync(
                    pipe,
                    PipeChannel.TextFrame(PipeChannel.TagHello, PipeChannel.RoleService),
                    ct).ConfigureAwait(false);

                await PumpAsync(pipe, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                // The applet may not be listening yet, or may have gone. The
                // watchdog — not this loop — decides when "gone" is permanent.
                try { await Task.Delay(1000, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
        }

        KillAll();
    }

    private async Task PumpAsync(Stream pipe, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var frame = await PipeChannel.ReadFrameAsync(pipe, ct).ConfigureAwait(false);
            if (frame is null || frame.Length == 0) return;

            switch (frame[0])
            {
                case PipeChannel.TagExec:
                    var request = JsonSerializer.Deserialize<AgentExec>(
                        PipeChannel.TextOf(frame), Protocol.Json);
                    if (request is not null) _ = ExecuteAsync(pipe, request, ct);
                    break;

                case PipeChannel.TagShutdown:
                    _onSessionOver();
                    return;
            }
        }
    }

    private async Task ExecuteAsync(Stream pipe, AgentExec request, CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), "HelpdeskAnywhere-system");
        string scriptPath;

        try
        {
            Directory.CreateDirectory(dir);
            var extension = request.Shell == "cmd" ? ".cmd" : ".ps1";
            // The id came off the wire; the same confinement the unelevated runner
            // applies (security review 2026-09-03) matters far more here, because
            // this process is SYSTEM.
            scriptPath = Path.Combine(dir, $"{SafeName(request.Id)}{extension}");
            await File.WriteAllTextAsync(scriptPath, request.Script, new UTF8Encoding(false), ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await ReplyAsync(pipe, request.Id, -1, "", $"Could not stage the script: {ex.Message}", ct)
                .ConfigureAwait(false);
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
        info.WorkingDirectory = dir;

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var gate = new object();
        var truncated = false;
        // Counted separately from the buffers, because the buffers are drained
        // every flush: the cap is on what the script produced, not on what is
        // waiting to be sent.
        var total = 0;

        void Append(StringBuilder target, string? line)
        {
            if (line is null) return;
            lock (gate)
            {
                if (truncated) return;
                if (total + line.Length > MaxOutputChars)
                {
                    truncated = true;
                    return;
                }
                total += line.Length + 1;
                target.AppendLine(line);
            }
        }

        using var process = new Process { StartInfo = info, EnableRaisingEvents = true };
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
            await ReplyAsync(pipe, request.Id, -1, "", $"Could not start {info.FileName}: {ex.Message}", ct)
                .ConfigureAwait(false);
            Cleanup(scriptPath);
            return;
        }

        lock (_running) _running.Add(process);

        var timedOut = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ExecTimeout);

        var streamer = StreamPartialsAsync(pipe, request.Id, stdout, stderr, gate, timeout.Token);

        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            timedOut = !ct.IsCancellationRequested;
            Kill(process);
        }

        // Let the async readers drain what the process wrote before it died.
        try { process.WaitForExit(2000); } catch (Exception) { }
        await streamer.ConfigureAwait(false);

        lock (_running) _running.Remove(process);

        string outText, errText;
        lock (gate)
        {
            // Whatever the last flush did not take. The console appends partials
            // and then the final chunk, so sending the whole buffer again here
            // would print every line twice.
            outText = stdout.ToString();
            errText = stderr.ToString();
            stdout.Clear();
            stderr.Clear();
        }

        if (truncated) errText += $"\n[output truncated at {MaxOutputChars / 1024} KB]\n";
        if (timedOut) errText += $"\n[killed: exceeded the {ExecTimeout.TotalSeconds:F0}s timeout]\n";

        var exitCode = timedOut ? -1 : SafeExitCode(process);
        await ReplyAsync(pipe, request.Id, exitCode, outText, errText, ct).ConfigureAwait(false);
        Cleanup(scriptPath);
    }

    /// <summary>
    /// The reply is the finished <c>host.execResult</c>, so the applet forwards it
    /// to the relay without re-parsing it.
    /// </summary>
    private async Task ReplyAsync(
        Stream pipe, string id, int exitCode, string stdout, string stderr, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(
            new HostExecResult { Id = id, ExitCode = exitCode, Stdout = stdout, Stderr = stderr },
            Protocol.Json);

        try
        {
            await WriteAsync(
                pipe, PipeChannel.TextFrame(PipeChannel.TagExecResult, json), ct).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The session ended while the script ran. Nothing to report it to.
        }
    }

    /// <summary>
    /// Flush whatever the script has produced every 250 ms, exactly as the
    /// unelevated runner does (PLAN 6.1). `partial: true` tells the console to
    /// append rather than to treat it as the result.
    /// </summary>
    private async Task StreamPartialsAsync(
        Stream pipe, string id, StringBuilder stdout, StringBuilder stderr,
        object gate, CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(FlushInterval);
            while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
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

                var json = JsonSerializer.Serialize(
                    new HostExecResult
                    {
                        Id = id,
                        ExitCode = -1,
                        Stdout = chunkOut,
                        Stderr = chunkErr,
                        Partial = true,
                    },
                    Protocol.Json);

                await WriteAsync(pipe, PipeChannel.TextFrame(PipeChannel.TagExecResult, json), ct)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception)
        {
            // The pipe went away mid-script; the final result will fail the same
            // way and the session is over regardless.
        }
    }

    /// <summary>Serialised write — see <see cref="_writeLock"/>.</summary>
    private async Task WriteAsync(Stream pipe, byte[] frame, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await PipeChannel.WriteFrameAsync(pipe, frame, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>
    /// Session end: nothing the agent started may outlive the consent that
    /// authorised it, and a SYSTEM process least of all.
    /// </summary>
    private void KillAll()
    {
        Process[] survivors;
        lock (_running) survivors = _running.ToArray();
        foreach (var process in survivors) Kill(process);
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
        }
    }

    private static int SafeExitCode(Process process)
    {
        try { return process.ExitCode; }
        catch (Exception) { return -1; }
    }

    private static void Cleanup(string path)
    {
        try { File.Delete(path); } catch (Exception) { }
    }

    /// <summary>
    /// Same rule as <c>ScriptStaging.SafeFileName</c>, kept here rather than
    /// shared because this project deliberately links no applet source beyond the
    /// desktop interop: everything outside <c>[A-Za-z0-9_-]</c> becomes an
    /// underscore, so a rooted or dot-dot id cannot choose the path.
    /// </summary>
    private static string SafeName(string id)
    {
        if (string.IsNullOrEmpty(id)) return "job";

        var chars = new char[Math.Min(id.Length, 64)];
        for (var i = 0; i < chars.Length; i++)
        {
            var c = id[i];
            chars[i] = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '-'
                ? c
                : '_';
        }

        return new string(chars);
    }
}
