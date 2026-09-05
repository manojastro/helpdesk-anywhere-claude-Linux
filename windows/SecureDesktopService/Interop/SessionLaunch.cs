using System.Runtime.InteropServices;
using System.Text;

namespace HelpdeskAnywhere.SecureDesktopService.Interop;

/// <summary>
/// Launching a process as SYSTEM but *inside the interactive session*, attached
/// to a named desktop (PLAN 5.3).
///
/// The service itself lives in session 0, where nothing the user can see exists.
/// Starting a process there and pointing it at <c>WinSta0\Winlogon</c> does not
/// work: the window station belongs to the interactive session. So the service
/// duplicates its own SYSTEM token, moves the copy into the console session with
/// <c>SetTokenInformation(TokenSessionId)</c> — which only succeeds because the
/// caller is SYSTEM and holds <c>SE_TCB_NAME</c> — and creates the process with
/// that token.
///
/// The two failures worth recognising (PLAN 5.3):
///   * <c>CreateProcessAsUser</c> → 5 (access denied): the wrong token was
///     duplicated, or the session id was never set.
///   * a desktop error: <c>lpDesktop</c> is missing its window-station prefix.
///     It must be <c>WinSta0\Winlogon</c>, never bare <c>Winlogon</c>.
/// </summary>
internal static class SessionLaunch
{
    public const uint TOKEN_DUPLICATE = 0x0002;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint MAXIMUM_ALLOWED = 0x02000000;

    public const int SecurityIdentification = 1;

    /// <summary>
    /// The impersonation level to duplicate the service's own SYSTEM token at.
    /// <c>SecurityIdentification</c> is enough to *name* the caller but not to act
    /// as it, and <c>CreateProcessAsUser</c> with such a token is one of the two
    /// documented ways to get error 5 out of this sequence (PLAN 5.3). SYSTEM
    /// duplicating its own token grants nothing it did not already hold.
    /// </summary>
    public const int SecurityImpersonation = 2;

    public const int TokenPrimary = 1;

    /// <summary>`SetTokenInformation` class — the session the token belongs to.</summary>
    public const int TokenSessionId = 12;

    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint CREATE_NO_WINDOW = 0x08000000;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        /// <summary>MUST carry the window-station prefix: <c>WinSta0\Winlogon</c>.</summary>
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DuplicateTokenEx(
        IntPtr existingToken, uint desiredAccess, ref SECURITY_ATTRIBUTES attributes,
        int impersonationLevel, int tokenType, out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetTokenInformation(
        IntPtr token, int informationClass, ref uint information, int length);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcessAsUser(
        // commandLine is mutable on purpose: CreateProcess may write into it, and
        // a Unicode `string` parameter is pinned rather than copied.
        IntPtr token, string? applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string? currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    /// <summary><c>WaitForSingleObject</c> returns this when the handle is signalled (the process exited).</summary>
    public const uint WAIT_OBJECT_0 = 0x00000000;

    /// <summary>
    /// Wait on a process handle. The watcher keeps the handle CreateProcess
    /// returned so it can poll liveness and read a real exit code (MT-06) — the
    /// old code closed the handle and looked the process up by pid, which is why
    /// every helper death logged exitCode=?.
    /// </summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    /// <summary>Terminate a helper by its handle. The helper spawns no children, so this is a whole tree.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();

    /// <summary>
    /// Which session a process is in. The MT-06 diagnostic that settles the
    /// single most expensive question in this chain: did the helper actually land
    /// in the interactive session, or in session 0 where nothing is visible?
    /// </summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    /// <summary>
    /// Plain process creation, with a desktop.
    ///
    /// This is how <c>SessionWatcher</c> starts a helper: it is already SYSTEM and
    /// already inside the interactive session, so it needs none of the token dance
    /// above — only <c>lpDesktop</c>. Removing that dance from the per-switch path
    /// removes the two documented ways it fails (PLAN 5.3) from the path that has
    /// to work every time a UAC prompt appears.
    /// </summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcess(
        string? applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string? currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetCurrentProcess();
}
