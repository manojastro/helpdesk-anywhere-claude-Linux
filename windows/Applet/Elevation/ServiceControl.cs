using System.ComponentModel;
using System.Runtime.InteropServices;

using HelpdeskAnywhere.Applet.Interop;

namespace HelpdeskAnywhere.Applet.Elevation;

/// <summary>
/// Install, start, stop and delete the elevated helper service (PLAN 5.2d, 5.7).
///
/// Every method here needs administrator rights and is therefore only ever
/// reached from the elevated relaunch (<c>--install-service</c> /
/// <c>--uninstall-service</c>), never from the ordinary applet process.
///
/// CLAUDE.md constraint #4 is the reason <see cref="Uninstall"/> exists and is
/// called from every teardown path: the service is installed at session start and
/// removed at session end. Nothing survives a reboot, and nothing survives the
/// applet being killed either — the service's own watchdog covers that case.
/// </summary>
internal static class ServiceControl
{
    public const string ServiceName = "HelpdeskAnywhereSvc";
    public const string DisplayName = "Helpdesk Anywhere (temporary support session)";

    /// <summary>Where the elevated payload is staged. Deleted on uninstall.</summary>
    public static string InstallDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "HelpdeskAnywhere");

    /// <summary>
    /// The staged copy of the applet. The service and the desktop helper are both
    /// modes of it, so there is one file rather than three (DECISIONS.md D-009).
    /// </summary>
    public static string ServiceExePath => Path.Combine(InstallDir, "HelpdeskAnywhere.exe");

    /// <summary>
    /// Create the service if it is not there, then start it. Idempotent: a second
    /// call on an already-running service succeeds silently, because a retried
    /// elevation must not fail on its own previous success.
    /// </summary>
    public static void InstallAndStart(string pipeName)
    {
        var manager = AdvApi32.OpenSCManager(
            null, null, AdvApi32.SC_MANAGER_CONNECT | AdvApi32.SC_MANAGER_CREATE_SERVICE);
        if (manager == IntPtr.Zero) throw Fail("OpenSCManager");

        try
        {
            // The pipe name is part of the command line rather than the registry
            // or a file: it is per-session, and nothing about this install should
            // outlive the session.
            var binaryPath = $"\"{ServiceExePath}\" --run-service --pipe {pipeName}";

            var service = AdvApi32.CreateService(
                manager,
                ServiceName,
                DisplayName,
                AdvApi32.SERVICE_ALL_ACCESS,
                AdvApi32.SERVICE_WIN32_OWN_PROCESS,
                AdvApi32.SERVICE_DEMAND_START,
                AdvApi32.SERVICE_ERROR_NORMAL,
                binaryPath,
                null,
                IntPtr.Zero,
                null,
                null,          // null service account = LocalSystem
                null);

            if (service == IntPtr.Zero)
            {
                var err = Marshal.GetLastWin32Error();
                if (err != AdvApi32.ERROR_SERVICE_EXISTS) throw Fail("CreateService", err);

                // Left over from a previous session that died badly. Take it over
                // rather than refusing: the alternative is a machine that can
                // never be helped again without a manual `sc delete`.
                service = AdvApi32.OpenService(manager, ServiceName, AdvApi32.SERVICE_ALL_ACCESS);
                if (service == IntPtr.Zero) throw Fail("OpenService");
            }

            try
            {
                if (!AdvApi32.StartService(service, 0, null))
                {
                    var err = Marshal.GetLastWin32Error();
                    // 1056: already running — which is the state we wanted.
                    if (err != 1056) throw Fail("StartService", err);
                }
            }
            finally
            {
                AdvApi32.CloseServiceHandle(service);
            }
        }
        finally
        {
            AdvApi32.CloseServiceHandle(manager);
        }
    }

    /// <summary>
    /// Stop and delete the service and remove the staging directory (PLAN 5.7).
    ///
    /// Never throws: it runs on teardown paths, including crash paths, and a
    /// failure to remove one piece must not stop the rest from being removed.
    /// Returns true when the service is verifiably gone.
    /// </summary>
    public static bool Uninstall()
    {
        var removed = true;

        var manager = AdvApi32.OpenSCManager(null, null, AdvApi32.SC_MANAGER_CONNECT);
        if (manager != IntPtr.Zero)
        {
            try
            {
                var service = AdvApi32.OpenService(
                    manager, ServiceName,
                    AdvApi32.SERVICE_STOP | AdvApi32.SERVICE_QUERY_STATUS | AdvApi32.DELETE);

                if (service == IntPtr.Zero)
                {
                    // Already gone is the desired end state, not an error.
                    removed = Marshal.GetLastWin32Error() == AdvApi32.ERROR_SERVICE_DOES_NOT_EXIST;
                }
                else
                {
                    try
                    {
                        var status = default(AdvApi32.SERVICE_STATUS);
                        AdvApi32.ControlService(service, AdvApi32.SERVICE_CONTROL_STOP, ref status);
                        WaitForStop(service);
                        removed = AdvApi32.DeleteService(service);
                    }
                    finally
                    {
                        AdvApi32.CloseServiceHandle(service);
                    }
                }
            }
            catch (Exception)
            {
                removed = false;
            }
            finally
            {
                AdvApi32.CloseServiceHandle(manager);
            }
        }
        else
        {
            removed = false;
        }

        try
        {
            if (Directory.Exists(InstallDir)) Directory.Delete(InstallDir, recursive: true);
        }
        catch (Exception)
        {
            // A file still mapped by a dying process: the directory goes on the
            // next attempt, and the service registration is the part that matters.
        }

        return removed;
    }

    /// <summary>
    /// True only when the service is registered AND actually running (MT-06).
    ///
    /// <see cref="IsInstalled"/> is not the same question, and treating it as one
    /// is how the agent was told "elevated" while nothing was running: a
    /// registration left behind by a previous session satisfies it, and so does a
    /// service that was created and then failed to start. Elevation means the
    /// SYSTEM half is usable, and this is the first of the three things that have
    /// to be true before the console is told so.
    /// </summary>
    public static bool IsRunning()
    {
        var manager = AdvApi32.OpenSCManager(null, null, AdvApi32.SC_MANAGER_CONNECT);
        if (manager == IntPtr.Zero) return false;

        try
        {
            var service = AdvApi32.OpenService(manager, ServiceName, AdvApi32.SERVICE_QUERY_STATUS);
            if (service == IntPtr.Zero) return false;

            try
            {
                var status = default(AdvApi32.SERVICE_STATUS);
                if (!AdvApi32.QueryServiceStatus(service, ref status)) return false;
                return status.dwCurrentState == AdvApi32.SERVICE_RUNNING;
            }
            finally
            {
                AdvApi32.CloseServiceHandle(service);
            }
        }
        finally
        {
            AdvApi32.CloseServiceHandle(manager);
        }
    }

    /// <summary>True if the service is registered at all — the check PLAN 5.7 asks for.</summary>
    public static bool IsInstalled()
    {
        var manager = AdvApi32.OpenSCManager(null, null, AdvApi32.SC_MANAGER_CONNECT);
        if (manager == IntPtr.Zero) return false;

        try
        {
            var service = AdvApi32.OpenService(manager, ServiceName, AdvApi32.SERVICE_QUERY_STATUS);
            if (service == IntPtr.Zero) return false;
            AdvApi32.CloseServiceHandle(service);
            return true;
        }
        finally
        {
            AdvApi32.CloseServiceHandle(manager);
        }
    }

    /// <summary>
    /// Give the service a few seconds to stop before deleting it. A delete on a
    /// still-running service is only marked pending, and the registration then
    /// lingers until the next reboot — exactly what constraint #4 forbids.
    /// </summary>
    private static void WaitForStop(IntPtr service)
    {
        var status = default(AdvApi32.SERVICE_STATUS);
        var deadline = DateTime.UtcNow.AddSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            if (!AdvApi32.QueryServiceStatus(service, ref status)) return;
            if (status.dwCurrentState == AdvApi32.SERVICE_STOPPED) return;
            Thread.Sleep(200);
        }
    }

    private static Win32Exception Fail(string call, int? code = null)
    {
        var err = code ?? Marshal.GetLastWin32Error();
        return new Win32Exception(err, $"{call} failed (Windows error {err}).");
    }
}
