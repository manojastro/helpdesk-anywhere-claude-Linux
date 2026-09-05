using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.SecureDesktopService.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// Keeps exactly one <see cref="SessionWatcher"/> alive inside the interactive
/// session (PLAN 5.3).
///
/// WHAT CHANGED, AND WHY — MT-06, first real Windows run, 2026-09-05.
///
/// This class used to do the watching itself: poll <c>OpenInputDesktop</c> and
/// launch a helper on whatever came back. It ran in the service, in session 0,
/// and it could not work there. <c>OpenInputDesktop</c> is scoped to the window
/// station of the calling process; window stations are per-session; a LocalSystem
/// service is on <c>Service-0x0-3e7$</c>, which has no input desktop. The
/// interactive session's switch to <c>Winlogon</c> was therefore invisible from
/// here, no helper ever reached the Secure Desktop, the applet was never told to
/// stop capturing, and the technician saw a black canvas — a <c>BitBlt</c> of a
/// desktop that no longer owns the display succeeds and returns black.
///
/// So this class kept the one job session 0 is actually good for — crossing the
/// session boundary — and gave the watching to a process on the other side of it.
/// The token dance below now runs once per session (and again only if the watcher
/// dies or the user switches sessions) instead of on every UAC prompt.
///
/// It stays in session 0 because only session 0 can do this: moving a SYSTEM token
/// into another session needs <c>SE_TCB_NAME</c>, which is what a LocalSystem
/// service has and nothing else does.
/// </summary>
internal sealed class DesktopWatcher
{
    /// <summary>
    /// How often the supervisor checks that its watcher is still there. Slower
    /// than the desktop poll on purpose: this is a liveness check on a process
    /// that should live for the whole session, not a hot path.
    /// </summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    private readonly string _pipeName;
    private readonly string _helperPath;

    private Process? _watcher;
    private uint _watchedSession = 0xFFFFFFFF;
    private int _launchFailures;

    public DesktopWatcher(string pipeName, string helperPath)
    {
        _pipeName = pipeName;
        _helperPath = helperPath;
    }

    public void Run(CancellationToken ct)
    {
        DiagLog.Write("service.watch", "supervisor started",
            $"session={CurrentSessionId()} (expected 0) helperPath={_helperPath}");

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var sessionId = SessionLaunch.WTSGetActiveConsoleSessionId();

                if (sessionId == 0xFFFFFFFF)
                {
                    // Nobody is logged on at the console — the sign-in screen, or
                    // a session that has just been disconnected. Not an error.
                    if (_watcher is not null)
                    {
                        DiagLog.Write("service.watch", "no console session, stopping watcher");
                        StopWatcher();
                        _watchedSession = 0xFFFFFFFF;
                    }
                }
                else if (_watcher is null || _watcher.HasExited || sessionId != _watchedSession)
                {
                    if (_watcher is not null)
                    {
                        DiagLog.Write("service.watch", "watcher needs replacing",
                            $"exited={SafeExited(_watcher)} watchedSession={_watchedSession} activeSession={sessionId}");
                        StopWatcher();
                    }

                    _watchedSession = sessionId;
                    StartWatcher(sessionId);
                }
            }
            catch (Exception ex)
            {
                DiagLog.Write("service.watch", "supervisor threw", ex.GetType().Name);
            }

