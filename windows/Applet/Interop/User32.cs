using System.Runtime.InteropServices;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// User32 entry points for virtual-desktop metrics and cursor drawing
/// (PLAN 3.1). All P/Invoke lives in <c>Interop/</c> per CLAUDE.md conventions.
/// </summary>
internal static class User32
{
    private const string Library = "user32.dll";

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    /// <summary>`CURSORINFO.flags` — the cursor is visible and should be drawn.</summary>
    public const int CURSOR_SHOWING = 0x00000001;

    /// <summary>`DrawIconEx` — draw the image, not the mask.</summary>
    public const int DI_NORMAL = 0x0003;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    /// <summary>
    /// `hbmMask` and `hbmColor` are caller-owned bitmaps that MUST be deleted.
    /// At 10 frames per second a leak here exhausts the GDI handle quota in
    /// minutes.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO
    {
        [MarshalAs(UnmanagedType.Bool)] public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [DllImport(Library)]
    public static extern int GetSystemMetrics(int index);

    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport(Library)]
    public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorInfo(ref CURSORINFO info);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DrawIconEx(
        IntPtr hdc, int x, int y, IntPtr icon,
        int width, int height, int step, IntPtr brush, int flags);
}
