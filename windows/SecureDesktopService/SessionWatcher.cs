using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.SecureDesktopService.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// Watches which desktop is receiving input, from INSIDE the interactive session,
/// and keeps exactly one <see cref="DesktopHelper"/> alive on it (PLAN 5.3).
///
/// WHY THIS PROCESS EXISTS — MT-06, first real Windows run, 2026-09-05.
///
/// This loop used to run in <c>DesktopWatcher</c>, inside the LocalSystem service,
/// in session 0. It could not work there and never had:
/// <c>OpenInputDesktop</c> resolves the input desktop of the window station
/// associated with the CALLING PROCESS, and window stations are per-session. A
/// session-0 service is on <c>Service-0x0-3e7$</c>, which has no input desktop at
/// all. So when Windows switched the interactive session to <c>Winlogon</c> to
/// draw a UAC prompt, the service saw nothing: either a failed call (and the
/// caller's <c>desktop.Length > 0</c> guard meant no helper was ever launched) or
/// its own window station's <c>Default</c> (and a helper pinned to
/// <c>WinSta0\Default</c> forever).
///
/// Either way no helper ever reached the Winlogon desktop, the applet was never
/// told to pause, and its own capture kept running against a desktop that no
/// longer owned the display — where <c>BitBlt</c> succeeds and returns BLACK.
/// That is the black technician canvas MT-06 recorded.
///
/// So the watch moved to where the answer exists. This process is launched once by
/// the service, as SYSTEM but inside the interactive session on
/// <c>WinSta0\Default</c>, and from there <c>OpenInputDesktop</c> answers the
/// question it was always being asked. A useful second consequence: it is already
/// SYSTEM in the right session, so starting a helper on <c>WinSta0\Winlogon</c> is
/// a plain <c>CreateProcess</c> with an <c>lpDesktop</c> — the token dance, and
/// both of its documented failure modes (PLAN 5.3), leave the path that has to
/// work every time a UAC prompt appears.
///
/// It also connects to the applet's pipe as <see cref="PipeChannel.RoleWatcher"/>,
/// for two reasons: to ship diagnostics into the applet's log, and to announce a
/// desktop transition the instant it is seen rather than when a helper finishes
/// starting. The applet needs that earlier signal to stop streaming black frames
/// during the gap.
/// </summary>
internal sealed class SessionWatcher
{
    /// <summary>
    /// PLAN 5.3 says poll, and says not to over-engineer it. 150ms: a UAC prompt
    /// is up for seconds, and the cost of being late is a few black-suppressed
    /// frames, not a wrong picture.
    /// </summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(150);

    /// <summary>
    /// A helper that dies faster than this is treated as a startup failure, not a
    /// desktop switch racing the capture (MT-06). Runtime start for the
    /// self-contained single-file exe is a few hundred ms, so a helper up for less
    /// than two seconds never did any useful work.
    /// </summary>
    private static readonly TimeSpan RapidFailureWindow = TimeSpan.FromSeconds(2);

    /// <summary>
    /// After this many rapid failures in a row on one desktop, stop relaunching
    /// and log HELPER_STARTUP_FAILED. Before MT-06 this loop could spawn hundreds
    /// of processes at ~300ms each; the ceiling is the fix for that regardless of
    /// why the helper dies.
    /// </summary>
    private const int MaxRapidFailures = 5;

    private readonly string _pipeName;
    private readonly string _helperPath;

    private string _current = "";

    /// <summary>The raw handle CreateProcess returned — kept, so the real exit code is readable.</summary>
    private IntPtr _helperHandle = IntPtr.Zero;
    private DateTime _helperStartedUtc;

    private int _rapidFailures;
    private bool _startupFailed;
    private DateTime _nextRetryUtc = DateTime.MinValue;

    private int _consecutiveFailures;

    public SessionWatcher(string pipeName, string helperPath)
    {
        _pipeName = pipeName;
        _helperPath = helperPath;
    }

