using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// Which capturer, if any, is allowed to put frames on the wire right now
/// (PLAN 5.6; rebuilt after MT-06, 2026-09-05).
///
/// There are two capturers for one canvas — the applet's own <c>GdiCapture</c> on
/// the user's desktop, and a <c>DesktopHelper</c> on whatever desktop UAC is
/// using — and the handoff between them was previously implicit: a single
/// "paused" flag, set only when a helper had already attached and announced its
/// desktop. Everything before that moment, and everything after the helper died,
/// was the applet streaming a desktop that no longer owned the display. That
/// capture does not fail; it returns black. Hence MT-06's black canvas.
///
/// So the handoff is now an explicit state machine with a state for each gap:
///
/// <code>
///   DefaultDesktop  ──input desktop is no longer ours──▶  SecureDesktopTransition
///        ▲                                                        │
///        │                                              helper attaches
///   helper detaches                                               ▼
///        │                                                  SecureDesktop
///   ReturningToDefault  ◀──input desktop is ours again────────────┘
/// </code>
///
/// Exactly one source may send in each state, and in the two transition states
/// that is deliberately NEITHER: a frozen last frame is honest about what is
/// known, and a black one is not. The states are reported to the console as they
/// change, so an agent can see a handoff in progress rather than a dead canvas.
/// </summary>
internal enum StreamSourceState
{
    /// <summary>The user's desktop owns the display; the applet captures it.</summary>
    DefaultDesktop,

    /// <summary>A secure desktop has taken the display; no helper is on it yet. Nobody sends.</summary>
    SecureDesktopTransition,

    /// <summary>A helper is bound to the secure desktop; only its frames go out.</summary>
    SecureDesktop,

    /// <summary>The display is ours again; the helper has not finished going. Applet sends.</summary>
    ReturningToDefault,
}

/// <summary>
/// The state machine above, plus the two questions the rest of the applet asks it.
/// Every method is safe from any thread: transitions arrive from the pipe thread,
/// the desktop poll and the UI thread, and frames are offered from two more.
/// </summary>
internal sealed class StreamSource
{
    private readonly object _gate = new();
    private readonly Action<StreamSourceState, string> _onChanged;

    private StreamSourceState _state = StreamSourceState.DefaultDesktop;
    private bool _helperAttached;
    private bool _displayIsOurs = true;
    private string _desktop = "Default";

    public StreamSource(Action<StreamSourceState, string> onChanged) => _onChanged = onChanged;

    public StreamSourceState State { get { lock (_gate) return _state; } }

    /// <summary>The desktop name to report to the console.</summary>
    public string Desktop { get { lock (_gate) return _desktop; } }

    /// <summary>True while the applet's own capture may send.</summary>
    public bool LocalMaySend
    {
        get
        {
            lock (_gate)
            {
                return _state is StreamSourceState.DefaultDesktop or StreamSourceState.ReturningToDefault;
            }
        }
    }

    /// <summary>True while helper frames may be forwarded.</summary>
    public bool HelperMaySend
    {
        get { lock (_gate) return _state == StreamSourceState.SecureDesktop; }
    }

    /// <summary>
    /// The applet's own reading of who owns the display, from
    /// <see cref="DesktopGuard"/>. This is the signal that arrives FIRST — one
    /// poll after Windows switches desktops, without waiting for a helper to
    /// start, connect and announce itself.
    /// </summary>
    public void ObserveDisplay(bool oursNow, string reportableDesktop)
    {
        lock (_gate)
        {
            _displayIsOurs = oursNow;
            if (!oursNow && _desktop == "Default") _desktop = reportableDesktop;
            else if (oursNow && !_helperAttached) _desktop = "Default";
            Recompute();
        }
    }

    /// <summary>A helper announced the desktop it is bound to (PLAN 5.6).</summary>
    public void HelperAttached(string desktop)
    {
        lock (_gate)
        {
            _helperAttached = true;
            if (!string.IsNullOrWhiteSpace(desktop)) _desktop = desktop;

            // A helper on the user's own desktop is not a secure-desktop handoff;
            // it is the ordinary case with an elevated capturer available, and the
            // applet keeps streaming. Only a non-Default desktop takes the canvas.
            if (string.Equals(_desktop, "Default", StringComparison.OrdinalIgnoreCase))
                _helperAttached = false;

            Recompute();
        }
    }

    /// <summary>The helper's pipe closed — it died, or its desktop went away.</summary>
    public void HelperDetached()
    {
        lock (_gate)
        {
            _helperAttached = false;
            Recompute();
        }
    }

    /// <summary>
    /// Elevation ended or failed: forget everything the elevated half told us, so
    /// a stale "secure desktop" cannot leave the canvas frozen for the rest of the
    /// session.
    /// </summary>
    public void Reset()
    {
        lock (_gate)
        {
            _helperAttached = false;
            _displayIsOurs = true;
            _desktop = "Default";
            Recompute();
        }
    }

    /// <summary>Must be called holding <see cref="_gate"/>.</summary>
    private void Recompute()
    {
        var next = (_displayIsOurs, _helperAttached) switch
        {
            // The display is ours. If a helper is still attached it is on its way
            // out; the applet may send either way.
            (true, true) => StreamSourceState.ReturningToDefault,
            (true, false) => StreamSourceState.DefaultDesktop,

            // Something else owns the display. Only a helper on it can see it.
            (false, true) => StreamSourceState.SecureDesktop,
            (false, false) => StreamSourceState.SecureDesktopTransition,
        };

        if (next == _state) return;

        var previous = _state;
        _state = next;
        DiagLog.Write("applet.source", "stream source changed",
            $"{previous} -> {next}  desktop={_desktop} displayIsOurs={_displayIsOurs} helper={_helperAttached}");

        _onChanged(next, _desktop);
    }
}
