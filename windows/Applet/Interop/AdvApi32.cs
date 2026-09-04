using System.Runtime.InteropServices;
using System.Text;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// Credential-mode elevation and service control (PLAN 5.2b, 5.2d, 5.7).
///
/// All P/Invoke lives in <c>Interop/</c> per CLAUDE.md conventions.
///
/// SECURITY: <see cref="CreateProcessWithLogonW"/> takes the password as a
/// <c>char[]</c> pinned by the caller, not a <c>string</c>. A .NET string is
/// immutable and garbage-collected — it cannot be overwritten, and a copy can sit
/// in the heap until the process ends and into any crash dump taken meanwhile.
/// PLAN 5.2c rule 4 requires the buffer to be zeroed in a <c>finally</c>, and
/// only a <c>char[]</c> can be.
/// </summary>
internal static class AdvApi32
{
    private const string Library = "advapi32.dll";

    /* ------------------------------------------------------------ logon flags */

    /// <summary>`CreateProcessWithLogonW` — load the target account's profile.</summary>
    public const uint LOGON_WITH_PROFILE = 0x00000001;

    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint CREATE_NO_WINDOW = 0x08000000;

    /* ---------------------------------------------------------- service flags */

    public const uint SC_MANAGER_CONNECT = 0x0001;
    public const uint SC_MANAGER_CREATE_SERVICE = 0x0002;

    public const uint SERVICE_ALL_ACCESS = 0xF01FF;
    public const uint SERVICE_QUERY_STATUS = 0x0004;
    public const uint SERVICE_START = 0x0010;
    public const uint SERVICE_STOP = 0x0020;
    public const uint DELETE = 0x00010000;

    public const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010;
    public const uint SERVICE_DEMAND_START = 0x00000003;
    public const uint SERVICE_ERROR_NORMAL = 0x00000001;

    public const uint SERVICE_CONTROL_STOP = 0x00000001;

    public const uint SERVICE_STOPPED = 0x00000001;
    public const uint SERVICE_RUNNING = 0x00000004;

    /// <summary>`OpenService`/`CreateService` — the service is not installed.</summary>
    public const int ERROR_SERVICE_DOES_NOT_EXIST = 1060;
    public const int ERROR_SERVICE_EXISTS = 1073;
    public const int ERROR_SERVICE_NOT_ACTIVE = 1062;

    /* ----------------------------------------------------------------- structs */

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        /// <summary>Must carry the window-station prefix: <c>WinSta0\Default</c>.</summary>
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

    [StructLayout(LayoutKind.Sequential)]
    public struct SERVICE_STATUS
    {
        public uint dwServiceType;
        public uint dwCurrentState;
        public uint dwControlsAccepted;
        public uint dwWin32ExitCode;
        public uint dwServiceSpecificExitCode;
        public uint dwCheckPoint;
        public uint dwWaitHint;
    }

    /* ------------------------------------------------------------- credentials */

    /// <summary>
    /// Start a process as another user with no UAC prompt (PLAN 5.2b).
    ///
    /// The password is a <c>char[]</c> so the caller can zero it; see the class
    /// remarks. Marshalled as a raw pointer for the same reason — letting the
    /// marshaller build a native string from a .NET one would put an
    /// unzeroable copy in memory.
    /// </summary>
    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcessWithLogonW(
        string lpUsername,
        string? lpDomain,
        IntPtr lpPassword,
        uint dwLogonFlags,
        string? lpApplicationName,
        // Mutable on purpose: the CreateProcess family may write into
        // lpCommandLine, and for a Unicode signature the marshaller pins the
        // managed string instead of copying it — so passing a `string` here
        // hands the callee a pointer into the .NET string heap.
        StringBuilder lpCommandLine,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    /* ----------------------------------------------------------------- services */

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenSCManager(string? machineName, string? databaseName, uint access);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateService(
        IntPtr scManager,
        string serviceName,
        string displayName,
        uint desiredAccess,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPath,
        string? loadOrderGroup,
        IntPtr tagId,
        string? dependencies,
        string? serviceStartName,
        string? password);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenService(IntPtr scManager, string serviceName, uint access);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool StartService(IntPtr service, int numArgs, string[]? args);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ControlService(IntPtr service, uint control, ref SERVICE_STATUS status);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryServiceStatus(IntPtr service, ref SERVICE_STATUS status);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteService(IntPtr service);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseServiceHandle(IntPtr handle);
}
