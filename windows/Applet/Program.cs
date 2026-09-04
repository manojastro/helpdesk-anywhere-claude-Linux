using System.Windows.Forms;

namespace HelpdeskAnywhere.Applet;

/// <summary>
/// End-user applet: one-shot process, no install, no persistence
/// (CLAUDE.md constraint #4).
///
/// Phase 2 implements the whole visible flow — code entry, consent, session
/// indicator and transport. Capture (Phase 3), input injection (Phase 4),
/// elevation (Phase 5) and scripting (Phase 6) land in their phases.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // The elevated modes are dispatched BEFORE any WinForms setup: neither
        // shows a window, and the service runs in session 0 where there is no
        // desktop to configure DPI or visual styles for (DECISIONS.md D-009).
        //
        // One binary, three entry points. What gets installed in %ProgramData% is
        // a copy of this same .exe; --run-service is the LocalSystem service and
        // --desktop-helper is the per-desktop capturer it launches.
        if (args.Contains("--run-service"))
        {
            return SecureDesktopService.Program.Run(args);
        }

        if (args.Contains("--desktop-helper"))
        {
            return DesktopHelper.Program.Run(args);
        }

        ApplicationConfiguration.Initialize();

        // PLAN 2.4: one idempotent Teardown() reachable from every exit path.
        // A crash must never leave a SYSTEM service behind.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Teardown();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => Teardown();
        Application.ThreadException += (_, _) => Teardown();
        Console.CancelKeyPress += (_, _) => Teardown();
        Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => Teardown();

        // PLAN 5.2d: both elevation modes relaunch this same .exe elevated, and it
        // re-enters here to stage the payload and register the service. This path
        // never shows the applet UI and never opens a socket — it installs, and
        // exits with a code the unelevated parent can map to a message.
        if (args.Contains("--install-service"))
        {
            return RunInstaller(ArgValue(args, "--pipe"));
        }

        // PLAN 5.7. The service normally removes itself the moment the applet's
        // pipe goes away, so this is the belt to that braces: an operator, or a
        // teardown that still has admin rights, can force the cleanup.
        if (args.Contains("--uninstall-service"))
        {
            return Elevation.ServiceControl.Uninstall() ? 0 : 1;
        }

        var server = ArgValue(args, "--server") ?? AppletConfig.DefaultServerUrl;
        var code = ArgValue(args, "--code");

        Application.Run(new AppletContext(server, code));

        Teardown();
        return 0;
    }

    /// <summary>
    /// The elevated half of the bootstrap (PLAN 5.2d): stage the payload into
    /// <c>%ProgramData%</c>, create the LocalSystem service, start it, exit.
    ///
    /// Silent by design. It runs behind a UAC prompt the user has already
    /// answered, or with no prompt at all in credential mode — a message box here
    /// would appear on the end user's screen with no context, and in credential
    /// mode would contradict the whole point of PLAN 5.2b ("no prompt appears on
    /// the user's screen at all"). The parent reports the outcome to the agent.
    /// </summary>
    private static int RunInstaller(string? pipeName)
    {
        if (string.IsNullOrWhiteSpace(pipeName)) return 87;  // ERROR_INVALID_PARAMETER

        try
        {
            Elevation.ElevationPayload.Extract();
            Elevation.ServiceControl.InstallAndStart(pipeName);
            return 0;
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            // The Win32 code travels back as the exit code, so the parent can map
            // it with ElevationErrors rather than inventing its own message.
            return ex.NativeErrorCode;
        }
        catch (Exception)
        {
            return 1;
        }
    }

    /// <summary>
    /// <c>--server &lt;url&gt;</c> / <c>--code &lt;123456&gt;</c>. Development
    /// conveniences only: the end user is never asked to type a command line, and
    /// neither switch skips the consent dialog.
    /// </summary>
    private static string? ArgValue(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static SessionClient? _active;
    private static Capture.ScreenStreamer? _streamer;
    private static Input.InputInjector? _injector;
    private static Scripting.ScriptRunner? _scripts;
    private static int _tornDown;

    /// <summary>
    /// The live socket, so <see cref="Teardown"/> can drop it from a process-exit
    /// or crash path where there is no time to await a polite close.
    /// </summary>
    internal static void TrackClient(SessionClient? client) =>
        Interlocked.Exchange(ref _active, client);

    /// <summary>
    /// The live capture loop, so <see cref="Teardown"/> can stop it from a crash or
    /// process-exit path. A frame must never outlive the session that consented to
    /// it (CLAUDE.md constraint #2).
    /// </summary>
    internal static void TrackStreamer(Capture.ScreenStreamer? streamer) =>
        Interlocked.Exchange(ref _streamer, streamer);

    /// <summary>
    /// The live input injector, so <see cref="Teardown"/> can release held keys and
    /// buttons even on a crash path. A stuck Ctrl on the user's machine after the
    /// helper has vanished is a nasty, invisible failure mode (PLAN 4.2).
    /// </summary>
    internal static void TrackInjector(Input.InputInjector? injector) =>
        Interlocked.Exchange(ref _injector, injector);

    /// <summary>
    /// The live script runner, so <see cref="Teardown"/> can kill any process the
    /// agent started — whole tree — and remove the staging folder, even on a crash
    /// path (CLAUDE.md constraint #4: nothing survives the session).
    /// </summary>
    internal static void TrackScripts(Scripting.ScriptRunner? scripts) =>
        Interlocked.Exchange(ref _scripts, scripts);

    /// <summary>
    /// Idempotent cleanup (PLAN 2.4): stop capture, uninstall the elevated service,
    /// close sockets, remove temp files. Safe to call from any thread, any number
    /// of times.
    /// </summary>
    internal static void Teardown()
    {
        if (Interlocked.Exchange(ref _tornDown, 1) != 0) return;

        // Same order as AppletContext.Finish, and for the same reasons: stop
        // sending the user's screen first, then release whatever the agent was
        // holding down, then kill what the agent started.
        //
        // Each step is independently guarded. This runs on crash and process-exit
        // paths, where the state it touches may be half-torn-down already, and an
        // exception thrown by an earlier step must not stop a later one — the
        // last step removes a SYSTEM service (constraint #4), and it is the one
        // that must never be skipped.
        Attempt(() => Interlocked.Exchange(ref _streamer, null)?.Stop());
        Attempt(() => Interlocked.Exchange(ref _injector, null)?.ReleaseAll());
        Attempt(() => Interlocked.Exchange(ref _scripts, null)?.Dispose());
        Attempt(() => Interlocked.Exchange(ref _active, null)?.Abort());

        // PLAN 5.7. Two independent guarantees, because either one alone has a
        // hole: this call removes the service when the applet still has the
        // rights to (it was elevated), and the service's own watchdog removes it
        // when the applet was killed and never got here. Neither can leave a
        // SYSTEM service behind (CLAUDE.md constraint #4).
        Attempt(() => Interlocked.Exchange(ref _elevation, null)?.Shutdown());
    }

    /// <summary>
    /// Run one teardown step, swallowing whatever it throws. There is nowhere to
    /// report it to — this is the exit path — and the only thing that matters is
    /// that the remaining steps still run.
    /// </summary>
    internal static void Attempt(Action step)
    {
        try { step(); }
        catch (Exception) { }
    }

    private static Elevation.ElevationManager? _elevation;

    /// <summary>
    /// The live elevation manager, so <see cref="Teardown"/> can tell the service
    /// to uninstall itself even from a crash path.
    /// </summary>
    internal static void TrackElevation(Elevation.ElevationManager? elevation) =>
        Interlocked.Exchange(ref _elevation, elevation);
}
