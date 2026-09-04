using System.IO.Pipes;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Elevation;

/// <summary>
/// The applet's end of the pipe to the elevated processes (PLAN 5.5, 5.6).
///
/// Two kinds of client connect to it, and each announces itself with a
/// <c>TagHello</c> frame:
///
///  * the <b>service</b>, once, for the life of the session — it is the only
///    process that can run a script as SYSTEM;
///  * a <b>helper</b>, one per desktop, replaced on every desktop switch — it
///    captures and injects on the desktop it is bound to.
///
/// While a helper is attached the applet is a router, not a capturer: helper
/// frames are forwarded to the relay <em>verbatim</em> — same <c>[0x01]</c> /
/// <c>[0x02]</c> tags, no decode, no re-encode — and <c>agent.input</c> is routed
/// to the helper instead of the local desktop, because the Secure Desktop is
/// where the pointer needs to land while a UAC prompt is up.
///
/// The accept loop must never leave the pipe name absent for long: the service's
/// watchdog reads a missing pipe as "the applet is gone" and uninstalls itself
/// (PLAN 5.7). It therefore hands each connection to its own task and goes
/// straight back to listening.
/// </summary>
internal sealed class SecureDesktopBridge : IDisposable
{
    private readonly string _pipeName;
    private readonly IFrameSinkForwarder _forward;
    private readonly Action<string> _onDesktopChanged;
    private readonly Action<string> _notifyUser;
    private readonly Action<string> _onExecResult;
    private readonly CancellationTokenSource _cts = new();

    private Endpoint? _helper;
    private Endpoint? _service;
    private bool _disposed;

    /// <summary>True while a helper is connected — i.e. a non-user desktop is active.</summary>
    public bool HelperAttached => _helper is { Connected: true };

    /// <summary>True once the elevated service has attached and can run SYSTEM scripts.</summary>
    public bool ServiceAttached => _service is { Connected: true };

    public SecureDesktopBridge(
        string pipeName,
        IFrameSinkForwarder forward,
        Action<string> onDesktopChanged,
        Action<string> notifyUser,
        Action<string> onExecResult)
    {
        _pipeName = pipeName;
        _forward = forward;
        _onDesktopChanged = onDesktopChanged;
        _notifyUser = notifyUser;
        _onExecResult = onExecResult;
    }

    public void Start() => _ = Task.Run(() => AcceptLoopAsync(_cts.Token));

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            try
            {
                server = PipeChannel.CreateServer(_pipeName);
                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);

