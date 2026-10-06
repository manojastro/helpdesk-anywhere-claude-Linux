using System.Runtime.InteropServices;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// Physical memory totals for the System Information view (Platform 2.0, Phase
/// 2b). Read-only; all P/Invoke lives in <c>Interop/</c>.
/// </summary>
internal static class Memory
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    /// <summary>(total, available) physical memory in bytes, or null if Windows would not say.</summary>
    public static (ulong Total, ulong Available)? Physical()
    {
        var s = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        return GlobalMemoryStatusEx(ref s) ? (s.TotalPhys, s.AvailPhys) : null;
    }
}
