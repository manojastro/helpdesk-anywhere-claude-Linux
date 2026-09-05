using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace HelpdeskAnywhere.Shared;

/// <summary>
/// Length-prefixed framing over the named pipe between <c>Applet</c> and
/// <c>DesktopHelper</c> (PLAN 5.5).
///
/// Payloads use the same <c>[0x01]</c>/<c>[0x02]</c> tags as the WS protocol, so
/// the applet can forward helper frames to the server without re-encoding.
///
/// Named with a per-session GUID, so nothing about it outlives the session.
///
/// SECURITY (PLAN 5.5, do not skip): the pipe is created with a
/// <c>PipeSecurity</c> ACL allowing only LocalSystem and the user who owns the
/// session. A world-writable pipe carrying input events into a SYSTEM process is
/// a local privilege-escalation hole — any other user on the machine could drive
/// the keyboard of a SYSTEM process. See <see cref="CreateServer"/>.
/// </summary>
public static class PipeChannel
{
    /// <summary>Frames larger than this are rejected as corrupt.</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;

    /* ------------------------------------------------------------------- tags */
    //
    // The video tags are deliberately the SAME bytes as the WebSocket protocol
    // (`shared/protocol.md`), so the applet forwards a helper frame to the relay
    // without decoding or re-encoding it — which is both faster and one fewer
    // place for the two formats to drift apart (PLAN 5.5).

    /// <summary>Helper → applet: full JPEG frame, forwarded verbatim to the relay.</summary>
    public const byte TagFullFrame = 0x01;

    /// <summary>Helper → applet: dirty-rect tile, forwarded verbatim to the relay.</summary>
    public const byte TagTileFrame = 0x02;

    /// <summary>Applet → helper: a JSON <c>agent.input</c> to inject on this desktop.</summary>
    public const byte TagInput = 0x10;

    /// <summary>
    /// Applet → helper: Ctrl+Alt+Del. Its own tag rather than an input frame,
    /// because no sequence of injected keys can produce a Secure Attention
    /// Sequence — the helper calls <c>SendSAS()</c> instead (PLAN 4.3).
    /// </summary>
    public const byte TagSas = 0x11;

    /// <summary>Applet → service: a JSON <c>agent.exec</c> to run as SYSTEM.</summary>
    public const byte TagExec = 0x12;

    /// <summary>Applet → helper/service: stop and exit.</summary>
    public const byte TagShutdown = 0x1F;

    /// <summary>Helper → applet: UTF-8 desktop name, drives <c>host.desktopChanged</c>.</summary>
    public const byte TagDesktop = 0x20;

    /// <summary>Helper → applet: a UTF-8 status or error line for the indicator.</summary>
    public const byte TagNotice = 0x21;

    /// <summary>Service → applet: a JSON <c>host.execResult</c>, forwarded verbatim.</summary>
    public const byte TagExecResult = 0x22;

    /// <summary>
    /// Elevated process → applet: one <see cref="DiagLog"/> line (MT-06).
    ///
    /// The service and the helper run in places nobody can watch — session 0 and
    /// the Winlogon desktop — and the staging directory they can write to is
    /// deleted when the service uninstalls itself. Shipping each line to the
    /// applet puts the whole four-process chronology in one user-readable file
    /// that outlives the session, which is what makes MT-06 diagnosable in one
    /// run instead of three.
    ///
    /// Diagnostics only. Never a credential, a keystroke or a script (constraint #6).
    /// </summary>
    public const byte TagDiag = 0x23;

    /// <summary>
    /// First frame on every connection, naming the sender: <c>helper</c> or
    /// <c>service</c>. Two different processes connect to the same pipe and want
    /// different traffic — input goes to whichever helper owns the current
    /// desktop, SYSTEM scripts go to the service — so the applet has to be able
    /// to tell them apart, and a first frame is cheaper than a second pipe.
    /// </summary>
    public const byte TagHello = 0x30;

    public const string RoleHelper = "helper";
    public const string RoleService = "service";

    /// <summary>
    /// The in-session desktop watcher (MT-06 fix). It connects only to ship
    /// diagnostics and to announce desktop transitions the moment it sees them —
    /// it never streams frames and never receives input, so the applet must not
    /// treat it as a helper and start routing clicks to it.
    /// </summary>
    public const string RoleWatcher = "watcher";

    /* ---------------------------------------------------------------- endpoints */

