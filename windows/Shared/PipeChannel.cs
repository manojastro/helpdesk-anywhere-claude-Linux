using System.Buffers.Binary;

namespace HelpdeskAnywhere.Shared;

/// <summary>
/// Length-prefixed framing over the named pipe between <c>Applet</c> and
/// <c>DesktopHelper</c> (PLAN 5.5).
///
/// Payloads use the same <c>[0x01]</c>/<c>[0x02]</c> tags as the WS protocol, so
/// the applet can forward helper frames to the server without re-encoding.
///
/// Phase 0 scaffold: framing only. Phase 5.5 adds the
/// <c>NamedPipeServerStream</c>/<c>NamedPipeClientStream</c> pair, named with a
/// per-session GUID.
///
/// SECURITY (Phase 5.5, do not skip): the pipe MUST be created with a
/// <c>PipeSecurity</c> ACL allowing only LocalSystem and the current user. A
/// world-writable pipe carrying input events into a SYSTEM process is a local
/// privilege-escalation hole. That needs the <c>System.IO.Pipes.AccessControl</c>
/// package and <c>NamedPipeServerStreamAcl.Create</c> — add it in Phase 5.5.
/// </summary>
public static class PipeChannel
{
    /// <summary>Frames larger than this are rejected as corrupt.</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;

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
