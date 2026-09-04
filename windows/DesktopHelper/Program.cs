using System.IO.Pipes;
using System.Text.Json;

using HelpdeskAnywhere.Applet.Capture;
using HelpdeskAnywhere.Applet.Input;
using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.DesktopHelper;

/// <summary>
/// Captures and injects input on one named desktop (PLAN 5.4).
///
/// Launched by <c>SecureDesktopService</c> as SYSTEM inside the user's session,
/// with <c>--desktop Winlogon --pipe &lt;name&gt;</c>. One helper exists per
/// active desktop and dies when that desktop stops being the input desktop.
///
/// It reuses <c>GdiCapture</c>, <c>ScreenStreamer</c> and <c>InputInjector</c>
/// verbatim — the same source files, compiled in — which is what PLAN 5.4 means
/// by "reuse the exact same GdiCapture and InputInjector from Phases 3-4". The
/// only difference from the applet's own streaming is where the frames go: a
/// named pipe instead of a WebSocket, behind the same <c>IFrameSink</c>.
/// </summary>
internal static class Program
{
    /// <summary>
    /// Entry point for the <c>--desktop-helper</c> mode of the single shipped
    /// binary (DECISIONS.md D-009), and for this project's own standalone .exe.
    /// </summary>
    internal static int Run(string[] args)
    {
        var desktop = ValueOf(args, "--desktop") ?? "Default";
        var pipe = ValueOf(args, "--pipe");

        if (string.IsNullOrWhiteSpace(pipe)) return 87;  // ERROR_INVALID_PARAMETER

        // CRITICAL ORDERING (PLAN 5.4). SetThreadDesktop binds the CALLING THREAD,
        // and every DC and bitmap inherits the desktop that was current when it
        // was created. Do this after creating anything and the capture reads the
        // wrong desktop with no error at all — just the wrong pixels.
        var handle = Desktops.OpenDesktop(desktop, 0, false, Desktops.GENERIC_ALL);
        if (handle == IntPtr.Zero) return 2;

        try
        {
            if (!Desktops.SetThreadDesktop(handle)) return 3;
            return Run(desktop, pipe);
        }
        finally
        {
            Desktops.CloseDesktop(handle);
        }
    }

    private static int Run(string desktop, string pipeName)
    {
        using var cts = new CancellationTokenSource();
        using var client = PipeChannel.CreateClient(pipeName);

        try
        {
            // The applet may still be setting its listener up when the service
            // starts the first helper, so this waits rather than failing.
            client.Connect(15_000);
        }
        catch (Exception)
        {
            return 4;
        }

        var sink = new PipeFrameSink(client);

        // Say which kind of client this is, first: the service connects to the
        // same pipe, and the applet routes input to helpers and SYSTEM scripts to
        // the service (PLAN 5.5).
        sink.Post(PipeChannel.TextFrame(PipeChannel.TagHello, PipeChannel.RoleHelper));

        // Tell the applet which desktop it is now looking at, before any frame
        // arrives: the console's "UAC prompt active" banner and the applet's
        // decision to pause its own capture both hang off this (PLAN 5.6).
        sink.Post(PipeChannel.TextFrame(PipeChannel.TagDesktop, desktop));

        using var capture = new GdiCapture();
        var injector = new InputInjector(capture);
        using var streamer = new ScreenStreamer(capture, sink);
        streamer.Failed += reason => sink.Post(PipeChannel.TextFrame(PipeChannel.TagNotice, reason));
        streamer.Start();

        try
        {
            ReadCommandsAsync(client, injector, cts.Token).GetAwaiter().GetResult();
        }
        catch (Exception)
        {
            // A dead pipe is the ordinary way this process ends.
        }
        finally
        {
            // A helper that vanishes mid-drag must not leave the secure desktop
            // holding a mouse button or a modifier (PLAN 4.2).
            injector.ReleaseAll();
            cts.Cancel();
        }

        return 0;
    }

    /// <summary>
    /// Input from the applet, until the pipe closes or a shutdown arrives.
    /// </summary>
    private static async Task ReadCommandsAsync(
        NamedPipeClientStream client, InputInjector injector, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var frame = await PipeChannel.ReadFrameAsync(client, ct).ConfigureAwait(false);
            if (frame is null || frame.Length == 0) return;

            switch (frame[0])
            {
                case PipeChannel.TagInput:
                    var input = JsonSerializer.Deserialize<AgentInput>(
                        PipeChannel.TextOf(frame), Protocol.Json);
                    if (input is not null) injector.Handle(input);
                    break;

                case PipeChannel.TagSas:
                    // PLAN 4.3: no injected key sequence can produce this. Only a
                    // SYSTEM process may ask Windows to generate it.
                    Desktops.SendSAS(false);
                    break;

                case PipeChannel.TagShutdown:
                    return;
            }
        }
    }

    private static string? ValueOf(string[] args, string flag)
    {
        var i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}

/// <summary>
/// <see cref="ScreenStreamer"/>'s output, aimed at the pipe instead of a socket.
///
/// The queue is what gives the streamer its backpressure signal: while a frame is
/// still waiting to go out, capture is skipped entirely, so a stalled pipe costs
/// frame rate rather than growing without bound (PLAN 3.2).
/// </summary>
internal sealed class PipeFrameSink : IFrameSink
{
    private readonly NamedPipeClientStream _pipe;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private int _pending;

    public PipeFrameSink(NamedPipeClientStream pipe) => _pipe = pipe;

    public int PendingFrames => Volatile.Read(ref _pending);

    public bool TrySendFrame(ReadOnlyMemory<byte> frame)
    {
        if (!_pipe.IsConnected) return false;

        Interlocked.Increment(ref _pending);
        _ = WriteAsync(frame).ContinueWith(
            _ => Interlocked.Decrement(ref _pending), TaskScheduler.Default);
        return true;
    }

    /// <summary>Fire-and-forget for the small control frames, which never queue.</summary>
    public void Post(byte[] frame) => _ = WriteAsync(frame);

    private async Task WriteAsync(ReadOnlyMemory<byte> frame)
    {
        await _lock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_pipe.IsConnected) await PipeChannel.WriteFrameAsync(_pipe, frame).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The applet ended the session; this process is about to exit anyway.
        }
        finally
        {
            _lock.Release();
        }
    }
}
