using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.SecureDesktopService;

/// <summary>
/// The session watcher's connection to the applet's pipe (MT-06).
///
/// It carries two things and nothing else:
///
///  * <b>diagnostics</b> — every <see cref="DiagLog"/> line, so the applet's log
///    holds the whole four-process chronology in order. The watcher's own copy
///    lives in the staging directory, which the service deletes when it
///    uninstalls itself, so without this the most interesting lines would be gone
///    by the time anyone read them;
///
///  * <b>the desktop transition, early</b>. The helper also announces the desktop
///    it is bound to, but only once it has started, opened the desktop, bound its
///    thread and connected — and during that gap the applet was still streaming
///    its own desktop, which is BLACK while the Secure Desktop owns the display.
///    The watcher sees the switch one poll after it happens and says so
///    immediately, which is what closes that window.
///
/// It is announced as <see cref="PipeChannel.RoleWatcher"/> precisely so the
/// applet does not mistake it for a helper: it streams no frames and injects no
/// input, and a click routed here would land nowhere at all.
/// </summary>
internal sealed class WatcherLink : IDisposable
{
    private readonly string _pipeName;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private System.IO.Pipes.NamedPipeClientStream? _pipe;
    private volatile bool _disposed;

    public WatcherLink(string pipeName) => _pipeName = pipeName;

    public void Start(CancellationToken ct) => _ = Task.Run(() => RunAsync(ct), ct);

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_disposed)
        {
            try
            {
                var pipe = PipeChannel.CreateClient(_pipeName);
                await pipe.ConnectAsync(5000, ct).ConfigureAwait(false);
                _pipe = pipe;

                await SendAsync(
                    PipeChannel.TextFrame(PipeChannel.TagHello, PipeChannel.RoleWatcher),
                    ct).ConfigureAwait(false);

                DiagLog.Write("watcher.pipe", "connected to the applet", $"pipe={_pipeName}");

                // From here every diagnostic line goes to the applet as well. The
                // backlog — everything logged before the applet was reachable,
                // which is where the startup failures are — flushes first.
                DiagLog.ShipTo(Ship);

                // Stay until the applet goes away; the read is how that is noticed.
                while (!ct.IsCancellationRequested)
                {
                    var frame = await PipeChannel.ReadFrameAsync(pipe, ct).ConfigureAwait(false);
                    if (frame is null || frame.Length == 0) break;
                    if (frame[0] == PipeChannel.TagShutdown) return;
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                DiagLog.Write("watcher.pipe", "disconnected", ex.GetType().Name);
            }
            finally
            {
                DiagLog.StopShipping();
                try { _pipe?.Dispose(); } catch (Exception) { }
                _pipe = null;
            }

            try { await Task.Delay(1000, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>The desktop transition, the moment it is seen.</summary>
    public void AnnounceDesktop(string desktop) =>
        _ = SendAsync(PipeChannel.TextFrame(PipeChannel.TagDesktop, desktop), CancellationToken.None);

    /// <summary>
    /// One diagnostic line. Fire-and-forget and never awaited by the watch loop:
    /// a stalled pipe must not slow down desktop detection, which is the job.
    /// </summary>
    private void Ship(string line) =>
        _ = SendAsync(PipeChannel.TextFrame(PipeChannel.TagDiag, line), CancellationToken.None);

    private async Task SendAsync(byte[] frame, CancellationToken ct)
    {
        var pipe = _pipe;
        if (pipe is null || !pipe.IsConnected || _disposed) return;

        if (!await _writeLock.WaitAsync(2000, ct).ConfigureAwait(false)) return;
        try
        {
            if (pipe.IsConnected) await PipeChannel.WriteFrameAsync(pipe, frame, ct).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The applet ended the session. The watch loop carries on regardless;
            // the service's watchdog is what notices and tears everything down.
        }
        finally
        {
            try { _writeLock.Release(); } catch (Exception) { }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        DiagLog.StopShipping();
        try { _pipe?.Dispose(); } catch (Exception) { }
    }
}
