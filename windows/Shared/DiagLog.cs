using System.Diagnostics;
using System.Text;

namespace HelpdeskAnywhere.Shared;

/// <summary>
/// The MT-06 diagnostic log (PLAN 5.3-5.6; added 2026-09-05 after the first real
/// Windows run of Phase 5 failed).
///
/// Phase 5 spans four processes across two Windows sessions, and every one of the
/// interesting failures is invisible from Linux and silent on Windows: a service
/// whose <c>OpenInputDesktop</c> returns nothing, a helper that launches into the
/// wrong session, a <c>SetThreadDesktop</c> that fails, a capture that succeeds
/// and returns black. The first MT-06 attempt produced a black technician canvas
/// and no other evidence at all. One test run has to be enough to say which stage
/// broke, so every stage says what it did and what Windows told it.
///
/// WHAT MAY NEVER GO IN HERE (CLAUDE.md constraint #6). No password, no
/// credential, no keystroke, no script text, no session code. State transitions,
/// process and session ids, desktop names, API names, Win32 error numbers, frame
/// counts. <see cref="Write"/> is the only entry point, and there is a source
/// invariant asserting no call site passes a credential.
///
/// Two sinks, because the interesting lines happen on both sides of a pipe that
/// may not be up yet:
///  * a file, always — under the staging directory for the elevated processes,
///    under %LOCALAPPDATA% for the applet, which runs as the user and cannot
///    write to the staging directory;
///  * a callback, for the elevated processes, which ship each line to the applet
///    over the pipe they already have so that one file ends up holding the whole
///    chronology. Lines produced before the pipe exists are buffered and flushed
///    on connect, which is exactly where the service's startup failures are.
/// </summary>
public static class DiagLog
{
    /// <summary>Stop a runaway loop from filling the disk. Bytes.</summary>
    private const long MaxFileBytes = 4 * 1024 * 1024;

    /// <summary>Bounded: a helper that never connects must not grow this forever.</summary>
    private const int MaxBufferedLines = 500;

    private static readonly object Gate = new();
    private static readonly List<string> Pending = [];
    private static readonly Stopwatch Since = Stopwatch.StartNew();

    private static string _category = "app";
    private static string? _path;
    private static Action<string>? _ship;
    private static long _written;
    private static bool _full;

    /// <summary>Where this process's own copy is being written, for the diagnostic script.</summary>
    public static string? FilePath => _path;

    /// <summary>
    /// Name this process and choose its file. <paramref name="category"/> is the
    /// short tag every line carries: applet, service, watcher, helper.
    /// </summary>
    public static void Start(string category, string directory)
    {
        lock (Gate)
        {
            _category = category;
            try
            {
                Directory.CreateDirectory(directory);
                _path = Path.Combine(
                    directory,
                    $"hda-{DateTime.Now:yyyyMMdd-HHmmss}-{category}-{Environment.ProcessId}.log");
                Prune(directory);
            }
            catch (Exception)
            {
                // A log that cannot be written must never stop a support session.
                _path = null;
            }
        }

        Write("diag", "log opened",
            $"pid={Environment.ProcessId} session={CurrentSessionId()} " +
            $"user={SafeUser()} exe={Environment.ProcessPath}");
    }

    /// <summary>
    /// Send every line to the applet as well, and flush what was buffered before
    /// the pipe existed. Called by the elevated processes once connected.
    /// </summary>
    public static void ShipTo(Action<string> sink)
    {
        string[] backlog;
        lock (Gate)
        {
            _ship = sink;
            backlog = [.. Pending];
            Pending.Clear();
        }

        foreach (var line in backlog)
        {
            try { sink(line); } catch (Exception) { return; }
        }
    }

    /// <summary>Stop shipping — the pipe has gone.</summary>
    public static void StopShipping()
    {
        lock (Gate) { _ship = null; }
    }

