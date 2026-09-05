namespace HelpdeskAnywhere.Shared;

/// <summary>
/// Where each process writes its MT-06 diagnostic log.
///
/// Two directories, because the four processes do not share a writable one. The
/// staging directory is ACL'd to LocalSystem and Administrators (ElevationPayload
/// — deliberately, it holds the SYSTEM service binary), so the applet, which runs
/// as the end user, cannot write there. The applet's own directory is under
/// %LOCALAPPDATA%, which it always can.
///
/// The applet's copy is the one that matters: the elevated processes ship every
/// line to it over the pipe, so it holds the whole chronology, and it survives the
/// service's self-uninstall — which deletes the staging directory and everything
/// in it (CLAUDE.md constraint #4, and correctly so).
///
/// Text only. No executable is ever written here, nothing is registered to run,
/// and nothing here starts anything: a log file is not the persistence constraint
/// #4 forbids. scripts/mt06-diagnostics.ps1 reads both and can clear them.
/// </summary>
public static class DiagPaths
{
    /// <summary>The applet's log directory: user-writable, outlives the session.</summary>
    public static string Applet => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "HelpdeskAnywhere", "logs");

    /// <summary>
    /// The elevated processes' directory, inside the staging directory so it is
    /// removed with everything else on uninstall. Their lines reach the applet's
    /// file over the pipe; this copy is the backstop for the lines produced
    /// before the pipe is up, which is where the startup failures are.
    /// </summary>
    public static string Elevated => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "HelpdeskAnywhere", "logs");
}