            if (ct.WaitHandle.WaitOne(PollInterval)) break;
        }

        StopWatcher();
        DiagLog.Write("service.watch", "supervisor stopped");
    }

    /* ---------------------------------------------------------------- the watcher */

    private void StartWatcher(uint sessionId)
    {
        var commandLine = new StringBuilder(
            $"\"{_helperPath}\" --desktop-watch --pipe {_pipeName}", 1024);

        DiagLog.Write("service.launch", "launching the session watcher",
            $"targetSession={sessionId} lpDesktop=WinSta0\\Default");

        int pid;
        try
        {
            pid = LaunchInSession(sessionId, "Default", commandLine);
        }
        catch (Win32Exception ex)
        {
            // Every step of PLAN 5.3's token dance names itself on the way out, so
            // one failed MT-06 run says which one and what Windows called it.
            DiagLog.Win32("service.launch", ex.Message, ex.NativeErrorCode,
                $"targetSession={sessionId}");

            // Back off rather than hammering the SCM and the log once a second.
            if (++_launchFailures >= 3) Thread.Sleep(5000);
            return;
        }

        _launchFailures = 0;

        SessionLaunch.ProcessIdToSessionId((uint)pid, out var actual);
        DiagLog.Write("service.launch", "session watcher started",
            $"pid={pid} landedInSession={actual} requestedSession={sessionId}" +
            (actual == sessionId ? "" : "  *** SESSION MISMATCH — the watcher is in the wrong session ***"));

        try { _watcher = Process.GetProcessById(pid); }
        catch (ArgumentException) { _watcher = null; }
    }

    private void StopWatcher()
    {
        var watcher = _watcher;
        _watcher = null;
        if (watcher is null) return;

        try
        {
            // entireProcessTree takes the helper the watcher started with it: a
            // helper left behind on the Winlogon desktop with nothing supervising
            // it is a SYSTEM process nobody is watching (constraint #4).
            if (!watcher.HasExited) watcher.Kill(entireProcessTree: true);
            watcher.WaitForExit(3000);
        }
        catch (Exception)
        {
        }
        finally
        {
            watcher.Dispose();
        }
    }

    /// <summary>
    /// PLAN 5.3's token dance, in order. Every step matters: skip the session-id
    /// set and <c>CreateProcessAsUser</c> returns 5, with nothing to say why.
    ///
    /// Runs once per session now rather than once per desktop switch — the
    /// per-switch launch is a plain <c>CreateProcess</c> from inside the session
    /// (<see cref="SessionWatcher"/>), which cannot fail either of these ways.
    /// </summary>
    private static int LaunchInSession(uint sessionId, string desktop, StringBuilder commandLine)
    {
        if (!SessionLaunch.OpenProcessToken(
                SessionLaunch.GetCurrentProcess(),
                SessionLaunch.TOKEN_DUPLICATE | SessionLaunch.TOKEN_QUERY,
                out var token))
        {
            throw Fail("OpenProcessToken");
        }

        var duplicate = IntPtr.Zero;
        var environment = IntPtr.Zero;

        try
        {
            var attributes = new SessionLaunch.SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SessionLaunch.SECURITY_ATTRIBUTES>(),
            };

            if (!SessionLaunch.DuplicateTokenEx(
                    token, SessionLaunch.MAXIMUM_ALLOWED, ref attributes,
                    SessionLaunch.SecurityImpersonation, SessionLaunch.TokenPrimary,
                    out duplicate))
            {
                throw Fail("DuplicateTokenEx");
            }

            // THE step: this is what moves a SYSTEM token out of session 0 and
            // into the interactive session, and it works only because the caller
            // is SYSTEM with SE_TCB_NAME.
            var target = sessionId;
            if (!SessionLaunch.SetTokenInformation(
                    duplicate, SessionLaunch.TokenSessionId, ref target, sizeof(uint)))
            {
                throw Fail("SetTokenInformation(TokenSessionId)");
            }

            SessionLaunch.CreateEnvironmentBlock(out environment, duplicate, false);

            var startupInfo = new SessionLaunch.STARTUPINFO
            {
                cb = Marshal.SizeOf<SessionLaunch.STARTUPINFO>(),
                // The window-station prefix is not optional (PLAN 5.3).
                lpDesktop = $@"WinSta0\{desktop}",
            };

            if (!SessionLaunch.CreateProcessAsUser(
                    duplicate, null, commandLine,
                    IntPtr.Zero, IntPtr.Zero, false,
                    SessionLaunch.CREATE_UNICODE_ENVIRONMENT | SessionLaunch.CREATE_NO_WINDOW,
                    environment, null, ref startupInfo, out var info))
            {
                throw Fail("CreateProcessAsUser");
            }

            SessionLaunch.CloseHandle(info.hThread);
            SessionLaunch.CloseHandle(info.hProcess);
            return info.dwProcessId;
        }
        finally
        {
            if (environment != IntPtr.Zero) SessionLaunch.DestroyEnvironmentBlock(environment);
            if (duplicate != IntPtr.Zero) SessionLaunch.CloseHandle(duplicate);
            SessionLaunch.CloseHandle(token);
        }
    }

    private static Win32Exception Fail(string call)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, call);
    }

    private static string CurrentSessionId()
    {
        try { return Process.GetCurrentProcess().SessionId.ToString(); }
        catch (Exception) { return "?"; }
    }

    private static string SafeExited(Process process)
    {
        try { return process.HasExited.ToString(); }
        catch (Exception) { return "?"; }
    }
}