    /// <summary>
    /// Entry point for the <c>--desktop-watch</c> mode of the single shipped
    /// binary (DECISIONS.md D-009).
    /// </summary>
    internal static int Run(string[] args)
    {
        var pipe = ValueOf(args, "--pipe");
        if (string.IsNullOrWhiteSpace(pipe)) return 87;   // ERROR_INVALID_PARAMETER

        DiagLog.Start("watcher", DiagPaths.Elevated);
        DiagLog.Write("watcher.start", "session watcher running",
            $"desktop={Desktops.ThreadDesktopName()} station=WinSta0(expected)");

        using var cts = new CancellationTokenSource();
        var watcher = new SessionWatcher(pipe, Environment.ProcessPath ?? "");

        // The pipe is best-effort: the watch loop is the job, and it must run even
        // if the applet's listener is momentarily absent.
        using var link = new WatcherLink(pipe);
        link.Start(cts.Token);

        Console.CancelKeyPress += (_, _) => cts.Cancel();
        watcher.Run(cts.Token, link);

        DiagLog.Write("watcher.stop", "session watcher exiting");
        return 0;
    }

    public void Run(CancellationToken ct, WatcherLink? link = null)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var desktop = Desktops.InputDesktopName(out var error);

                if (desktop.Length == 0)
                {
                    // Cannot tell. Log the first few — if this is every poll, the
                    // watcher is not where it thinks it is, and that is the single
                    // most important thing MT-06 can tell us.
                    if (_consecutiveFailures++ < 5)
                    {
                        DiagLog.Win32("watcher.detect", "OpenInputDesktop", error,
                            $"threadDesktop={Desktops.ThreadDesktopName()} " +
                            $"session={CurrentSessionId()} — if this repeats, this process is NOT on WinSta0");
                    }
                }
                else
                {
                    _consecutiveFailures = 0;

                    if (!string.Equals(desktop, _current, StringComparison.OrdinalIgnoreCase))
                    {
                        DiagLog.Write("watcher.detect", "input desktop changed",
                            $"{(_current.Length == 0 ? "(none)" : _current)} -> {desktop}");

                        // Tell the applet before starting anything: it stops
                        // streaming its own desktop the moment the switch is seen,
                        // rather than after a helper has finished launching. The
                        // gap between those two is where the black frames came from.
                        link?.AnnounceDesktop(desktop);

                        // Old helper first: two helpers capturing at once would
                        // interleave two desktops into one stream.
                        StopHelper();
                        _current = desktop;

                        // A new desktop is a fresh start: whatever kept failing on
                        // the last one is not this one's problem.
                        _rapidFailures = 0;
                        _startupFailed = false;
                        _nextRetryUtc = DateTime.MinValue;

                        MaintainHelper(desktop);
                    }
                    else
                    {
                        MaintainHelper(_current);
                    }
                }
            }
            catch (Exception ex)
            {
                DiagLog.Write("watcher.detect", "poll threw", ex.GetType().Name);
            }

            if (ct.WaitHandle.WaitOne(PollInterval)) break;
        }

        StopHelper();
    }

    /* ------------------------------------------------------------ helper process */

    /// <summary>
    /// Whether a desktop needs a helper at all. The applet captures its OWN
    /// Default desktop directly (Phase 3), so a helper there is a redundant second
    /// capturer and a wasted pipe instance — and it was the source of the crash
    /// loop MT-06 saw on Default, before any UAC prompt. The helper exists only
    /// for the desktops the applet cannot reach: Winlogon and the other secure
    /// desktops. <see cref="Desktops.Denied"/> is not a real name and never
    /// reaches OpenDesktop.
    /// </summary>
    private static bool NeedsHelper(string desktop) =>
        desktop.Length > 0
        && desktop != Desktops.Denied
        && !string.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Keep exactly one live helper on <paramref name="desktop"/> when one is
    /// wanted, with a real exit code on death and a bounded, backing-off restart.
    /// </summary>
    private void MaintainHelper(string desktop)
    {
        if (!NeedsHelper(desktop))
        {
            // The applet handles this desktop itself. Make sure no helper lingers.
            if (_helperHandle != IntPtr.Zero) StopHelper();
            return;
        }

        // Reap a dead helper and decide whether to keep trying.
        if (_helperHandle != IntPtr.Zero && HelperExited(out var code))
        {
            var lifetime = DateTime.UtcNow - _helperStartedUtc;
            SessionLaunch.CloseHandle(_helperHandle);
            _helperHandle = IntPtr.Zero;

            var rapid = lifetime < RapidFailureWindow;
            if (rapid) _rapidFailures++; else _rapidFailures = 0;

            DiagLog.Write("watcher.helper", "helper exited",
                $"desktop={desktop} exitCode={code} ({DiagLog.Describe((int)code)}) " +
                $"lifetimeMs={(long)lifetime.TotalMilliseconds} rapidFailures={_rapidFailures}");

            if (_rapidFailures >= MaxRapidFailures)
            {
                if (!_startupFailed)
                {
                    _startupFailed = true;
                    DiagLog.Write("watcher.helper", "HELPER_STARTUP_FAILED",
                        $"desktop={desktop} — {MaxRapidFailures} rapid failures; not relaunching " +
                        $"until the input desktop changes. Last exitCode={code} ({DiagLog.Describe((int)code)}).");
                }
            }
            else
            {
                // Back off before the next attempt: 250ms, 500, 750, 1000...
                _nextRetryUtc = DateTime.UtcNow.AddMilliseconds(250 * _rapidFailures);
            }
        }

        // Launch when there is no live helper, we have not given up, and the
        // backoff has elapsed.
        if (_helperHandle == IntPtr.Zero && !_startupFailed && DateTime.UtcNow >= _nextRetryUtc)
        {
            StartHelper(desktop);
        }
    }

    /// <summary>True (with the exit code) once the helper handle is signalled.</summary>
    private bool HelperExited(out uint code)
    {
        code = 0;
        if (_helperHandle == IntPtr.Zero) return true;
        if (SessionLaunch.WaitForSingleObject(_helperHandle, 0) != SessionLaunch.WAIT_OBJECT_0) return false;
        SessionLaunch.GetExitCodeProcess(_helperHandle, out code);
        return true;
    }

    private void StartHelper(string desktop)
    {
        var commandLine = new StringBuilder(
            $"\"{_helperPath}\" --desktop-helper --desktop {desktop} --pipe {_pipeName}", 1024);

        var startupInfo = new SessionLaunch.STARTUPINFO
        {
            cb = Marshal.SizeOf<SessionLaunch.STARTUPINFO>(),
            // The window-station prefix is not optional (PLAN 5.3). Without it
            // CreateProcess fails with a desktop error that names nothing.
            lpDesktop = $@"WinSta0\{desktop}",
        };

        DiagLog.Write("watcher.launch", "CreateProcess for helper",
            $"lpDesktop={startupInfo.lpDesktop} exe={_helperPath}");

        // No token dance: this process is already SYSTEM and already in the
        // interactive session, which is the whole reason it exists.
        if (!SessionLaunch.CreateProcess(
                null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                SessionLaunch.CREATE_UNICODE_ENVIRONMENT | SessionLaunch.CREATE_NO_WINDOW,
                IntPtr.Zero, null, ref startupInfo, out var info))
        {
            DiagLog.Win32("watcher.launch", "CreateProcess", Marshal.GetLastWin32Error(),
                $"lpDesktop={startupInfo.lpDesktop}");
            return;
        }

        // Keep the process handle — reading a real exit code off it later is the
        // whole point (the old code closed it and looked the process up by pid,
        // which is why every death logged exitCode=?). The thread handle is not
        // needed.
        SessionLaunch.CloseHandle(info.hThread);
        _helperHandle = info.hProcess;
        _helperStartedUtc = DateTime.UtcNow;

        SessionLaunch.ProcessIdToSessionId((uint)info.dwProcessId, out var helperSession);
        DiagLog.Write("watcher.launch", "helper started",
            $"pid={info.dwProcessId} session={helperSession} desktop={desktop} " +
            $"(watcher session={CurrentSessionId()})");
    }

    private void StopHelper()
    {
        var handle = _helperHandle;
        _helperHandle = IntPtr.Zero;
        if (handle == IntPtr.Zero) return;

        try
        {
            if (SessionLaunch.WaitForSingleObject(handle, 0) != SessionLaunch.WAIT_OBJECT_0)
            {
                DiagLog.Write("watcher.helper", "stopping helper");
                SessionLaunch.TerminateProcess(handle, 1);
                SessionLaunch.WaitForSingleObject(handle, 3000);
            }
        }
        catch (Exception)
        {
        }
        finally
        {
            SessionLaunch.CloseHandle(handle);
        }
    }

    private static string CurrentSessionId()
    {
        try { return Process.GetCurrentProcess().SessionId.ToString(); }
        catch (Exception) { return "?"; }
    }

    private static string? ValueOf(string[] args, string flag)
    {
        var i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
