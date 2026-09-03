using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// Capture → encode → send loop (PLAN 3.2 and 3.3).
///
/// Runs on its own long-running thread: JPEG encoding a 1080p frame ten times a
/// second must never touch the UI thread, or the End Session button stops
/// responding — which is constraint #3.
///
/// Backpressure is handled by *skipping capture entirely* when a frame is still
/// queued on the socket. A slow link therefore costs frame rate, never a growing
/// queue and never a delayed control message (PLAN 3.2).
///
/// Nothing here starts until the user has consented; <see cref="AppletContext"/>
/// constructs this only after Accept (CLAUDE.md constraint #1).
/// </summary>
internal sealed class ScreenStreamer : IDisposable
{
    /// <summary>PLAN 3.2 targets 8–10 FPS.</summary>
    private const int TargetFps = 10;

    /// <summary>PLAN 3.3: a full keyframe at least this often.</summary>
    private static readonly TimeSpan KeyframeInterval = TimeSpan.FromSeconds(5);

    /// <summary>PLAN 3.2 suggests 60, tunable 40–75.</summary>
    private const long JpegQuality = 60;

    /// <summary>
    /// Past this fraction of changed tiles, one whole-frame JPEG beats many tile
    /// JPEGs: each tile carries its own header and its own encoder overhead.
    /// </summary>
    private const double FullFrameThreshold = 0.6;

    /// <summary>Give up streaming after this many consecutive failures (PLAN 3.8).</summary>
    private const int MaxConsecutiveFailures = 30;

    private readonly IScreenCapture _capture;
    private readonly SessionClient _client;
    private readonly CancellationTokenSource _cts = new();
    private readonly ImageCodecInfo _jpegCodec;
    private readonly EncoderParameters _jpegParams;

    private Task? _loop;
    private bool _disposed;

    /// <summary>Per-tile hashes of the last frame sent; null until the first frame.</summary>
    private ulong[]? _tileHashes;
    private int _tileCols;
    private int _tileRows;

    /// <summary>Reusable copy of the locked frame bits — one allocation, not one per frame.</summary>
    private byte[] _pixels = [];

    private DateTime _lastKeyframeUtc = DateTime.MinValue;
    private bool _forceKeyframe = true;

    public ScreenStreamer(IScreenCapture capture, SessionClient client)
    {
        _capture = capture;
        _client = client;

        _jpegCodec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
        _jpegParams = new EncoderParameters(1)
        {
            Param = { [0] = new EncoderParameter(Encoder.Quality, JpegQuality) },
        };

        if (capture is GdiCapture gdi) gdi.BoundsChanged += _ => _forceKeyframe = true;
    }

    /// <summary>Frames sent and bytes on the wire, for the Phase 3.9 measurement.</summary>
    public long FramesSent { get; private set; }

    public long BytesSent { get; private set; }

    /// <summary>Raised once if capture fails persistently — the session survives it.</summary>
    public event Action<string>? Failed;