    /// <summary>
    /// The applet's end of the pipe, ACL'd to LocalSystem and the current user
    /// only (PLAN 5.5).
    ///
    /// Several server instances are allowed on purpose: on a desktop switch a new
    /// helper connects while the previous one is still being torn down, and with
    /// a single instance that overlap would either fail or leave the pipe name
    /// briefly absent — which the service's watchdog reads as "the applet is
    /// gone" and acts on by uninstalling itself.
    /// </summary>
    public static NamedPipeServerStream CreateServer(string name, int maxInstances = 4)
    {
        var security = new PipeSecurity();

        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        // The user who is being helped: they own the applet process at the other
        // end. Everyone else — including other logged-on users — is left out.
        using var identity = WindowsIdentity.GetCurrent();
        if (identity.User is not null)
        {
            security.AddAccessRule(new PipeAccessRule(
                identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
        }

        return NamedPipeServerStreamAcl.Create(
            name,
            PipeDirection.InOut,
            maxInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            security);
    }

    /// <summary>The helper's end. Runs as SYSTEM, so the ACL above admits it.</summary>
    public static NamedPipeClientStream CreateClient(string name) =>
        new(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);

    /// <summary>
    /// Whether a pipe of this name currently exists — the signal the service's
    /// watchdog uses to notice the applet has gone (PLAN 5.7). A named pipe shows
    /// up in the object namespace at <c>\\.\pipe\</c>, so this needs no handle
    /// and cannot disturb a live connection.
    /// </summary>
    public static bool Exists(string name) =>
        Directory.EnumerateFiles(PipeNamespace).Any(
            p => string.Equals(Path.GetFileName(p), name, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The pipe object namespace, exactly as Win32 spells it: <c>\\.\pipe\</c>.
    /// Both backslashes at the front and the trailing one are load-bearing — the
    /// device path is not a drive-relative path, and <c>\.\pipe</c> resolves to a
    /// non-existent directory on the current drive instead, which throws. The
    /// watchdog reads a throw as "cannot tell" and never fires, so a typo here
    /// silently removes the backstop that guarantees CLAUDE.md constraint #4.
    /// </summary>
    private const string PipeNamespace = @"\\.\pipe\";

    /// <summary>Build a one-byte-tag frame with a UTF-8 body.</summary>
    public static byte[] TextFrame(byte tag, string text)
    {
        var body = Encoding.UTF8.GetBytes(text);
        var frame = new byte[body.Length + 1];
        frame[0] = tag;
        body.CopyTo(frame, 1);
        return frame;
    }

    /// <summary>Read the UTF-8 body of a frame built by <see cref="TextFrame"/>.</summary>
    public static string TextOf(byte[] frame) =>
        frame.Length <= 1 ? "" : Encoding.UTF8.GetString(frame, 1, frame.Length - 1);

    /// <summary>Writes a 4-byte big-endian length prefix followed by the payload.</summary>
    public static async Task WriteFrameAsync(
        Stream stream, ReadOnlyMemory<byte> payload, CancellationToken ct = default)
    {
        if (payload.Length > MaxFrameBytes)
            throw new ArgumentOutOfRangeException(nameof(payload), "frame too large");

        var header = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);

        await stream.WriteAsync(header, ct).ConfigureAwait(false);
        await stream.WriteAsync(payload, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The same framing, written synchronously.
    ///
    /// Exists for exactly one caller: teardown. The applet's last act is to tell
    /// the elevated service to remove itself, and a teardown path — including a
    /// process-exit handler — has no thread to await on. Bounded by the caller.
    /// </summary>
    public static void WriteFrame(Stream stream, ReadOnlySpan<byte> payload)
    {
        if (payload.Length > MaxFrameBytes)
            throw new ArgumentOutOfRangeException(nameof(payload), "frame too large");

        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);

        stream.Write(header);
        stream.Write(payload);
        stream.Flush();
    }

    /// <summary>
    /// Reads one length-prefixed frame. Returns <c>null</c> at end of stream.
    /// </summary>
    public static async Task<byte[]?> ReadFrameAsync(
        Stream stream, CancellationToken ct = default)
    {
        var header = new byte[4];
        if (!await ReadExactlyAsync(stream, header, ct).ConfigureAwait(false))
            return null;

        int length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length < 0 || length > MaxFrameBytes)
            throw new InvalidDataException($"bad frame length {length}");

        var payload = new byte[length];
        if (!await ReadExactlyAsync(stream, payload, ct).ConfigureAwait(false))
            return null;

        return payload;
    }

    private static async Task<bool> ReadExactlyAsync(
        Stream stream, Memory<byte> buffer, CancellationToken ct)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = await stream.ReadAsync(buffer[read..], ct).ConfigureAwait(false);
            if (n == 0) return false;
            read += n;
        }
        return true;
    }
}
