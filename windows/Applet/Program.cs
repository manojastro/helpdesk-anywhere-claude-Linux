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
        ApplicationConfiguration.Initialize();

        // PLAN 2.4: one idempotent Teardown() reachable from every exit path.
        // A crash must never leave a SYSTEM service behind.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Teardown();
        AppDomain.CurrentDomain.UnhandledException += (_, _) => Teardown();
        Application.ThreadException += (_, _) => Teardown();
        Console.CancelKeyPress += (_, _) => Teardown();
        Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => Teardown();

        // Phase 5.2d: the elevated relaunch re-enters here to install the service.
        if (args.Contains("--install-service"))
        {
            MessageBox.Show(
                "Service installer is not implemented until Phase 5.2d.",
                "Helpdesk Anywhere");
            return 1;
        }

        var server = ArgValue(args, "--server") ?? AppletConfig.DefaultServerUrl;
        var code = ArgValue(args, "--code");

        Application.Run(new AppletContext(server, code));

        Teardown();
        return 0;
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
    private static int _tornDown;

    /// <summary>
    /// The live socket, so <see cref="Teardown"/> can drop it from a process-exit
    /// or crash path where there is no time to await a polite close.
    /// </summary>
    internal static void TrackClient(SessionClient? client) =>
        Interlocked.Exchange(ref _active, client);

    /// <summary>
    /// Idempotent cleanup (PLAN 2.4): stop capture, uninstall the elevated service,
    /// close sockets, remove temp files. Safe to call from any thread, any number
    /// of times.
    /// </summary>
    internal static void Teardown()
    {
        if (Interlocked.Exchange(ref _tornDown, 1) != 0) return;

        Interlocked.Exchange(ref _active, null)?.Abort();

        // Phase 3/5.7: stop capture, ControlService(STOP) + DeleteService,
        // kill helpers, delete %ProgramData%\HelpdeskAnywhere\.
    }
}
