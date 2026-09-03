namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// PLAN 3.1. One grab of the whole virtual desktop, cursor included.
///
/// <see cref="VirtualScreen"/> carries the origin as well as the size, which
/// <see cref="Bounds"/> alone cannot: with a monitor placed left of or above the
/// primary, the virtual desktop starts at a negative coordinate. Phase 4 needs
/// that origin to map a click in the browser back to an absolute
/// <c>SendInput</c> coordinate.
/// </summary>
internal interface IScreenCapture : IDisposable
{
    /// <summary>Size of the virtual desktop in physical pixels.</summary>
    Size Bounds { get; }

    /// <summary>Position and size of the virtual desktop; the origin may be negative.</summary>
    Rectangle VirtualScreen { get; }

    /// <summary>
    /// Capture one frame. The caller owns the returned bitmap and must dispose it.
    /// Returns null if the desktop could not be read this tick — which is normal
    /// and temporary during a desktop switch (Phase 5), not an error to crash on.
    /// </summary>
    Bitmap? Grab();
}
