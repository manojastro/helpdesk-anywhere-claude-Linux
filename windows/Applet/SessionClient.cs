using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet;

/// <summary>
/// Transport to the relay (PLAN 2.3): one <see cref="ClientWebSocket"/> dialled
/// *out* to <c>wss://&lt;server&gt;/ws</c>, so the end user needs no inbound
/// firewall rule or NAT traversal (CLAUDE.md architecture).
///
/// Two queues, not one: control messages are unbounded and always drained first,
/// while screen frames sit in a tiny bounded queue that drops its oldest entry
/// when the uplink is slow. A stalled uplink therefore costs a dropped frame,
/// never a delayed "End Session" (PLAN 2.3 "video frames never block control").
///
/// Every event is raised on the UI thread through the captured
/// <see cref="SynchronizationContext"/>, so handlers can touch forms directly.
/// </summary>
internal sealed class SessionClient : IAsyncDisposable
{
    /// <summary>Attempts for the *initial* connect only — see <see cref="ConnectAsync"/>.</summary>
    private const int MaxConnectAttempts = 4;

    private const int ReceiveChunkBytes = 16 * 1024;

    /// <summary>Mirrors <c>MAX_CONTROL_BYTES</c> in <c>signaling.ts</c>.</summary>
    private const int MaxControlBytes = 256 * 1024;

    private readonly Uri _server;
    private readonly SynchronizationContext _ui;

    private readonly Channel<ReadOnlyMemory<byte>> _control =
        Channel.CreateUnbounded<ReadOnlyMemory<byte>>(new UnboundedChannelOptions
        {
            SingleReader = true,
        });

