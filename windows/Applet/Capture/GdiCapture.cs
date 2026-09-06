using System.Runtime.InteropServices;

using HelpdeskAnywhere.Applet.Interop;

namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// GDI screen capture (PLAN 3.1).
///
/// The device contexts and the compatible bitmap are created once and reused for
/// every frame. Recreating them per frame is the usual cause of a GDI capture
/// running at 3 FPS — `PLAN.md` calls this out explicitly.
///
/// GDI is the deliberate choice over DXGI Desktop Duplication: DXGI is faster but
/// cannot see the Winlogon / Secure Desktop, which is the single most important
/// feature of this project (Phase 5). Do not swap it without re-testing Phase 5.
/// </summary>
internal sealed class GdiCapture : IScreenCapture
{
    private IntPtr _screenDc;
    private IntPtr _memDc;
    private IntPtr _bitmap;
    private IntPtr _previousBitmap;

    /// <summary>True when the screen DC came from <c>GetDC</c> and needs releasing.</summary>
    private bool _screenDcIsWindowDc;

    private Rectangle _virtualScreen;
    private bool _disposed;

    /// <summary>
    /// Whether this thread's desktop still owns the display (MT-06). Built here,
    /// on the thread that is about to create the capture surfaces, so it records
    /// the same desktop those surfaces will belong to.
    /// </summary>
    private readonly DesktopGuard _guard = new();

    public GdiCapture()
    {
        _virtualScreen = ReadVirtualScreen();
        CreateSurfaces();
    }

    /// <summary>The desktop this capture is bound to, for diagnostics.</summary>
    public string BoundDesktop => _guard.OwnDesktop;

    /// <summary>
    /// How many frames were skipped because another desktop owned the display.
    /// Non-zero here on the applet is the fingerprint of a UAC prompt that the
    /// helper did not reach: before MT-06's fix every one of these was sent as a
    /// black frame instead.
    /// </summary>
    public long SuppressedFrames { get; private set; }

    /// <summary>
    /// Whether this capture's desktop currently owns the display, and a name for
    /// whatever does. Shares the guard's cached reading with <see cref="Grab"/>,
    /// so the applet's desktop poll costs nothing extra.
    /// </summary>
    public bool OwnsDisplayNow(out string inputDesktop)
    {
        inputDesktop = _guard.ReportableDesktop();
        return _guard.OwnsDisplay();
    }

    public Size Bounds => _virtualScreen.Size;

    public Rectangle VirtualScreen => _virtualScreen;

    /// <summary>
    /// Raised when the desktop geometry changed and the surfaces were rebuilt — a
    /// resolution change or a monitor being plugged in. The streamer must send a
    /// keyframe next, because every cached tile hash is now meaningless.
    /// </summary>
    public event Action<Rectangle>? BoundsChanged;

    public Bitmap? Grab()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        // A resolution change or a hot-plugged monitor invalidates the surfaces.
        var current = ReadVirtualScreen();
        if (current != _virtualScreen)
        {
            _virtualScreen = current;
            ReleaseSurfaces();
            CreateSurfaces();
            BoundsChanged?.Invoke(current);
        }

        if (_memDc == IntPtr.Zero || _bitmap == IntPtr.Zero) return null;

        // MT-06. A BitBlt of a desktop that no longer owns the display does not
        // fail — it succeeds and returns black, which every layer above this one
        // then treats as a picture. Skipping the frame freezes the canvas on the
        // last real one instead, which is at least true.
        if (!_guard.OwnsDisplay())
        {
            SuppressedFrames++;
            return null;
        }

        var ok = Gdi32.BitBlt(
            _memDc, 0, 0, _virtualScreen.Width, _virtualScreen.Height,
            _screenDc, _virtualScreen.X, _virtualScreen.Y,
            Gdi32.SRCCOPY | Gdi32.CAPTUREBLT);

        // BitBlt fails while the input desktop is switching (UAC, lock screen).
        // That is expected and transient — skip the frame, do not throw.
        if (!ok) return null;

        DrawCursor();

