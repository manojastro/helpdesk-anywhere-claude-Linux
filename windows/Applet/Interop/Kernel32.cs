using System.Runtime.InteropServices;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// Handle and session primitives shared by the elevation bootstrap and the
/// elevated service (PLAN 5.2b, 5.3). All P/Invoke lives in <c>Interop/</c>.
/// </summary>
internal static class Kernel32
{
    private const string Library = "kernel32.dll";

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// The session the physical console is attached to. The elevated service runs
    /// in session 0, where no desktop the user can see exists; this is how it
    /// finds the session that the helper must be launched into (PLAN 5.3).
    /// </summary>
    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();

    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr GetCurrentProcess();

    [DllImport(Library, SetLastError = true)]
    public static extern uint GetCurrentProcessId();

    /// <summary>
    /// Wait on a process handle. Used instead of <c>Process.GetProcessById</c>
    /// for the elevation installer: that child is short-lived, and looking it up
    /// by pid after it has already exited throws — which was reported to the
    /// agent as a failed elevation even when the service had been installed.
    /// </summary>
    [DllImport(Library, SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
}
