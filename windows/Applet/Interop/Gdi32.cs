using System.Runtime.InteropServices;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// GDI entry points for screen capture (PLAN 3.1). All P/Invoke lives in
/// <c>Interop/</c> per CLAUDE.md conventions.
///
/// GDI, deliberately — not DXGI Desktop Duplication. DXGI is faster but does not
/// work on the Winlogon / Secure Desktop, which Phase 5 depends on. Do not
/// "upgrade" this without re-testing Phase 5.
/// </summary>
internal static class Gdi32
{
    private const string Library = "gdi32.dll";

    /// <summary>Copy source directly.</summary>
    public const int SRCCOPY = 0x00CC0020;

    /// <summary>Include layered windows — without it they capture as black.</summary>
    public const int CAPTUREBLT = 0x40000000;

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDCW(string? driver, string? device, string? port, IntPtr mode);

    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BitBlt(
        IntPtr hdcDest, int xDest, int yDest, int width, int height,
        IntPtr hdcSrc, int xSrc, int ySrc, int rop);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr obj);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteDC(IntPtr hdc);
}
