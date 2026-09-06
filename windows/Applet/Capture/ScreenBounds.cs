namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// The virtual-desktop geometry, and nothing else (MT-06 STATE C).
///
/// The elevated helper on <c>WinSta0\Default</c> exists to INJECT INPUT, not to
/// capture: the applet already streams that desktop perfectly well, and a second
/// capturer there would be the redundant work and pipe contention that the
/// previous round deliberately removed.
///
/// But <see cref="Input.InputInjector"/> needs the virtual screen to map a remote
/// pixel onto the 0-65535 absolute space <c>SendInput</c> expects, and it takes an
/// <see cref="IScreenCapture"/> to get it. This supplies exactly that and refuses
/// to grab a frame, so an input-only helper allocates no device contexts and no
/// full-screen bitmap (~8 MB at 1080p) it would never read.
///
/// The geometry is read live rather than cached: a resolution change or a
/// hot-plugged monitor during a session must not leave every remote click landing
/// at the wrong coordinates, and four <c>GetSystemMetrics</c> calls per input
/// event cost nothing next to the pipe hop that delivered it.
/// </summary>
internal sealed class ScreenBounds : IScreenCapture
{
    public Size Bounds => VirtualScreen.Size;

    public Rectangle VirtualScreen => GdiCapture.ReadVirtualScreen();

    /// <summary>Always null: this exists to answer geometry, never to capture.</summary>
    public Bitmap? Grab() => null;

    public void Dispose()
    {
    }
}
