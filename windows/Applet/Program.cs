using System.Windows.Forms;

namespace HelpdeskAnywhere.Applet;

/// <summary>
/// End-user applet: one-shot process, no install, no persistence
/// (CLAUDE.md constraint #4).
///
/// Phase 0 scaffold: entry point, argument parsing and the Teardown hook shape.
/// The code-entry form, consent dialog, session indicator (Phase 2.2), transport
/// (2.3), capture (Phase 3), input injection (Phase 4), elevation (Phase 5) and
/// scripting (Phase 6) land in their phases.
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

        // Phase 5.2d: the elevated relaunch re-enters here to install the service.
        if (args.Contains("--install-service"))
        {
            MessageBox.Show(
                "Service installer is not implemented until Phase 5.2d.",
                "Helpdesk Anywhere");
            return 1;
        }

        MessageBox.Show(
            "Helpdesk Anywhere applet — Phase 0 scaffold.\n\n" +
            "The code-entry form, consent dialog and session indicator land in Phase 2.",
            "Helpdesk Anywhere");

        return 0;
    }

    private static int _tornDown;

    /// <summary>
    /// Idempotent cleanup (PLAN 2.4): stop capture, uninstall the elevated service,
    /// close sockets, remove temp files. Safe to call from any thread, any number
    /// of times.
    /// </summary>
    internal static void Teardown()
    {
        if (Interlocked.Exchange(ref _tornDown, 1) != 0) return;

        // Phase 2.4 / 5.7: stop capture, ControlService(STOP) + DeleteService,
        // kill helpers, delete %ProgramData%\HelpdeskAnywhere\, close the socket.
    }
}
