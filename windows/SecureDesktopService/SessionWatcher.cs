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

    private readonly string _pipeName;
    private readonly string _helperPath;

    private string _current = "";
    private Process? _helper;
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
                        StartHelper(desktop);
                    }
                    else if (_helper is { HasExited: true })
                    {
                        DiagLog.Write("watcher.helper", "helper exited, restarting",
                            $"desktop={_current} exitCode={SafeExitCode(_helper)}");
                        _helper.Dispose();
                        _helper = null;
                        StartHelper(_current);
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

    private void StartHelper(string desktop)
    {
        // Denied is the "there is an input desktop I may not open" sentinel. It is
        // not a desktop name and must never reach OpenDesktop. SYSTEM should never
        // see it; if it does, the process is not running as SYSTEM.
        if (desktop.Length == 0 || desktop == Desktops.Denied)
        {
            DiagLog.Write("watcher.launch", "refusing to launch: not a real desktop name",
                $"desktop={desktop}");
            return;
        }

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

        SessionLaunch.CloseHandle(info.hThread);
        SessionLaunch.CloseHandle(info.hProcess);

        SessionLaunch.ProcessIdToSessionId((uint)info.dwProcessId, out var helperSession);
        DiagLog.Write("watcher.launch", "helper started",
            $"pid={info.dwProcessId} session={helperSession} desktop={desktop} " +
            $"(watcher session={CurrentSessionId()})");

        try { _helper = Process.GetProcessById(info.dwProcessId); }
        catch (ArgumentException) { _helper = null; }   // already gone
    }

    private void StopHelper()
    {
        var helper = _helper;
        _helper = null;
        if (helper is null) return;

        try
        {
            if (!helper.HasExited)
            {
                DiagLog.Write("watcher.helper", "stopping helper", $"pid={helper.Id}");
                helper.Kill(entireProcessTree: true);
            }

            helper.WaitForExit(3000);
        }
        catch (Exception)
        {
        }
        finally
        {
            helper.Dispose();
        }
    }

    private static string CurrentSessionId()
    {
        try { return Process.GetCurrentProcess().SessionId.ToString(); }
        catch (Exception) { return "?"; }
    }

    private static string SafeExitCode(Process process)
    {
        try { return process.ExitCode.ToString(); }
        catch (Exception) { return "?"; }
    }

    private static string? ValueOf(string[] args, string flag)
    {
        var i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