    private readonly Channel<ReadOnlyMemory<byte>> _frames =
        Channel.CreateBounded<ReadOnlyMemory<byte>>(new BoundedChannelOptions(2)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });

    private ClientWebSocket? _ws;
    private CancellationTokenSource? _loops;
    private Task? _receiveLoop;
    private Task? _sendLoop;
    private int _stopped;

    public SessionClient(Uri server, SynchronizationContext ui)
    {
        _server = server;
        _ui = ui;
    }

    /// <summary>The URL actually dialled — used for the plaintext warning in the UI.</summary>
    public Uri Server => _server;

    /// <summary>True while the socket is usable — a refused code leaves it open.</summary>
    public bool IsOpen => Volatile.Read(ref _stopped) == 0 && _ws?.State == WebSocketState.Open;

    /// <summary>True when the connection is TLS-protected (CLAUDE.md "Public URL and TLS").</summary>
    public bool IsSecure => _server.Scheme == Uri.UriSchemeHttps || _server.Scheme == "wss";

    /* ------------------------------------------------------------------- events */

    /// <summary>The code was accepted; the consent dialog names <c>agentName</c>.</summary>
    public event Action<HostConnectRequest>? ConnectRequested;

    /// <summary>Server-side refusal — bad code, expired code, rate limit, protocol.</summary>
    public event Action<ProtocolError>? ErrorReceived;

    /// <summary>The agent console attached (after consent) — <c>peer.joined</c>.</summary>
    public event Action? AgentJoined;

    /// <summary>The other side went away — <c>peer.left</c>.</summary>
    public event Action<string>? PeerLeft;

    /// <summary>Socket closed or failed. Raised once, whatever the cause.</summary>
    public event Action<string>? Closed;

    /// <summary>
    /// Control messages this phase does not consume — input (Phase 4), elevation
    /// (Phase 5), exec (Phase 6). Carries the discriminator and the raw JSON so
    /// later phases can deserialise without another dispatch layer here.
    /// </summary>
    public event Action<string, string>? Unhandled;

    /* ------------------------------------------------------------------ connect */

    /// <summary>
    /// Connect with exponential backoff (PLAN 2.3).
    ///
    /// Retries apply to the *initial* dial only. Once a session exists, a dropped
    /// socket is not a transient blip: the relay tears the session down the moment
    /// either peer disappears and burns the code (`signaling.ts` teardown), so
    /// there is nothing to reconnect to. That path hard-stops instead — the
    /// "hard-stop and exit if the session is ended" half of PLAN 2.3.
    /// </summary>
    public async Task ConnectAsync(CancellationToken ct)
    {
        var delay = TimeSpan.FromMilliseconds(500);

        for (var attempt = 1; ; attempt++)
        {
            var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);

            try
            {
                await ws.ConnectAsync(_server, ct).ConfigureAwait(true);
                _ws = ws;
                break;
            }
            catch (Exception) when (attempt < MaxConnectAttempts && !ct.IsCancellationRequested)
            {
                ws.Dispose();
                await Task.Delay(delay, ct).ConfigureAwait(true);
                delay *= 2;
            }
            catch
            {
                ws.Dispose();
                throw;
            }
        }

        _loops = new CancellationTokenSource();
        _receiveLoop = Task.Run(() => ReceiveLoopAsync(_loops.Token));
        _sendLoop = Task.Run(() => SendLoopAsync(_loops.Token));
    }

    /* --------------------------------------------------------------------- send */

    /// <summary>Queue a control message. Serialised on the caller's static type.</summary>
    public void Send<T>(T message)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(message, Protocol.Json);
        _control.Writer.TryWrite(json);
    }

    /// <summary>
    /// Queue a screen frame (Phase 3). Returns false when the frame was dropped
    /// because the uplink is behind — by design; the next frame supersedes it.
    /// </summary>
    public bool TrySendFrame(ReadOnlyMemory<byte> frame) => _frames.Writer.TryWrite(frame);

    /// <summary>
    /// PLAN 2.3: identify this machine to the agent console. Nothing here is
    /// sensitive, and nothing is captured before consent (constraint #1).
    /// </summary>
    public void SendJoin(string code) => Send(new HostJoin
    {
        Code = code,
        Machine = Environment.MachineName,
        User = Environment.UserName,
        Os = RuntimeInformation.OSDescription,
    });

    public void SendConsent(bool accepted) => Send(new HostConsent { Accepted = accepted });

    private async Task SendLoopAsync(CancellationToken ct)
    {
        var ws = _ws!;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (_control.Reader.TryRead(out var control))
                {
                    await ws.SendAsync(control, WebSocketMessageType.Text, true, ct)
                        .ConfigureAwait(false);
                    continue;
                }

                if (_frames.Reader.TryRead(out var frame))
                {
                    await ws.SendAsync(frame, WebSocketMessageType.Binary, true, ct)
                        .ConfigureAwait(false);
                    continue;
                }

                // Nothing queued anywhere: wait for whichever side fills first.
                var controlReady = _control.Reader.WaitToReadAsync(ct).AsTask();
                var frameReady = _frames.Reader.WaitToReadAsync(ct).AsTask();
                await Task.WhenAny(controlReady, frameReady).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Stop($"send failed: {ex.GetType().Name}");
        }
    }

    /* ------------------------------------------------------------------ receive */

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var ws = _ws!;
        var chunk = new byte[ReceiveChunkBytes];
        var buffer = new MemoryStream();

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(chunk, ct).ConfigureAwait(false);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Stop(ws.CloseStatusDescription is { Length: > 0 } d
                        ? d
                        : "the server closed the connection");
                    return;
                }

                buffer.Write(chunk, 0, result.Count);

                if (buffer.Length > MaxControlBytes)
                {
                    Stop("the server sent an oversized message");
                    return;
                }

                if (!result.EndOfMessage) continue;

                var payload = buffer.ToArray();
                buffer.SetLength(0);

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    Dispatch(Encoding.UTF8.GetString(payload));
                }

                // Binary frames only ever travel host → agent; anything arriving
                // the other way is not part of the protocol and is ignored.
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Stop($"connection lost ({ex.GetType().Name})");
        }
    }

    private void Dispatch(string json)
    {
        string t;
        try
        {
            t = JsonSerializer.Deserialize<Envelope>(json, Protocol.Json)?.T ?? "";
        }
        catch (JsonException)
        {
            return;
        }

        switch (t)
        {
            case Protocol.T.HostConnectRequest:
                var request = JsonSerializer.Deserialize<HostConnectRequest>(json, Protocol.Json);
                if (request is not null) Post(ConnectRequested, request);
                break;

            case Protocol.T.Error:
                var error = JsonSerializer.Deserialize<ProtocolError>(json, Protocol.Json);
                if (error is not null) Post(ErrorReceived, error);
                break;

            case Protocol.T.PeerJoined:
                Post(AgentJoined);
                break;

            case Protocol.T.PeerLeft:
                Post(PeerLeft, "the support agent");
                break;

            default:
                Post(Unhandled, t, json);
                break;
        }
    }

    /* -------------------------------------------------------------------- close */

    /// <summary>
    /// Close politely and stop the loops. Idempotent, and safe to call from any
    /// thread — every exit path in <c>Program</c> funnels through here.
    /// </summary>
    public async Task CloseAsync(string reason)
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;

        var ws = _ws;
        if (ws is not null && ws.State == WebSocketState.Open)
        {
            // Let anything already queued — a consent decline, most often — reach
            // the wire before the socket goes away.
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(1);
            while (_control.Reader.Count > 0 && DateTime.UtcNow < deadline)
            {
                await Task.Delay(20).ConfigureAwait(false);
            }
            await Task.Delay(50).ConfigureAwait(false);

            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, reason, timeout.Token)
                    .ConfigureAwait(false);
            }
            catch
            {
                // Best effort: the relay tears the session down on the drop anyway.
            }
        }

        Cancel();
    }

    /// <summary>
    /// Synchronous, non-blocking teardown for process exit and crash paths
    /// (PLAN 2.4), where there is no time to await a polite close.
    /// </summary>
    public void Abort()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        Cancel();
    }

    private void Cancel()
    {
        try { _loops?.Cancel(); } catch (ObjectDisposedException) { }
        try { _ws?.Abort(); } catch { }
    }

    /// <summary>Terminal failure from inside a loop: stop, then tell the UI once.</summary>
    private void Stop(string reason)
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        Cancel();
        Post(Closed, reason);
    }

    public async ValueTask DisposeAsync()
    {
        Abort();

        foreach (var loop in new[] { _receiveLoop, _sendLoop })
        {
            if (loop is null) continue;
            try { await loop.ConfigureAwait(false); } catch { }
        }

        _loops?.Dispose();
        _ws?.Dispose();
    }

    /* ------------------------------------------------------------ UI marshalling */

    private void Post(Action? handler)
    {
        if (handler is not null) _ui.Post(_ => handler(), null);
    }

    private void Post<T>(Action<T>? handler, T arg)
    {
        if (handler is not null) _ui.Post(_ => handler(arg), null);
    }

    private void Post<T1, T2>(Action<T1, T2>? handler, T1 a, T2 b)
    {
        if (handler is not null) _ui.Post(_ => handler(a, b), null);
    }
}