    /// <summary>
    /// One diagnostic line. <paramref name="stage"/> names the point in the chain
    /// (PLAN 5.3-5.6), <paramref name="what"/> what happened, <paramref name="detail"/>
    /// the numbers. Never throws, from any thread.
    /// </summary>
    public static void Write(string stage, string what, string detail = "")
    {
        var line = $"{DateTime.Now:HH:mm:ss.fff} +{Since.ElapsedMilliseconds,7}ms " +
                   $"[{_category,-7}] {stage,-18} {what}{(detail.Length > 0 ? "  " + detail : "")}";

        Action<string>? ship;
        lock (Gate)
        {
            ship = _ship;
            if (ship is null && Pending.Count < MaxBufferedLines) Pending.Add(line);
            AppendToFile(line);
        }

        if (ship is not null)
        {
            try { ship(line); } catch (Exception) { /* the file copy still has it */ }
        }
    }

    /// <summary>
    /// A Windows API that failed. Always logs the call, the raw error number and
    /// what Windows calls it — the numbers alone have cost this project a test
    /// cycle more than once.
    /// </summary>
    public static void Win32(string stage, string api, int error, string detail = "")
    {
        Write(stage, $"{api} FAILED",
            $"error={error} ({Describe(error)}){(detail.Length > 0 ? "  " + detail : "")}");
    }

    /// <summary>A line that arrived from another process over the pipe.</summary>
    public static void Relayed(string line)
    {
        lock (Gate) { AppendToFile(line); }
    }

    /* ------------------------------------------------------------------ plumbing */

    private static void AppendToFile(string line)
    {
        if (_path is null || _full) return;

        try
        {
            var bytes = Encoding.UTF8.GetBytes(line + Environment.NewLine);
            _written += bytes.Length;
            if (_written > MaxFileBytes)
            {
                _full = true;
                File.AppendAllText(_path, "--- diagnostic log size cap reached ---" + Environment.NewLine);
                return;
            }

            using var stream = new FileStream(
                _path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            stream.Write(bytes, 0, bytes.Length);
        }
        catch (Exception)
        {
            // Disk full, ACL, a racing reader. Diagnostics never break the session.
        }
    }

    /// <summary>Keep the directory from growing across many test runs.</summary>
    private static void Prune(string directory, int keep = 20)
    {
        try
        {
            var files = new DirectoryInfo(directory).GetFiles("hda-*.log");
            foreach (var old in files.OrderByDescending(f => f.LastWriteTimeUtc).Skip(keep))
            {
                try { old.Delete(); } catch (Exception) { }
            }
        }
        catch (Exception)
        {
        }
    }

    private static string SafeUser()
    {
        // The account name, which is not a credential and is the fastest way to
        // see that the helper came up as SYSTEM rather than as the user.
        try { return $"{Environment.UserDomainName}\\{Environment.UserName}"; }
        catch (Exception) { return "?"; }
    }

    private static string CurrentSessionId()
    {
        try { return Process.GetCurrentProcess().SessionId.ToString(); }
        catch (Exception) { return "?"; }
    }

    /// <summary>
    /// The handful of Win32 errors this chain actually produces, named. PLAN 5.3
    /// calls out 5 and the desktop errors specifically as the ones that mean
    /// something precise here.
    /// </summary>
    public static string Describe(int error) => error switch
    {
        0 => "ERROR_SUCCESS",
        1 => "ERROR_INVALID_FUNCTION — no input desktop on this window station",
        2 => "ERROR_FILE_NOT_FOUND",
        5 => "ERROR_ACCESS_DENIED — wrong token, session id never set, or a desktop this process may not open",
        6 => "ERROR_INVALID_HANDLE",
        87 => "ERROR_INVALID_PARAMETER",
        233 => "ERROR_PIPE_NOT_CONNECTED",
        1053 => "ERROR_SERVICE_REQUEST_TIMEOUT",
        1056 => "ERROR_SERVICE_ALREADY_RUNNING",
        1060 => "ERROR_SERVICE_DOES_NOT_EXIST",
        1062 => "ERROR_SERVICE_NOT_ACTIVE",
        1073 => "ERROR_SERVICE_EXISTS",
        1223 => "ERROR_CANCELLED — the user clicked No on the UAC prompt",
        1314 => "ERROR_PRIVILEGE_NOT_HELD — SE_TCB_NAME missing; not really SYSTEM",
        1326 => "ERROR_LOGON_FAILURE",
        1331 => "ERROR_ACCOUNT_DISABLED",
        2202 => "ERROR_BAD_USERNAME",
        _ => "see the Windows system error codes",
    };
}