                // Hand it off and go straight back to listening: a helper replaced
                // on a desktop switch connects while the previous one is still
                // draining, and the pipe name must not blink out in between.
                var accepted = server;
                server = null;
                _ = Task.Run(() => HandleAsync(accepted, ct), ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                try { await Task.Delay(250, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
            finally
            {
                server?.Dispose();
            }
        }
    }

    private async Task HandleAsync(NamedPipeServerStream stream, CancellationToken ct)
    {
        var endpoint = new Endpoint(stream);
        var role = "";

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await PipeChannel.ReadFrameAsync(stream, ct).ConfigureAwait(false);
                if (frame is null || frame.Length == 0) return;

                switch (frame[0])
                {
                    case PipeChannel.TagHello:
                        role = PipeChannel.TextOf(frame);
                        if (role == PipeChannel.RoleService) _service = endpoint;
                        else _helper = endpoint;
                        break;

                    case PipeChannel.TagFullFrame:
                    case PipeChannel.TagTileFrame:
                        // Verbatim: the helper already encoded it in the wire format.
                        _forward.Forward(frame);
                        break;

                    case PipeChannel.TagDesktop:
                        _onDesktopChanged(PipeChannel.TextOf(frame));
                        break;

                    case PipeChannel.TagNotice:
                        _notifyUser(PipeChannel.TextOf(frame));
                        break;

                    case PipeChannel.TagExecResult:
                        _onExecResult(PipeChannel.TextOf(frame));
                        break;
                }
            }
        }
        catch (Exception)
        {
            // A helper that died mid-frame is normal on a desktop switch.
        }
        finally
        {
            if (ReferenceEquals(_helper, endpoint))
            {
                _helper = null;
                // The desktop this helper owned is gone; until the next one says
                // otherwise the user's own desktop is what the agent sees again.
                _onDesktopChanged("Default");
            }
            if (ReferenceEquals(_service, endpoint)) _service = null;

            endpoint.Dispose();
        }
    }

    /* ------------------------------------------------------------- to the helper */

    /// <summary>
    /// Route one input message to the helper. False when no helper is attached, so
    /// the caller injects locally instead — the two must never both happen, or a
    /// click lands twice.
    /// </summary>
    public bool TrySendInput(string json) =>
        _helper?.Post(PipeChannel.TextFrame(PipeChannel.TagInput, json)) == true;

    /// <summary>Ctrl+Alt+Del, which only the elevated helper can produce (PLAN 4.3).</summary>
    public bool TrySendSas() => _helper?.Post([PipeChannel.TagSas]) == true;

    /// <summary>Run a script as SYSTEM. False when the service is not attached.</summary>
    public bool TrySendExec(string json) =>
        _service?.Post(PipeChannel.TextFrame(PipeChannel.TagExec, json)) == true;

    /// <summary>
    /// Session end (PLAN 5.7): tell the elevated processes to go, and wait just
    /// long enough for the frame to reach them.
    ///
    /// This is what makes ordinary cleanup immediate rather than eventual. The
    /// applet itself runs as the end user and usually cannot delete a LocalSystem
    /// service — only the short-lived installer child was ever elevated — so
    /// without this the service would linger until its watchdog noticed the pipe
    /// had gone, up to a minute later. The watchdog stays as the backstop for the
    /// case this cannot cover: the applet being killed outright.
    /// </summary>
    public void RequestShutdown(int timeoutMs = 1500)
    {
        var frame = new[] { PipeChannel.TagShutdown };
        _helper?.PostBlocking(frame, timeoutMs);
        _service?.PostBlocking(frame, timeoutMs);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try { _cts.Cancel(); } catch (ObjectDisposedException) { }

        // Closing the pipe is the signal the service watches for: with the applet
        // gone it stops and deletes itself rather than lingering as a SYSTEM
        // service (PLAN 5.7, CLAUDE.md constraint #4).
        _helper?.Dispose();
        _service?.Dispose();
        _helper = null;
        _service = null;

        _cts.Dispose();
    }

    /// <summary>One connected client, with its writes serialised.</summary>
    private sealed class Endpoint : IDisposable
    {
        private readonly NamedPipeServerStream _stream;
        private readonly SemaphoreSlim _writeLock = new(1, 1);
        private volatile bool _closed;

        public Endpoint(NamedPipeServerStream stream) => _stream = stream;

        public bool Connected => !_closed && _stream.IsConnected;

        /// <summary>Queue a frame. Never blocks the caller — input arrives on the socket thread.</summary>
        public bool Post(byte[] frame)
        {
            if (_closed || !_stream.IsConnected) return false;

            _ = Task.Run(async () =>
            {
                try
                {
                    await _writeLock.WaitAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return;   // disposed between the check and the wait
                }

                try
                {
                    if (!_closed && _stream.IsConnected)
                        await PipeChannel.WriteFrameAsync(_stream, frame).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // The peer vanished between the check and the write — a desktop
                    // switch. The next frame goes to the next helper.
                }
                finally
                {
                    try { _writeLock.Release(); } catch (Exception) { }
                }
            });

            return true;
        }

        /// <summary>
        /// Write one frame on the calling thread, giving up after
        /// <paramref name="timeoutMs"/>. Teardown has nowhere to await.
        /// </summary>
        public void PostBlocking(byte[] frame, int timeoutMs)
        {
            if (_closed || !_stream.IsConnected) return;

            var taken = false;
            try
            {
                taken = _writeLock.Wait(timeoutMs);
                if (!taken) return;

                if (!_closed && _stream.IsConnected) PipeChannel.WriteFrame(_stream, frame);
            }
            catch (Exception)
            {
                // The peer is already gone; the watchdog covers it from here.
            }
            finally
            {
                if (taken)
                {
                    try { _writeLock.Release(); } catch (Exception) { }
                }
            }
        }

        /// <summary>
        /// The semaphore is deliberately never disposed: a queued write may still
        /// be waiting on it, and disposing underneath that write turns an ordinary
        /// desktop switch into an unobserved task exception. SemaphoreSlim without
        /// an allocated wait handle holds no unmanaged resource, so the collector
        /// is enough.
        /// </summary>
        public void Dispose()
        {
            _closed = true;
            try { _stream.Dispose(); } catch (Exception) { }
        }
    }
}

/// <summary>
/// Where a helper frame goes. Narrow on purpose: the bridge must be able to
/// forward bytes without holding — or knowing about — the session client.
/// </summary>
internal interface IFrameSinkForwarder
{
    void Forward(ReadOnlyMemory<byte> frame);
}
