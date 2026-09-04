namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// Where <see cref="ScreenStreamer"/> puts the frames it encodes.
///
/// Phase 3 had exactly one: the WebSocket to the relay. Phase 5.4 adds a second —
/// the <c>DesktopHelper</c>, which runs as SYSTEM on the Winlogon desktop and has
/// no socket of its own, only a named pipe back to the applet. PLAN 5.4 asks for
/// "the exact same GdiCapture and InputInjector"; this is the one seam that
/// makes "the exact same <see cref="ScreenStreamer"/>" true as well.
///
/// <see cref="PendingFrames"/> is the backpressure signal: the streamer skips
/// capture altogether while a frame is still queued, so a slow link costs frame
/// rate rather than growing a queue (PLAN 3.2).
/// </summary>
internal interface IFrameSink
{
    /// <summary>Frames encoded but not yet written out.</summary>
    int PendingFrames { get; }

    /// <summary>Queue one frame. False if the sink is closed.</summary>
    bool TrySendFrame(ReadOnlyMemory<byte> frame);
}
