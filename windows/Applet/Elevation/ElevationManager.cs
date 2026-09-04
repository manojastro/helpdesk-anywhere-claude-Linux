using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Elevation;

/// <summary>
/// The one-time elevation bootstrap (PLAN 5.2), in both modes.
///
/// Mode A (<c>interactive</c>) relaunches this same .exe with <c>runas</c>, and
/// Windows shows its native consent prompt on the user's screen — which only the
/// user can answer, and only if they are a local administrator.
///
/// Mode B (<c>credential</c>) is the one that matters on a managed fleet: the
/// agent types admin credentials into their own console, and
/// <c>CreateProcessWithLogonW</c> starts the installer directly with **no prompt
/// on the user's screen at all**. Without it the tool deadlocks on any
/// locked-down machine, because the bootstrap prompt would itself be a credential
/// prompt on the Secure Desktop that the user cannot fill in and the agent cannot
/// yet see.
///
/// CREDENTIAL HANDLING (PLAN 5.2c) — the rules this class exists to enforce:
///  * The password arrives as a <c>char[]</c> and is zeroed in a <c>finally</c>,
///    on every path including the exception path. It is never converted to a
///    <c>string</c>: a .NET string cannot be overwritten and can outlive the call
///    in the heap, and in any crash dump taken meanwhile.
///  * It is never logged, never put in an exception message, and never retained
///    for a later re-elevation. A second attempt is typed again.
///  * The user is told, on their own always-visible indicator, that elevation is
///    happening (constraint #2 — they consented to being helped, not to silent
///    privilege escalation).
///  * The transport check and the per-session attempt limit live on the server,
///    where they cannot be skipped by a modified applet.
/// </summary>
internal sealed class ElevationManager
{
    private readonly Action<string> _notifyUser;
    private readonly Action<bool, string?> _report;

    /// <summary>Per-session pipe name; the service is told it on its command line.</summary>
    public string PipeName { get; } = $"HelpdeskAnywhere-{Guid.NewGuid():N}";

    /// <summary>True once the service has been installed and started.</summary>
    public bool Elevated { get; private set; }

    /// <summary>
    /// Called first on <see cref="Shutdown"/>: the applet asking the elevated
    /// processes to remove themselves over the pipe. Set by
    /// <c>AppletContext</c>, so the crash and process-exit paths in
    /// <c>Program.Teardown</c> get the same fast cleanup the ordinary path does.
    /// </summary>
    public Action? OnShutdownRequested { get; set; }

    /// <summary>
    /// One bootstrap at a time. The server caps attempts per session, but nothing
    /// there stops an agent clicking Elevate twice in a second, and two installers
    /// racing to create the same service is a needless way to fail.
    /// </summary>
    private int _inFlight;

    public ElevationManager(Action<string> notifyUser, Action<bool, string?> report)
    {
        _notifyUser = notifyUser;
        _report = report;
    }

    /// <summary>
    /// Handle one <c>agent.requestElevation</c>. Runs off the UI thread — the
    /// interactive mode blocks on a UAC prompt the user may take a while to
    /// answer, and constraint #3 says End Session must stay responsive throughout.
    /// </summary>
    public void Request(AgentRequestElevation request)
    {
        if (Elevated)
        {
            _report(true, null);
            return;
        }

        if (Interlocked.CompareExchange(ref _inFlight, 1, 0) != 0)
        {
            _report(false, "An elevation attempt is already in progress.");
            return;
        }

        // Constraint #2, and PLAN 5.2c rule 5: this is the moment the user must
        // be told, and it must happen before anything is attempted, not after it
        // has succeeded.
        _notifyUser("The agent is elevating privileges on this computer.");

        var mode = request.Mode;
        var password = request.PasswordChars();
        var username = request.Username ?? "";
        var domain = string.IsNullOrWhiteSpace(request.Domain) ? null : request.Domain;

        _ = Task.Run(() =>
        {
            try
            {
                if (mode == "credential") ElevateWithCredentials(domain, username, password);
                else ElevateInteractively();

                Elevated = true;
                _notifyUser("The agent now has administrator access on this computer.");
                _report(true, null);
            }
            catch (Win32Exception ex)
            {
                _report(false, ElevationErrors.Describe(ex.NativeErrorCode));
            }
            catch (Exception ex)
            {
                // Deliberately the exception TYPE, not its message: a message can
                // carry a path or an argument, and nothing from this call may be
                // assumed safe to show (PLAN 5.2c rule 2).
                _report(false, $"Elevation failed ({ex.GetType().Name}).");
            }
            finally
            {
                Zero(password);
                Volatile.Write(ref _inFlight, 0);
            }
        });
    }

    /* --------------------------------------------------------------- mode A */

    /// <summary>
    /// PLAN 5.2a. Relaunch elevated via the shell's <c>runas</c> verb; Windows
    /// shows its native consent prompt and the user clicks Yes, once per session.
    /// </summary>
    private void ElevateInteractively()
    {
        var info = new ProcessStartInfo
        {
            FileName = Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0],
            Arguments = $"--install-service --pipe {PipeName}",
            UseShellExecute = true,   // required for the runas verb
            Verb = "runas",
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        using var process = Process.Start(info)
            ?? throw new InvalidOperationException("the elevated installer did not start");

        // 1223 (ERROR_CANCELLED) surfaces as a Win32Exception from Process.Start
        // when the user clicks No; ElevationErrors turns it into a sentence the
        // agent can act on rather than a number.
        process.WaitForExit(InstallTimeoutMs);
        RequireInstalled(SafeExitCode(process));
    }

