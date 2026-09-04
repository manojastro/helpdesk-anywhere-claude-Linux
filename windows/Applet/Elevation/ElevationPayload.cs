using System.Security.AccessControl;
using System.Security.Principal;

namespace HelpdeskAnywhere.Applet.Elevation;

/// <summary>
/// Stages the elevated executable on disk (PLAN 5.2d).
///
/// There is only one executable: the service and the desktop helper are modes of
/// this same binary, reached with <c>--run-service</c> and
/// <c>--desktop-helper</c> (DECISIONS.md D-009). So "staging the payload" is a
/// single file copy of the applet into <c>%ProgramData%\HelpdeskAnywhere\</c>,
/// which a standard user cannot write and an elevated process can — which is the
/// point of doing it from the elevated half of the bootstrap.
///
/// Everything written here is removed on teardown (CLAUDE.md constraint #4):
/// <see cref="ServiceControl.Uninstall"/> deletes the whole directory, and the
/// service self-uninstalls if the applet dies without getting the chance.
/// </summary>
internal static class ElevationPayload
{
    /// <summary>
    /// Copy this .exe to <see cref="ServiceControl.ServiceExePath"/>.
    ///
    /// Copied rather than run in place: the applet lives wherever the user's
    /// browser put it — usually <c>Downloads</c>, which they may empty, and which
    /// is writable by the user. A SYSTEM service must not have its binary sitting
    /// somewhere a standard user can replace it; that is a straightforward local
    /// privilege escalation.
    /// </summary>
    public static void Extract()
    {
        var self = Environment.ProcessPath
            ?? throw new InvalidOperationException("cannot locate the running executable");

        PrepareInstallDirectory();

        // Overwrite rather than skip: a leftover binary from an older session is a
        // version mismatch waiting to happen, and it is the SYSTEM service.
        File.Copy(self, ServiceControl.ServiceExePath, overwrite: true);
    }

    /// <summary>
    /// Create the staging directory with an explicit, non-inherited DACL:
    /// LocalSystem and the local Administrators group, and nobody else.
    ///
    /// SECURITY, and the reason this is not simply <c>Directory.CreateDirectory</c>:
    /// a fresh directory under <c>%ProgramData%</c> inherits that folder's ACEs,
    /// and <c>%ProgramData%</c> lets any authenticated user create subdirectories —
    /// with <c>CREATOR OWNER</c> inheriting full control to whoever made them. So
    /// an ordinary user can pre-create <c>%ProgramData%\HelpdeskAnywhere\</c>,
    /// own it, wait for a support session, and replace the binary that is about to
    /// be registered as a LocalSystem service. That is a local privilege
    /// escalation handed over by the tool itself.
    ///
    /// Two things close it: an existing directory is removed rather than reused —
    /// its contents and its owner cannot be trusted — and the replacement is
    /// created with a protected DACL that inheritance cannot widen. If the old
    /// directory cannot be removed, elevation fails here rather than installing a
    /// SYSTEM service out of a directory somebody else controls.
    /// </summary>
    private static void PrepareInstallDirectory()
    {
        var dir = ServiceControl.InstallDir;

        if (Directory.Exists(dir))
        {
            // Deliberately not caught: refusing to elevate is the safe outcome,
            // and ElevationErrors turns the failure into a message for the agent.
            Directory.Delete(dir, recursive: true);
        }

        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));

        foreach (var sid in new[]
                 {
                     new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                     new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                 })
        {
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        }

        // Created *with* the descriptor rather than created and then secured:
        // between those two steps the directory would briefly carry the inherited
        // permissions this method exists to avoid.
        var info = new DirectoryInfo(dir);
        info.Create(security);
    }
}