    public void Start()
    {
        if (_loop is not null) return;
        _loop = Task.Factory.StartNew(
            () => RunAsync(_cts.Token),
            _cts.Token,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
    }

    /// <summary>Stop capturing. Idempotent, and safe from any thread (PLAN 3.7).</summary>
    public void Stop()
    {
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(1000.0 / TargetFps));
        var failures = 0;

        try
        {
            while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                // PLAN 3.2: skip the frame if the previous send has not completed.
                // Capturing and encoding a frame nobody can send is wasted work.
                if (_client.PendingFrames > 0) continue;

                try
                {
                    if (SendFrame()) failures = 0;
                }
                catch (Exception ex)
                {
                    // PLAN 3.8: a capture failure degrades the stream, it does not
                    // take down the applet or the session.
                    if (++failures >= MaxConsecutiveFailures)
                    {
                        Failed?.Invoke($"screen capture stopped: {ex.GetType().Name}");
                        return;
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>Returns false when there was nothing to capture this tick.</summary>
    private bool SendFrame()
    {
        using var frame = _capture.Grab();

        // Null is normal during a desktop switch (Phase 5) — not a failure.
        if (frame is null) return true;

        var keyframe = _forceKeyframe
            || _tileHashes is null
            || DateTime.UtcNow - _lastKeyframeUtc >= KeyframeInterval;

        var changed = HashTiles(frame, out var changedCount);

        // HashTiles can itself demand a keyframe — an unexpected bitmap layout it
        // refuses to diff.
        keyframe = keyframe || _forceKeyframe;

        if (!keyframe && changedCount == 0) return true;

        if (keyframe || changedCount > _tileCols * _tileRows * FullFrameThreshold)
        {
            SendFull(frame);
            return true;
        }

        foreach (var rect in TileGrid.Coalesce(changed, _tileCols, _tileRows, frame.Width, frame.Height))
        {
            SendTile(frame, rect);
        }

        return true;
    }

    /* ------------------------------------------------------------------- encode */

    private void SendFull(Bitmap frame)
    {
        var jpeg = Encode(frame);
        var payload = new byte[1 + jpeg.Length];
        payload[0] = Protocol.FrameFull;
        jpeg.CopyTo(payload, 1);

        Queue(payload);
        _lastKeyframeUtc = DateTime.UtcNow;
        _forceKeyframe = false;
    }

    private void SendTile(Bitmap frame, Rectangle rect)
    {
        using var tile = frame.Clone(rect, frame.PixelFormat);
        var jpeg = Encode(tile);

        // [0x02][x:u16][y:u16][w:u16][h:u16][jpeg], big-endian (shared/protocol.md).
        var payload = new byte[Protocol.DirtyRectHeaderBytes + jpeg.Length];
        payload[0] = Protocol.FrameDirtyRect;
        WriteBigEndianUInt16(payload, 1, rect.X);
        WriteBigEndianUInt16(payload, 3, rect.Y);
        WriteBigEndianUInt16(payload, 5, rect.Width);
        WriteBigEndianUInt16(payload, 7, rect.Height);
        jpeg.CopyTo(payload, Protocol.DirtyRectHeaderBytes);

        Queue(payload);
    }

    private static void WriteBigEndianUInt16(byte[] buffer, int offset, int value)
    {
        buffer[offset] = (byte)((value >> 8) & 0xFF);
        buffer[offset + 1] = (byte)(value & 0xFF);
    }

    private void Queue(byte[] payload)
    {
        if (!_client.TrySendFrame(payload)) return;
        FramesSent++;
        BytesSent += payload.Length;
    }

    private byte[] Encode(Bitmap bitmap)
    {
        using var buffer = new MemoryStream();
        bitmap.Save(buffer, _jpegCodec, _jpegParams);
        return buffer.ToArray();
    }

    /* -------------------------------------------------------------- dirty rects */

    /// <summary>
    /// Hash every 128×128 tile and mark the ones that changed (PLAN 3.3). FNV-1a
    /// over the raw rows is cheap enough to run inside the frame budget; it is a
    /// change detector, not a security hash.
    /// </summary>
    private bool[] HashTiles(Bitmap frame, out int changedCount)
    {
        _tileCols = TileGrid.Columns(frame.Width);
        _tileRows = TileGrid.Rows(frame.Height);

        var hashes = new ulong[_tileCols * _tileRows];
        var changed = new bool[hashes.Length];
        changedCount = 0;

        var bits = frame.LockBits(
            new Rectangle(0, 0, frame.Width, frame.Height),
            ImageLockMode.ReadOnly,
            frame.PixelFormat);

        try
        {
            // A bottom-up bitmap has a negative stride and Scan0 pointing at the
            // LAST row, so copying `stride * height` bytes forward from it would
            // read off the end of the buffer. Image.FromHbitmap yields top-down,
            // but do not gamble an access violation on that: fall back to sending
            // a full keyframe instead of diffing.
            if (bits.Stride <= 0)
            {
                _forceKeyframe = true;
                changedCount = 0;
                return changed;
            }

            var stride = bits.Stride;
            var needed = stride * frame.Height;
            if (_pixels.Length < needed) _pixels = new byte[needed];

            Marshal.Copy(bits.Scan0, _pixels, 0, needed);

            var bytesPerPixel = Image.GetPixelFormatSize(frame.PixelFormat) / 8;
            if (bytesPerPixel <= 0) bytesPerPixel = 4;

            for (var ty = 0; ty < _tileRows; ty++)
            {
                var y0 = ty * TileGrid.TileSize;
                var y1 = Math.Min(y0 + TileGrid.TileSize, frame.Height);

                for (var tx = 0; tx < _tileCols; tx++)
                {
                    var x0 = tx * TileGrid.TileSize;
                    var widthBytes = (Math.Min(x0 + TileGrid.TileSize, frame.Width) - x0) * bytesPerPixel;

                    var hash = 14695981039346656037UL;
                    for (var y = y0; y < y1; y++)
                    {
                        var start = (y * stride) + (x0 * bytesPerPixel);
                        for (var i = 0; i < widthBytes; i++)
                        {
                            hash = (hash ^ _pixels[start + i]) * 1099511628211UL;
                        }
                    }

                    var index = (ty * _tileCols) + tx;
                    hashes[index] = hash;

                    if (_tileHashes is null || _tileHashes.Length != hashes.Length ||
                        _tileHashes[index] != hash)
                    {
                        changed[index] = true;
                        changedCount++;
                    }
                }
            }
        }
        finally
        {
            frame.UnlockBits(bits);
        }

        _tileHashes = hashes;
        return changed;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        Stop();

        // The loop owns nothing the caller needs back; give it a moment to exit so
        // the capture surfaces are not disposed from under it.
        try { _loop?.Wait(TimeSpan.FromSeconds(2)); } catch (Exception) { }

        _cts.Dispose();
        _jpegParams.Dispose();
        _capture.Dispose();
    }
}