    /* --------------------------------------------------------------- mode B */

    /// <summary>
    /// PLAN 5.2b. No prompt appears on the user's screen: the credentials are
    /// supplied programmatically, which is the entire point — the agent never
    /// reveals the admin password to the end user, and the end user clicks
    /// nothing.
    /// </summary>
    private void ElevateWithCredentials(string? domain, string username, char[] password)
    {
        if (username.Length == 0)
            throw new Win32Exception(ElevationErrors.ErrorLogonFailure);

        var exe = Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0];
        var startupInfo = new AdvApi32.STARTUPINFO
        {
            cb = Marshal.SizeOf<AdvApi32.STARTUPINFO>(),
            // PLAN 5.2b: without the window-station prefix this fails with a
            // desktop error rather than anything that names the real problem.
            lpDesktop = @"WinSta0\Default",
        };

        // The password is copied into unmanaged memory, used once, and zeroed
        // there as well as in the caller's array. AllocHGlobal rather than
        // SecureStringToGlobalAllocUnicode because the source is already a char[]
        // and never a SecureString; the zeroing that allocator's matching free
        // would do is done explicitly below instead.
        var unmanaged = IntPtr.Zero;
        try
        {
            unmanaged = Marshal.AllocHGlobal((password.Length + 1) * sizeof(char));
            Marshal.Copy(password, 0, unmanaged, password.Length);
            Marshal.WriteInt16(unmanaged, password.Length * sizeof(char), 0);

            // CreateProcess-family calls may WRITE to lpCommandLine, and the
            // marshaller pins the managed string rather than copying it for a
            // Unicode signature — so this must be a mutable buffer, or the callee
            // can corrupt an interned .NET string.
            var commandLine = new StringBuilder($"\"{exe}\" --install-service --pipe {PipeName}", 1024);

            var ok = AdvApi32.CreateProcessWithLogonW(
                username,
                domain,
                unmanaged,
                AdvApi32.LOGON_WITH_PROFILE,
                exe,
                commandLine,
                AdvApi32.CREATE_UNICODE_ENVIRONMENT | AdvApi32.CREATE_NO_WINDOW,
                IntPtr.Zero,
                null,
                ref startupInfo,
                out var processInfo);

            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());

            // Wait on the handle CreateProcess just returned, not on a Process
            // looked up by pid: the installer is short-lived and often exits
            // before Process.GetProcessById could find it, which threw and was
            // reported to the agent as a failure even when the install worked.
            try
            {
                Kernel32.WaitForSingleObject(processInfo.hProcess, InstallTimeoutMs);
                Kernel32.GetExitCodeProcess(processInfo.hProcess, out var exitCode);
                RequireInstalled((int)exitCode);
            }
            finally
            {
                Kernel32.CloseHandle(processInfo.hThread);
                Kernel32.CloseHandle(processInfo.hProcess);
            }
        }
        finally
        {
            if (unmanaged != IntPtr.Zero)
            {
                // Zero before free: freed heap is not cleared, and this block held
                // a domain admin password (PLAN 5.2c rule 4).
                for (var i = 0; i <= password.Length; i++)
                    Marshal.WriteInt16(unmanaged, i * sizeof(char), 0);
                Marshal.FreeHGlobal(unmanaged);
            }
        }
    }

    /* ---------------------------------------------------------------- shared */

    private const int InstallTimeoutMs = 90_000;

    /// <summary>
    /// The installer's exit code is a hint; whether the service actually exists is
    /// the fact. A non-zero exit with the service present still means elevated.
    /// </summary>
    private static void RequireInstalled(int exitCode)
    {
        if (ServiceControl.IsInstalled()) return;

        throw exitCode > 0
            ? new Win32Exception(exitCode)
            : new InvalidOperationException("the elevated installer did not install the service");
    }

    private static int SafeExitCode(Process process)
    {
        try { return process.HasExited ? process.ExitCode : 0; }
        catch (Exception) { return 0; }
    }

    /// <summary>
    /// Session end (PLAN 5.7). Removes the service if this process still has the
    /// rights to; if it does not — the usual case, since only the short-lived
    /// installer child was elevated — the service's own watchdog notices the
    /// applet's pipe has gone and uninstalls itself within a minute.
    ///
    /// Never throws: it runs on teardown paths including crash paths.
    /// </summary>
    public void Shutdown()
    {
        if (!Elevated) return;
        Elevated = false;

        try { OnShutdownRequested?.Invoke(); }
        catch (Exception) { /* the watchdog is the backstop */ }

        try { ServiceControl.Uninstall(); }
        catch (Exception) { /* the watchdog is the backstop */ }
    }

    /// <summary>
    /// Overwrite the password buffer. <c>Array.Clear</c> is not elided here — the
    /// array is reachable from the caller's frame — but the explicit loop makes
    /// the intent unmistakable to the next reader, which matters more in this file
    /// than in any other.
    /// </summary>
    private static void Zero(char[] buffer)
    {
        for (var i = 0; i < buffer.Length; i++) buffer[i] = '\0';
    }
}
