using HelpdeskAnywhere.Applet.Interop;

namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// Answers one question, for whoever is about to capture: is the desktop this
/// thread is bound to the one that currently owns the display?
///
/// WHY — MT-06, 2026-09-05. A <c>BitBlt</c> of a desktop that is no longer the
/// input desktop does not fail. It SUCCEEDS and returns black. So while a UAC
/// prompt was up on the Secure Desktop, the applet cheerfully captured, encoded
/// and sent a full black keyframe ten times a second, and the technician's canvas
/// went black rather than freezing on the last real picture. Every layer above
/// treated that as a working stream, because by every signal it had, it was one.
///
/// The check costs one <c>OpenInputDesktop</c>, cached for
/// <see cref="CacheFor"/>, and it is deliberately CONSERVATIVE: it suppresses a
/// frame only when it can positively establish that some other desktop owns the
/// display. If the input desktop cannot be determined at all, capture proceeds
/// exactly as before — a diagnostic that guesses wrong here would break ordinary
/// screen sharing (MT-02), which is a far worse failure than a black frame.
///
/// It is used by the applet and by the helper, unchanged: for the applet the
/// thread desktop is <c>Default</c> and a UAC prompt makes <c>OpenInputDesktop</c>
/// fail with ERROR_ACCESS_DENIED — which is itself the answer, since a desktop an
/// unelevated process may not open is by definition not its own. For the helper
/// the thread desktop is <c>Winlogon</c>, it runs as SYSTEM, and the same
/// comparison stops it streaming a stale Winlogon frame after the prompt closes.
/// </summary>
internal sealed class DesktopGuard
{
    /// <summary>
    /// Long enough that a 10 FPS capture loop does one call per frame at most,
    /// short enough that a transition is noticed within a frame or two.
    /// </summary>
    private static readonly TimeSpan CacheFor = TimeSpan.FromMilliseconds(100);

    private readonly string _ownDesktop;
    private readonly object _gate = new();

    private DateTime _readAt = DateTime.MinValue;
    private string _inputDesktop = "";
    private int _error;

    /// <summary>
    /// Captures the calling thread's desktop name once, at construction. Callers
    /// build this on the thread that will do the capturing, after
    /// <c>SetThreadDesktop</c> — the same ordering rule the capture surfaces obey
    /// (PLAN 5.4).
    /// </summary>
    public DesktopGuard() => _ownDesktop = Desktops.ThreadDesktopName();

    /// <summary>The desktop this guard's thread is bound to; "" if unreadable.</summary>
    public string OwnDesktop => _ownDesktop;

    /// <summary>
    /// The desktop currently receiving input, as this process can see it:
    /// a name, <see cref="Desktops.Denied"/>, or "" for "cannot tell".
    /// </summary>
    public string InputDesktop
    {
        get
        {
            Refresh();
            return _inputDesktop;
        }
    }

    /// <summary>The Win32 error from the last failed reading, for diagnostics.</summary>
    public int LastError
    {
        get
        {
            Refresh();
            return _error;
        }
    }

    /// <summary>
    /// False only when another desktop is positively known to own the display.
    /// Unknown reads as true, on purpose — see the class remarks.
    /// </summary>
    public bool OwnsDisplay()
    {
        Refresh();

        // Cannot tell, either side: behave exactly as this code did before the
        // guard existed.
        if (_inputDesktop.Length == 0 || _ownDesktop.Length == 0) return true;

        // A desktop this process may not even open is certainly not its own. For
        // the applet, running as the end user, this IS the Secure Desktop.
        if (_inputDesktop == Desktops.Denied) return false;

        return string.Equals(_inputDesktop, _ownDesktop, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A name for the current input desktop that is safe to show a human and to
    /// put on the wire: <c>Default</c>, <c>Winlogon</c>, or <c>Secure</c> when all
    /// this process can tell is that it may not look.
    /// </summary>
    public string ReportableDesktop()
    {
        Refresh();
        if (_inputDesktop.Length == 0) return _ownDesktop.Length == 0 ? "Default" : _ownDesktop;
        return _inputDesktop == Desktops.Denied ? "Secure" : _inputDesktop;
    }

    private void Refresh()
    {
        lock (_gate)
        {
            var now = DateTime.UtcNow;
            if (now - _readAt < CacheFor) return;

            _readAt = now;
            _inputDesktop = Desktops.InputDesktopName(out _error);
        }
    }
}
