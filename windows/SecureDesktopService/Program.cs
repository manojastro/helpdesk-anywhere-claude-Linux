using System.Diagnostics;
using System.Runtime.InteropServices;

using HelpdeskAnywhere.SecureDesktopService.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// LocalSystem service in session 0 (PLAN 5.3).
///
/// Two jobs, and the second is a safety property rather than a feature:
///
///  1. Keep one <c>DesktopHelper</c> running on whichever desktop is currently
///     receiving input, launched as SYSTEM but inside the user's session. That is
///     the only way to reach the Winlogon desktop where UAC renders.
///
///  2. Watch for the applet's named pipe disappearing, and when it stays gone,
///     **stop and delete itself** (PLAN 5.7). CLAUDE.md constraint #4 says
///     nothing survives the session and nothing survives a reboot; the applet
///     removing the service covers the ordinary exit, and this covers the applet
///     being killed, crashing, or losing power to its own teardown. A SYSTEM
///     service that outlives the session it was installed for is precisely the
///     "hidden install with persistence" this project must never ship.
/// </summary>
internal static class Program
{
    /// <summary>PLAN 5.7: self-uninstall if the applet's pipe stays gone this long.</summary>
    private static readonly TimeSpan WatchdogTimeout = TimeSpan.FromSeconds(60);

    private static readonly TimeSpan WatchdogPoll = TimeSpan.FromSeconds(1);

    /// <summary>
    /// A hard ceiling on the whole install, whatever the pipe check says.
    ///
    /// The pipe check is the precise signal, but it can only ever answer "present"
    /// or "cannot tell" if the object namespace is unreadable, and "cannot tell"
    /// is treated as present so a transient failure never kills a live session.
    /// That leaves one hole — a check that is permanently broken — and constraint
    /// #4 does not allow a hole. No attended support session runs for twelve
    /// hours; anything still installed after that is a leak, and it removes
    /// itself.
    /// </summary>
    private static readonly TimeSpan MaxServiceLifetime = TimeSpan.FromHours(12);

    private static readonly CancellationTokenSource Stopping = new();

    private static IntPtr _statusHandle;
    private static ServiceHost.SERVICE_STATUS _status;
    private static string _pipeName = "";

    /// <summary>Held in a field: a delegate passed to Win32 must outlive the call.</summary>
    private static ServiceHost.HandlerEx? _handler;
    private static ServiceHost.ServiceMainProc? _serviceMain;

    /// <summary>
    /// Entry point for the <c>--run-service</c> mode of the single shipped binary
    /// (DECISIONS.md D-009), and for this project's own standalone .exe.
    /// </summary>
    internal static int Run(string[] args)
    {
        _pipeName = ValueOf(args, "--pipe") ?? "";

        // Running it by hand is useful when diagnosing on the test machine, and
        // is exactly what the SCM does not do — so it must not be the only path
        // that works.
        if (args.Contains("--console"))
        {
            RunSession(Stopping.Token);
            return 0;
        }

        _serviceMain = ServiceMain;
        var table = new[]
        {
            new ServiceHost.SERVICE_TABLE_ENTRY
            {
                lpServiceName = Marshal.StringToHGlobalUni(ServiceName),
                lpServiceProc = Marshal.GetFunctionPointerForDelegate(_serviceMain),
            },
            default,
        };

        return ServiceHost.StartServiceCtrlDispatcher(table) ? 0 : Marshal.GetLastWin32Error();
    }

    internal const string ServiceName = "HelpdeskAnywhereSvc";

    /* ------------------------------------------------------------- service plumbing */

    private static void ServiceMain(int argc, IntPtr argv)
    {
        _handler = HandleControl;
        _statusHandle = ServiceHost.RegisterServiceCtrlHandlerEx(ServiceName, _handler, IntPtr.Zero);
        if (_statusHandle == IntPtr.Zero) return;

        _status = new ServiceHost.SERVICE_STATUS
        {
            dwServiceType = ServiceHost.SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState = ServiceHost.SERVICE_START_PENDING,
            dwControlsAccepted = 0,
            dwWaitHint = 5000,
        };
        Report(ServiceHost.SERVICE_START_PENDING);

        Report(ServiceHost.SERVICE_RUNNING,
            ServiceHost.SERVICE_ACCEPT_STOP | ServiceHost.SERVICE_ACCEPT_SHUTDOWN);

        try
        {
            RunSession(Stopping.Token);
        }
        finally
        {
            // Report STOPPED before returning, or the SCM waits out its timeout
            // and then kills the process — leaving the registration behind.
            Report(ServiceHost.SERVICE_STOPPED);
        }
    }

    private static int HandleControl(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case ServiceHost.SERVICE_CONTROL_STOP:
            case ServiceHost.SERVICE_CONTROL_SHUTDOWN:
                Report(ServiceHost.SERVICE_STOP_PENDING);
                Stopping.Cancel();
                break;

            case ServiceHost.SERVICE_CONTROL_INTERROGATE:
                Report(_status.dwCurrentState, _status.dwControlsAccepted);
                break;
        }

