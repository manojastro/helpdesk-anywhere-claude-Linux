using System.Runtime.InteropServices;
using System.Text;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// Who owns the foreground window, and at what integrity level (MT-06 STATE C).
///
/// WHY THIS EXISTS. Windows UIPI (User Interface Privilege Isolation) silently
/// discards synthetic input sent from a process at a LOWER integrity level than
/// the window receiving it. The applet runs as the interactive user at MEDIUM
/// integrity (`asInvoker`, CLAUDE.md constraint #1 — it must never self-elevate).
/// An application launched through a UAC prompt runs at HIGH integrity. So the
/// applet's own <c>SendInput</c> reaches an ordinary window and is thrown away by
/// a post-UAC installer, with no error the caller can see on the way in.
///
/// That is a whole class of "the remote mouse stopped working" that looks like a
/// capture or protocol bug and is neither. This reads the target so a session can
/// SAY so, and so the applet can tell an unroutable click from a delivered one.
///
/// Read-only and query-only: it opens the foreground process with
/// PROCESS_QUERY_LIMITED_INFORMATION and its token with TOKEN_QUERY, and never
/// writes, injects, or changes a single thing about it. Nothing here weakens UIPI
/// — the fix for UIPI is to inject from a process that is allowed to, not to
/// disable the boundary.
/// </summary>
internal static class ForegroundTarget
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;

    /// <summary>`GetTokenInformation` class: the token's mandatory integrity label.</summary>
    private const int TokenIntegrityLevel = 25;

    /// <summary>`GetTokenInformation` class: whether the token is elevated.</summary>
    private const int TokenElevation = 20;

    /// <summary>Well-known mandatory RIDs (winnt.h SECURITY_MANDATORY_*_RID).</summary>
    public const int IntegrityUntrusted = 0x0000;
    public const int IntegrityLow = 0x1000;
    public const int IntegrityMedium = 0x2000;
    public const int IntegrityHigh = 0x3000;
    public const int IntegritySystem = 0x4000;

    /// <summary>What was learned about the foreground window. Never throws.</summary>
    internal readonly record struct Info(
        bool Known,
        int Pid,
        string ProcessName,
        int IntegrityRid,
        bool Elevated,
        int Error)
    {
        /// <summary>
        /// True when the target sits above the applet's own medium integrity, which
        /// is exactly when UIPI will discard the applet's SendInput.
        /// </summary>
        public bool AboveMediumIntegrity => Known && IntegrityRid > IntegrityMedium;

        public string IntegrityName => IntegrityRid switch
        {
            >= IntegritySystem => "System",
            >= IntegrityHigh => "High",
            >= IntegrityMedium => "Medium",
            >= IntegrityLow => "Low",
            _ => "Untrusted",
        };

        public override string ToString() =>
            Known
                ? $"pid={Pid} process={ProcessName} integrity={IntegrityName}(0x{IntegrityRid:X}) elevated={Elevated}"
                : $"unknown (error={Error})";
    }

    /// <summary>
    /// Inspect the current foreground window. Returns <c>Known=false</c> rather
    /// than throwing when anything cannot be read — callers must treat "cannot
    /// tell" as "carry on", never as "elevated".
    /// </summary>
    public static Info Current()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero) return new Info(false, 0, "", 0, false, 0);

        _ = GetWindowThreadProcessId(window, out var pid);
        if (pid == 0) return new Info(false, 0, "", 0, false, 0);

        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero)
            return new Info(false, (int)pid, "", 0, false, Marshal.GetLastWin32Error());

        try
        {
            var name = ImageName(process);

            if (!OpenProcessToken(process, TOKEN_QUERY, out var token))
                return new Info(false, (int)pid, name, 0, false, Marshal.GetLastWin32Error());

            try
            {
                return new Info(true, (int)pid, name, IntegrityRid(token), IsElevated(token), 0);
            }
            finally
            {
                Kernel32.CloseHandle(token);
            }
        }
        finally
        {
            Kernel32.CloseHandle(process);
        }
    }

    private static string ImageName(IntPtr process)
    {
        var buffer = new StringBuilder(512);
        var size = buffer.Capacity;
        if (!QueryFullProcessImageName(process, 0, buffer, ref size)) return "";

        var path = buffer.ToString();
        var slash = path.LastIndexOf('\\');
        return slash >= 0 ? path[(slash + 1)..] : path;
    }

    /// <summary>The RID at the end of the token's integrity SID, or 0 if unreadable.</summary>
    private static int IntegrityRid(IntPtr token)
    {
        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out var needed);
        if (needed == 0) return 0;

        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, needed, out _)) return 0;

            // TOKEN_MANDATORY_LABEL is a SID_AND_ATTRIBUTES whose first field is a
            // pointer to the SID; the integrity level is its last sub-authority.
            var sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero) return 0;

            var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) return 0;

            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        }
        catch (Exception)
        {
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool IsElevated(IntPtr token)
    {
        GetTokenInformation(token, TokenElevation, IntPtr.Zero, 0, out var needed);
        if (needed == 0) return false;

        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!GetTokenInformation(token, TokenElevation, buffer, needed, out _)) return false;
            return Marshal.ReadInt32(buffer) != 0;
        }
        catch (Exception)
        {
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr token, int informationClass, IntPtr information, uint length, out uint returnLength);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
}