        try
        {
            return Image.FromHbitmap(_bitmap);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// BitBlt does not include the mouse pointer, so it is composited manually
    /// (PLAN 3.1). Without this the agent sees a desktop with no cursor and cannot
    /// tell where they are pointing.
    /// </summary>
    private void DrawCursor()
    {
        var info = new CursorInfoBuffer();
        if (!User32.GetCursorInfo(ref info.Value)) return;
        if ((info.Value.flags & User32.CURSOR_SHOWING) == 0) return;
        if (info.Value.hCursor == IntPtr.Zero) return;

        if (!User32.GetIconInfo(info.Value.hCursor, out var icon)) return;

        try
        {
            // Hotspot: the cursor image is drawn offset so its point lands on the
            // actual pointer position, and the whole thing is translated into
            // virtual-desktop space (which may start at a negative coordinate).
            var x = info.Value.ptScreenPos.X - icon.xHotspot - _virtualScreen.X;
            var y = info.Value.ptScreenPos.Y - icon.yHotspot - _virtualScreen.Y;

            User32.DrawIconEx(_memDc, x, y, info.Value.hCursor, 0, 0, 0, IntPtr.Zero, User32.DI_NORMAL);
        }
        finally
        {
            // GetIconInfo hands over two bitmaps the caller owns. At 10 FPS,
            // leaking these exhausts the GDI handle quota within minutes.
            if (icon.hbmMask != IntPtr.Zero) Gdi32.DeleteObject(icon.hbmMask);
            if (icon.hbmColor != IntPtr.Zero) Gdi32.DeleteObject(icon.hbmColor);
        }
    }

    internal static Rectangle ReadVirtualScreen()
    {
        var x = User32.GetSystemMetrics(User32.SM_XVIRTUALSCREEN);
        var y = User32.GetSystemMetrics(User32.SM_YVIRTUALSCREEN);
        var w = User32.GetSystemMetrics(User32.SM_CXVIRTUALSCREEN);
        var h = User32.GetSystemMetrics(User32.SM_CYVIRTUALSCREEN);

        // GetSystemMetrics returns 0 for the virtual extents on some session
        // transitions; fall back to the primary screen rather than a 0×0 surface.
        if (w <= 0 || h <= 0)
        {
            var primary = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);
            return primary;
        }

        return new Rectangle(x, y, w, h);
    }

    private void CreateSurfaces()
    {
        // PLAN 3.1 names CreateDC("DISPLAY"); GetDC(NULL) is the fallback, and both
        // give a DC spanning the whole virtual desktop.
        _screenDc = Gdi32.CreateDCW("DISPLAY", null, null, IntPtr.Zero);
        _screenDcIsWindowDc = false;

        if (_screenDc == IntPtr.Zero)
        {
            _screenDc = User32.GetDC(IntPtr.Zero);
            _screenDcIsWindowDc = true;
        }

        if (_screenDc == IntPtr.Zero) return;

        _memDc = Gdi32.CreateCompatibleDC(_screenDc);
        if (_memDc == IntPtr.Zero) return;

        // Compatible with the SCREEN dc, not the memory dc: a bitmap made
        // compatible with a fresh memory DC is 1bpp monochrome.
        _bitmap = Gdi32.CreateCompatibleBitmap(_screenDc, _virtualScreen.Width, _virtualScreen.Height);
        if (_bitmap == IntPtr.Zero) return;

        _previousBitmap = Gdi32.SelectObject(_memDc, _bitmap);
    }

    private void ReleaseSurfaces()
    {
        if (_memDc != IntPtr.Zero && _previousBitmap != IntPtr.Zero)
        {
            Gdi32.SelectObject(_memDc, _previousBitmap);
            _previousBitmap = IntPtr.Zero;
        }

        if (_bitmap != IntPtr.Zero)
        {
            Gdi32.DeleteObject(_bitmap);
            _bitmap = IntPtr.Zero;
        }

        if (_memDc != IntPtr.Zero)
        {
            Gdi32.DeleteDC(_memDc);
            _memDc = IntPtr.Zero;
        }

        if (_screenDc != IntPtr.Zero)
        {
            if (_screenDcIsWindowDc) User32.ReleaseDC(IntPtr.Zero, _screenDc);
            else Gdi32.DeleteDC(_screenDc);
            _screenDc = IntPtr.Zero;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        ReleaseSurfaces();
    }

    /// <summary>
    /// <c>GetCursorInfo</c> requires <c>cbSize</c> to be pre-set; wrapping the
    /// struct keeps that initialisation in one place.
    /// </summary>
    private struct CursorInfoBuffer
    {
        public User32.CURSORINFO Value = new()
        {
            cbSize = Marshal.SizeOf<User32.CURSORINFO>(),
        };

        public CursorInfoBuffer()
        {
        }
    }
}