        return 0;
    }

    private static void Report(uint state, uint accepted = 0)
    {
        _status.dwCurrentState = state;
        _status.dwControlsAccepted = accepted;
        _status.dwWaitHint = state == ServiceHost.SERVICE_STOP_PENDING ? 15000u : 0u;
        ServiceHost.SetServiceStatus(_statusHandle, ref _status);
    }

    /* ---------------------------------------------------------------- the actual work */

    private static void RunSession(CancellationToken ct)
    {
        DiagLog.Start("service", DiagPaths.Elevated);
        DiagLog.Write("service.start", "service main running",
            $"pipe={(_pipeName.Length == 0 ? "(none)" : _pipeName)}");

        if (_pipeName.Length == 0)
        {
            DiagLog.Write("service.start", "no --pipe argument; nothing to do");
            return;
        }

        // The helper is this same binary in another mode (DECISIONS.md D-009),
        // so the path is simply our own — already staged in %ProgramData% by the
        // installer, where a standard user cannot replace it.
        var helperPath = Environment.ProcessPath ?? "";

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var watchdog = Task.Run(() => Watchdog(linked), linked.Token);

        // The link is what carries `asSystem` scripts (PLAN 6.1): this is the one
        // process that is both SYSTEM and alive for the whole session. It is also
        // how the applet says the session is over, which is the fast path to the
        // self-uninstall the watchdog otherwise reaches on its own.
        var link = new ServiceLink(_pipeName, SessionOver).RunAsync(linked.Token);

        new DesktopWatcher(_pipeName, helperPath).Run(linked.Token);

        linked.Cancel();
        try { Task.WaitAll([watchdog, link], TimeSpan.FromSeconds(5)); } catch (Exception) { }

        DiagLog.Write("service.stop", "service session ended", $"selfUninstall={_selfUninstall}");
        if (_selfUninstall) SelfUninstall();
    }

    private static bool _selfUninstall;

    /// <summary>
    /// The applet asked for teardown. Same destination as the watchdog's, without
    /// the minute of waiting: stop, delete the registration, remove the files.
    /// </summary>
    private static void SessionOver()
    {
        _selfUninstall = true;
        try { Stopping.Cancel(); } catch (ObjectDisposedException) { }
    }

    /// <summary>
    /// PLAN 5.7. The applet's pipe is the session's heartbeat: it exists for
    /// exactly as long as the applet does. Sixty seconds of absence means the
    /// applet is gone and is not coming back — a helper reconnecting between
    /// desktops takes milliseconds, not a minute.
    /// </summary>
    private static void Watchdog(CancellationTokenSource stop)
    {
        var goneSince = (DateTime?)null;
        var startedAt = DateTime.UtcNow;

        while (!stop.IsCancellationRequested)
        {
            if (DateTime.UtcNow - startedAt >= MaxServiceLifetime)
            {
                _selfUninstall = true;
                stop.Cancel();
                return;
            }

            var present = SafeExists(_pipeName);

            if (present)
            {
                goneSince = null;
            }
            else
            {
                goneSince ??= DateTime.UtcNow;
                if (DateTime.UtcNow - goneSince.Value >= WatchdogTimeout)
                {
                    DiagLog.Write("service.watchdog", "applet pipe gone past the timeout — self-uninstalling",
                        $"timeout={WatchdogTimeout.TotalSeconds}s");
                    _selfUninstall = true;
                    stop.Cancel();
                    return;
                }
            }

            if (stop.Token.WaitHandle.WaitOne(WatchdogPoll)) return;
        }
    }

    /// <summary>
    /// "Cannot tell" is deliberately reported as present: killing a live session
    /// because the object namespace hiccuped would be worse than waiting. The
    /// lifetime ceiling in <see cref="Watchdog"/> is what covers the case where it
    /// never recovers.
    /// </summary>
    private static bool SafeExists(string pipeName)
    {
        try { return PipeChannel.Exists(pipeName); }
        catch (Exception) { return true; }
    }

    /// <summary>
    /// Delete the service registration and the staged files (PLAN 5.7).
    ///
    /// The files cannot be deleted from inside this process — the .exe running
    /// them is one of them — so a detached shell does it a moment after this
    /// process exits. Deliberately not <c>MOVEFILE_DELAY_UNTIL_REBOOT</c>: that
    /// would leave a SYSTEM service binary sitting in %ProgramData% for however
    /// long the machine stays up, which is exactly the persistence constraint #4
    /// forbids.
    /// </summary>
    private static void SelfUninstall()
    {
        var dir = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "";

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c sc delete {ServiceName} >nul 2>&1 & " +
                            $"ping 127.0.0.1 -n 4 >nul & rmdir /s /q \"{dir}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
            });
        }
        catch (Exception)
        {
            // Nothing left to try from in here; the applet's own teardown and the
            // next session's install both handle a leftover registration.
        }
    }

    private static string? ValueOf(string[] args, string flag)
    {
        var i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
