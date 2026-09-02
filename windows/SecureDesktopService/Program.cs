namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// LocalSystem service in session 0 (PLAN 5.3).
///
/// Watches for input-desktop changes and, on each change, launches a
/// <c>DesktopHelper</c> as SYSTEM but *inside the user's session*, attached to
/// the now-active desktop. That is the only way to reach the Winlogon / Secure
/// Desktop where UAC renders.
///
/// Phase 0 scaffold: entry point only. The desktop-watch loop, token duplication
/// with <c>SetTokenInformation(TokenSessionId)</c> and <c>CreateProcessAsUser</c>
/// land in Phase 5.3; the self-uninstall watchdog in Phase 5.7.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        // Phase 5.3: ServiceBase host; poll OpenInputDesktop(0, false, GENERIC_ALL)
        // + GetUserObjectInformation(UOI_NAME) every ~200ms, and start/stop a
        // DesktopHelper as the active desktop changes.
        //
        // Phase 5.7: watchdog — self-uninstall if the applet's pipe stays
        // disconnected for 60s, so killing the applet cannot strand a SYSTEM
        // service (CLAUDE.md constraint #4).
        Console.WriteLine(
            args.Length > 0
                ? $"SecureDesktopService scaffold (args: {string.Join(' ', args)})"
                : "SecureDesktopService scaffold — not implemented until Phase 5.3");
        return 0;
    }
}
