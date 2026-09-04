namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// Standalone entry point — see <c>DesktopHelper/Entry.cs</c> for why this file
/// exists and why the shipped applet does not compile it (DECISIONS.md D-009).
/// </summary>
internal static class Entry
{
    private static int Main(string[] args) => Program.Run(args);
}
