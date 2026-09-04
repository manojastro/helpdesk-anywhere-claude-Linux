using System.Runtime.InteropServices;

namespace HelpdeskAnywhere.SecureDesktopService.Interop;

/// <summary>
/// A minimal Windows service host, by P/Invoke (PLAN 5.3).
///
/// <c>ServiceBase</c> would do this, but it lives in a NuGet package this project
/// does not otherwise need, and every other Win32 surface here is already reached
/// the same way — <c>SendInput</c>, <c>BitBlt</c>, <c>OpenInputDesktop</c>,
/// <c>CreateProcessAsUser</c>. One consistent mechanism, one fewer dependency to
/// restore when cross-compiling from Ubuntu.
///
/// The contract Windows imposes: <see cref="ServiceMain"/> must call
/// <c>RegisterServiceCtrlHandlerEx</c> and report RUNNING quickly, and must
/// report STOPPED before returning, or the SCM waits and then kills the process.
/// </summary>
internal static class ServiceHost
{
    private const string Library = "advapi32.dll";

    public const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010;

    public const uint SERVICE_STOPPED = 0x00000001;
    public const uint SERVICE_START_PENDING = 0x00000002;
    public const uint SERVICE_STOP_PENDING = 0x00000003;
    public const uint SERVICE_RUNNING = 0x00000004;

    public const uint SERVICE_ACCEPT_STOP = 0x00000001;
    public const uint SERVICE_ACCEPT_SHUTDOWN = 0x00000004;

    public const uint SERVICE_CONTROL_STOP = 0x00000001;
    public const uint SERVICE_CONTROL_SHUTDOWN = 0x00000005;
    public const uint SERVICE_CONTROL_INTERROGATE = 0x00000004;

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SERVICE_TABLE_ENTRY
    {
        public IntPtr lpServiceName;
        public IntPtr lpServiceProc;
    }

    public delegate void ServiceMainProc(int argc, IntPtr argv);

    public delegate int HandlerEx(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool StartServiceCtrlDispatcher(SERVICE_TABLE_ENTRY[] table);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr RegisterServiceCtrlHandlerEx(string serviceName, HandlerEx handler, IntPtr context);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetServiceStatus(IntPtr statusHandle, ref SERVICE_STATUS status);
}
