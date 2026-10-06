// Platform 2.0: quality profiles throttle the streamer through its own backpressure
// signal (FrameRateLimiter) — no frame is dropped by the limiter, ever.
using HelpdeskAnywhere.Applet.Capture;
using HelpdeskAnywhere.Applet.Features;

var failed = 0;
void Check(string name, bool ok, string d = "") { if (!ok) failed++; Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(d.Length > 0 ? "  — " + d : "")}"); }
Console.WriteLine("\n=== FrameRateLimiter ===\n");

var sink = new FakeSink();
var rate = new FrameRateLimiter(sink);

// Simulate the streamer: a 10 fps tick that skips when PendingFrames > 0.
int Run(int seconds)
{
    var sent = 0;
    var until = DateTime.UtcNow.AddSeconds(seconds);
    while (DateTime.UtcNow < until)
    {
        if (rate.PendingFrames == 0 && rate.TrySendFrame(new byte[] { 1 })) sent++;
        Thread.Sleep(100);
    }
    return sent;
}

Check("default profile is the streamer's own rate (high)", rate.Profile == "high" && FrameRateLimiter.FpsFor("high") == 10);
var high = Run(2);
Check("high: every tick sends (~20 in 2 s)", high >= 17, high.ToString());
rate.SetProfile("low");
var low = Run(2);
Check("low: 2 fps (~4 in 2 s)", low >= 3 && low <= 5, low.ToString());
rate.SetProfile("balanced");
var bal = Run(2);
Check("balanced: 5 fps (~10 in 2 s)", bal >= 9 && bal <= 11, bal.ToString());
Check("every frame offered was passed on (nothing dropped by the limiter)", sink.Received == high + low + bal, $"{sink.Received} vs {high + low + bal}");
sink.Pending = 1;
Check("the inner sink's own backpressure still wins", rate.PendingFrames == 1);
sink.Pending = 0;
rate.SetProfile("nonsense");
Check("an unknown profile falls back to high", rate.Profile == "high");

Console.WriteLine($"\n--- QualityTests: {(failed == 0 ? "all passed" : $"{failed} failed")} ---");
return failed == 0 ? 0 : 1;

sealed class FakeSink : IFrameSink
{
    public int Pending;
    public int Received;
    public int PendingFrames => Pending;
    public bool TrySendFrame(ReadOnlyMemory<byte> frame) { Received++; return true; }
}
