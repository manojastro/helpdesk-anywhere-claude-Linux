namespace HelpdeskAnywhere.Applet.Elevation;

/// <summary>
/// Turns a Win32 error from the elevation bootstrap into something the agent can
/// act on (PLAN 5.2b: "map errors to clear console messages rather than raw
/// codes").
///
/// The distinction that matters is not cosmetic. "Wrong password" means try
/// again; "this account is not allowed to log on interactively" means stop
/// trying and use a different account — and a raw <c>1385</c> tells the agent
/// neither, so they retype the same credentials until the session's five
/// attempts are gone.
///
/// No message here ever contains the password: the inputs are an integer code
/// and, at most, a username. Dependency-free so it is unit-testable on Linux
/// (<c>tests/dotnet/ElevationErrorTests</c>).
/// </summary>
internal static class ElevationErrors
{
    // Win32 error codes, from winerror.h.
    public const int ErrorAccessDenied = 5;
    public const int ErrorLogonFailure = 1326;
    public const int ErrorPasswordMustChange = 1907;
    /// <summary>ERROR_ACCOUNT_RESTRICTION — includes "blank passwords not allowed".</summary>
    public const int ErrorAccountRestriction = 1327;
    public const int ErrorAccountDisabled = 1331;
    public const int ErrorLogonTypeNotGranted = 1385;
    public const int ErrorAccountLockedOut = 1909;
    public const int ErrorNoSuchDomain = 1355;
    public const int ErrorInvalidLogonHours = 1328;
    public const int ErrorInvalidWorkstation = 1329;
    public const int ErrorPasswordExpired = 1330;
    public const int ErrorCancelled = 1223;

    /// <summary>
    /// A message for the agent's console. Never contains a credential, and never
    /// a bare number without an explanation of what to do about it.
    /// </summary>
    public static string Describe(int code) => code switch
    {
        ErrorCancelled =>
            "The user declined the Windows prompt. Ask them to click Yes when it appears.",

        ErrorLogonFailure =>
            "Windows rejected that username or password. Check both, including the domain.",

        ErrorAccountRestriction =>
            "That account's password is blank, or its restrictions block this logon. " +
            "Windows does not allow a blank password here.",

        ErrorInvalidLogonHours =>
            "That account is not permitted to log on at this time of day.",

        ErrorInvalidWorkstation =>
            "That account is not permitted to log on to this computer.",

        ErrorPasswordExpired =>
            "That account's password has expired. Reset it, or use another admin account.",

        ErrorAccountDisabled =>
            "That account is disabled.",

        ErrorNoSuchDomain =>
            "That domain could not be reached from this computer. If the account is " +
            "local to the machine, leave the domain field empty.",

        ErrorLogonTypeNotGranted =>
            "That account is not allowed to log on interactively on this computer, so " +
            "it cannot be used to elevate. Use a different admin account.",

        ErrorPasswordMustChange =>
            "That account must change its password before it can be used.",

        ErrorAccountLockedOut =>
            "That account is locked out. Unlock it, or use another admin account.",

        ErrorAccessDenied =>
            "Windows refused the elevation. The account may not be an administrator " +
            "on this computer.",

        _ => $"Elevation failed (Windows error {code}).",
    };

    /// <summary>
    /// True when retyping the same credentials cannot possibly help, so the
    /// console can say so instead of inviting another of the session's five
    /// attempts (PLAN 5.2c rule 6).
    /// </summary>
    public static bool IsRetryPointless(int code) => code switch
    {
        ErrorAccountDisabled => true,
        ErrorLogonTypeNotGranted => true,
        ErrorAccountLockedOut => true,
        ErrorPasswordMustChange => true,
        ErrorNoSuchDomain => true,
        ErrorInvalidWorkstation => true,
        _ => false,
    };
}
