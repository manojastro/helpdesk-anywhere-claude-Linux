using HelpdeskAnywhere.Applet.Capture;

namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// Stream quality profiles (Platform 2.0) WITHOUT touching the verified capture
/// code. <see cref="ScreenStreamer"/> already skips a capture tick whenever its
/// sink reports a frame pending (PLAN 3.2 backpressure). This sink sits between
/// the streamer and the socket and reports "pending" for a cool-down after each
/// frame, so the streamer simply captures less often — no frame is ever dropped
/// half-way, the dirty-rect diff stays against what was really sent, and the
/// picture stays exact. JPEG quality is unchanged (it lives in the golden
/// streamer); the profiles trade frame rate for bandwidth.
///
/// The Secure Desktop helper's frames do not pass through here: they reach the
/// socket on their own path, so UAC prompts always stream at full rate.
/// </summary>
internal sealed class FrameRateLimiter : IFrameSink
{
    private readonly IFrameSink _inner;
    private long _minIntervalTicks;   // 0 = no limit (the streamer's own 10 fps)
    private long _nextAllowedTicks;

    public FrameRateLimiter(IFrameSink inner) => _inner = inner;

    /// <summary>The streamer's capture tick (ScreenStreamer.TargetFps = 10).</summary>
    private const long TickTicks = TimeSpan.TicksPerSecond / 10;

    /// <summary>
    /// Frames per second for each profile; "high" is the streamer's own rate. The
    /// others divide the 100 ms tick evenly, so the rate reported to the technician
    /// is the rate actually delivered.
    /// </summary>
    public static int FpsFor(string profile) => profile switch
    {
        "balanced" => 5,
        "low" => 2,
        _ => 10,
    };

    public string Profile { get; private set; } = "high";

    public void SetProfile(string profile)
    {
        var fps = FpsFor(profile);
        Profile = fps == 10 ? "high" : profile;
        // Half a tick of slack: timer jitter must not push a frame to the tick after.
        Interlocked.Exchange(ref _minIntervalTicks, fps >= 10 ? 0 : TimeSpan.TicksPerSecond / fps - TickTicks / 2);
    }

    public int PendingFrames
    {
        get
        {
            var pending = _inner.PendingFrames;
            if (pending > 0) return pending;
            return DateTime.UtcNow.Ticks < Interlocked.Read(ref _nextAllowedTicks) ? 1 : 0;
        }
    }

    public bool TrySendFrame(ReadOnlyMemory<byte> frame)
    {
        var min = Interlocked.Read(ref _minIntervalTicks);
        if (min > 0) Interlocked.Exchange(ref _nextAllowedTicks, DateTime.UtcNow.Ticks + min);
        return _inner.TrySendFrame(frame);
    }
}
