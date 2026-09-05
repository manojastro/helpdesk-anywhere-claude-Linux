using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
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
        // EARLIEST POSSIBLE (MT-06). Before any validation or Win32 call, so a
        // helper that dies during startup still leaves a trace. Until the pipe
        // connects, the applet's unified log cannot receive a single helper line —
        // so this staging file is the ONLY record of every pre-pipe failure, and
        // "no [helper] lines anywhere" was the symptom that made MT-06 undiagnosable.
        DiagLog.Start("helper", DiagPaths.Elevated);
        DiagLog.Write("helper.entry", "HELPER ENTRY REACHED",
            $"args=[{string.Join(" ", args)}] startupDesktop={Desktops.ThreadDesktopName()} " +
            $"session={CurrentSessionId()}");

        try
        {
            return RunCore(args);
        }
        catch (Exception ex)
        {
            // An exception before the pipe connects never reaches the applet, so it
            // has to land here with enough to name the failing call. Type, message
            // and stack — never anything from the wire, which the helper does not
            // hold anyway (constraint #6).
            DiagLog.Write("helper.crash", "UNHANDLED EXCEPTION in helper startup",
                $"{ex.GetType().FullName}: {ex.Message}");
            DiagLog.Write("helper.crash", "stack", ex.StackTrace?.Replace("\r", "").Replace("\n", " | ") ?? "(none)");
            return 99;
        }
    }

    private static int RunCore(string[] args)
    {
        var desktop = ValueOf(args, "--desktop") ?? "Default";
        var pipe = ValueOf(args, "--pipe");

        if (string.IsNullOrWhiteSpace(pipe))
        {
            DiagLog.Write("helper.args", "MISSING --pipe ARGUMENT — cannot connect to the applet");
            return 87;  // ERROR_INVALID_PARAMETER
        }

        DiagLog.Write("helper.args", "ARGS PARSED", $"desktop={desktop} pipe={pipe}");

        // WHY THERE IS A CHOICE HERE — MT-06, third Windows run, exitCode=3.
        //
        // The watcher launches this process with
        // STARTUPINFO.lpDesktop = "WinSta0\<desktop>", and Windows associates a
        // process — and therefore its primary thread — with that desktop AT
        // CREATION. So by the time this code runs the thread is ALREADY on the
        // requested desktop, and the SetThreadDesktop call that used to be
        // unconditional was redundant.
        //
        // Worse than redundant: it could not succeed. SetThreadDesktop fails if
        // the calling thread owns any window or hook on its current desktop, and
        // this thread does — Main is [STAThread], so OLE initialises an STA and
        // creates its hidden message window before Main is even entered. Every
        // helper therefore died at SetThreadDesktop, ~320ms in, with exit code 3,
        // before the pipe or any capture was reached.
        //
        // So: bind only when a bind is actually needed, and prove the binding
        // either way before creating a single DC (PLAN 5.4 — a DC inherits the
        // desktop of the thread that created it, and getting that wrong produces
        // the wrong pixels with no error at all).
        var current = Desktops.ThreadDesktopName();
        DiagLog.Write("helper.desktop", "desktop state at entry",
            $"target={desktop} current={(current.Length == 0 ? "(unreadable)" : current)} " +
            $"threadId={Desktops.GetCurrentThreadId()} session={CurrentSessionId()}");

        if (string.Equals(current, desktop, StringComparison.OrdinalIgnoreCase))
        {
            // CreateProcess already put us here. Touching SetThreadDesktop now
            // would only reintroduce the failure it used to cause.
            DiagLog.Write("helper.desktop", "DESKTOP_ALREADY_BOUND",
                $"desktop={desktop} — placed by STARTUPINFO.lpDesktop at process creation; " +
                "SetThreadDesktop skipped (it would fail: this thread owns the STA message window)");

            return VerifyThenRun(desktop, pipe);
        }

        // Not where we were asked to be. This is the path that genuinely needs a
        // switch, and it can only work on a thread with no windows yet.
        DiagLog.Write("helper.desktop", "desktop switch required",
            $"target={desktop} current={(current.Length == 0 ? "(unreadable)" : current)}");

        var handle = Desktops.OpenDesktop(desktop, 0, false, Desktops.GENERIC_ALL);
        if (handle == IntPtr.Zero)
        {
            DiagLog.Win32("helper.desktop", "OpenDesktop", Marshal.GetLastWin32Error(),
                $"desktop={desktop} — SYSTEM should be able to open Winlogon; if this is 5, the helper is not SYSTEM");
            return 2;
        }

        DiagLog.Write("helper.desktop", "OPEN_DESKTOP_OK", $"desktop={desktop}");

        if (!Desktops.SetThreadDesktop(handle))
        {
            // Capture the error immediately: anything else on this line could
            // overwrite it before it is read.
            var error = Marshal.GetLastWin32Error();
            DiagLog.Write("helper.desktop", "SET_THREAD_DESKTOP_FAILED",
                $"target={desktop} current={(current.Length == 0 ? "(unreadable)" : current)} " +
                $"win32Error={error} humanReadableError={DiagLog.Describe(error)}");

            // Nothing is bound to it, so the handle is safe to release here.
            Desktops.CloseDesktop(handle);
            return 3;
        }

        DiagLog.Write("helper.desktop", "SET_THREAD_DESKTOP_OK", $"desktop={desktop}");

        try
        {
            return VerifyThenRun(desktop, pipe);
        }
        finally
        {
            // Held open for as long as the thread is assigned to this desktop:
            // CloseDesktop fails while a thread is still using the handle, so it
            // is released only once the session is over and this process is
            // exiting.
            Desktops.CloseDesktop(handle);
        }
    }

    /// <summary>
    /// Prove the thread really is on the desktop we were asked for, then start
    /// capturing. Never assume the binding worked: a capture on the wrong desktop
    /// produces plausible-looking frames of the wrong screen, which is the single
    /// hardest failure in this project to spot from the technician's side.
    /// </summary>
    private static int VerifyThenRun(string desktop, string pipe)
    {
        var bound = Desktops.ThreadDesktopName();
        if (!string.Equals(bound, desktop, StringComparison.OrdinalIgnoreCase))
        {
            DiagLog.Write("helper.desktop", "DESKTOP_VERIFY_FAILED",
                $"target={desktop} actual={(bound.Length == 0 ? "(unreadable)" : bound)} — " +
                "refusing to capture: this would stream the wrong desktop");
            return 5;
        }

        DiagLog.Write("helper.desktop", "DESKTOP_VERIFIED",
            $"desktop={bound} — safe to create the capture surfaces");

        return Run(desktop, pipe);
    }

    private static string CurrentSessionId()
    {
        try { return Process.GetCurrentProcess().SessionId.ToString(); }
        catch (Exception) { return "?"; }
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
        catch (Exception ex)
        {
            DiagLog.Write("helper.pipe", "could not connect to the applet",
                $"pipe={pipeName} {ex.GetType().Name}");
            return 4;
        }

        DiagLog.Write("helper.pipe", "connected to the applet", $"pipe={pipeName}");

        var sink = new PipeFrameSink(client);

        // Ship this helper's diagnostics into the applet's log too: the copy in
        // the staging directory goes when the service uninstalls itself (MT-06).
        DiagLog.ShipTo(line => sink.Post(PipeChannel.TextFrame(PipeChannel.TagDiag, line)));

        // Say which kind of client this is, first: the service connects to the
        // same pipe, and the applet routes input to helpers and SYSTEM scripts to
        // the service (PLAN 5.5).
        sink.Post(PipeChannel.TextFrame(PipeChannel.TagHello, PipeChannel.RoleHelper));

        // Tell the applet which desktop it is now looking at, before any frame
        // arrives: the console's "UAC prompt active" banner and the applet's
        // decision to pause its own capture both hang off this (PLAN 5.6).
        sink.Post(PipeChannel.TextFrame(PipeChannel.TagDesktop, desktop));

        using var capture = new GdiCapture();
        DiagLog.Write("helper.capture", "GDI capture initialised",
            $"boundDesktop={capture.BoundDesktop} bounds={capture.Bounds.Width}x{capture.Bounds.Height}");

        if (capture.Bounds.Width <= 0 || capture.Bounds.Height <= 0)
        {
            DiagLog.Write("helper.capture", "capture bounds are ZERO — nothing can be captured",
                $"desktop={desktop}");
        }

        var injector = new InputInjector(capture);
        using var streamer = new ScreenStreamer(capture, sink);
        streamer.Failed += reason => sink.Post(PipeChannel.TextFrame(PipeChannel.TagNotice, reason));
        streamer.Start();

        // The single most useful line in an MT-06 log: whether this helper ever
        // produced a picture at all, and how long it took.
        using var frameReport = new System.Threading.Timer(
            _ =>
            {
                DiagLog.Write("helper.capture", "frame report",
                    $"desktop={desktop} sent={streamer.FramesSent} bytes={streamer.BytesSent} " +
                    $"suppressed={capture.SuppressedFrames} " +
                    $"(suppressed climbing means this desktop no longer owns the display)");
            },
            null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(10));

        DiagLog.Write("helper.ready", "input injection ready", $"desktop={desktop}");

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

            DiagLog.Write("helper.stop", "helper exiting",
                $"desktop={desktop} framesSent={streamer.FramesSent} suppressed={capture.SuppressedFrames}");
            DiagLog.StopShipping();
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
                    DiagLog.Write("helper.input", "SendSAS requested by the agent");
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
