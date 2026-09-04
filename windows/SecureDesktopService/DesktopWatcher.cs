using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.SecureDesktopService.Interop;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// Watches which desktop is receiving input, and keeps exactly one
/// <c>DesktopHelper</c> alive on it (PLAN 5.3).
///
/// Polls at 200ms rather than hooking <c>EVENT_SYSTEM_DESKTOPSWITCH</c>: an
/// event hook would need a hook procedure inside the interactive session, which
/// is a second cross-session problem to solve for a latency nobody can perceive
/// here. PLAN 5.3 says so explicitly — do not over-engineer this.
/// </summary>
internal sealed class DesktopWatcher
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(200);

    private readonly string _pipeName;
    private readonly string _helperPath;

    private string _current = "";
    private Process? _helper;

    public DesktopWatcher(string pipeName, string helperPath)
    {
        _pipeName = pipeName;
        _helperPath = helperPath;
    }

    public void Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var desktop = ActiveDesktopName();

                if (desktop.Length > 0 && !string.Equals(desktop, _current, StringComparison.OrdinalIgnoreCase))
                {
                    // Old helper first: two helpers capturing at once would
                    // interleave two desktops into one stream, and the second
                    // would be fighting the first for the pipe.
                    StopHelper();
                    _current = desktop;
                    StartHelper(desktop);
                }
                else if (_helper is { HasExited: true })
                {
                    // The helper died on its own — a desktop switch races the
                    // capture, and that is normal. Put one back.
                    _helper = null;
                    StartHelper(_current);
                }
            }
            catch (Exception)
            {
                // A transient failure to read the desktop happens exactly during
                // the switch this loop exists to notice. Never fatal.
            }

            if (ct.WaitHandle.WaitOne(PollInterval)) break;
        }

        StopHelper();
    }

    /// <summary>The desktop currently receiving input: Default, Winlogon, Screen-saver.</summary>
    private static string ActiveDesktopName()
    {
        var handle = Desktops.OpenInputDesktop(0, false, Desktops.GENERIC_ALL);
        if (handle == IntPtr.Zero) return "";

        try { return Desktops.NameOf(handle); }
        finally { Desktops.CloseDesktop(handle); }
    }

    /* ------------------------------------------------------------ helper process */

    private void StartHelper(string desktop)
    {
        if (desktop.Length == 0) return;

        var sessionId = SessionLaunch.WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF) return;   // no console session — nobody is logged on

        var commandLine = new StringBuilder(
            $"\"{_helperPath}\" --desktop-helper --desktop {desktop} --pipe {_pipeName}", 1024);
        var pid = LaunchInSession(sessionId, desktop, commandLine);
        if (pid == 0) return;

        try { _helper = Process.GetProcessById(pid); }
        catch (ArgumentException) { _helper = null; }  // already gone
    }

    private void StopHelper()
    {
        var helper = _helper;
        _helper = null;
        if (helper is null) return;

        try
        {
            if (!helper.HasExited) helper.Kill(entireProcessTree: true);
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

    /// <summary>
    /// PLAN 5.3's token dance, in order. Every step matters: skip the session-id
    /// set and <c>CreateProcessAsUser</c> returns 5, with nothing to say why.
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
        return new Win32Exception(code, $"{call} failed (Windows error {code}).");
    }
}
