namespace HelpdeskAnywhere.DesktopHelper;

/// <summary>
/// Captures and injects input on one named desktop (PLAN 5.4).
///
/// Launched by <c>SecureDesktopService</c> as SYSTEM inside the user's session.
/// Args: <c>--desktop Winlogon --pipe &lt;name&gt;</c>.
///
/// CRITICAL ORDERING (PLAN 5.4): call <c>OpenDesktop</c> then
/// <c>SetThreadDesktop</c> BEFORE creating any window, DC or bitmap. The desktop
/// association is per-thread and fixed at handle-creation time, so this ordering
/// is not optional.
///
/// Phase 0 scaffold: argument parsing shape only.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        string desktop = ValueOf(args, "--desktop") ?? "Default";
        string? pipe = ValueOf(args, "--pipe");

        // Phase 5.4: SetThreadDesktop(OpenDesktop(desktop)) FIRST, then reuse
        // GdiCapture (Phase 3.1) and InputInjector (Phase 4.2), streaming frames
        // and accepting input over the named pipe back to the applet.
        Console.WriteLine(
            $"DesktopHelper scaffold — desktop={desktop} pipe={pipe ?? "(none)"} " +
            "— not implemented until Phase 5.4");
        return 0;
    }

    private static string? ValueOf(string[] args, string flag)
    {
        int i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
