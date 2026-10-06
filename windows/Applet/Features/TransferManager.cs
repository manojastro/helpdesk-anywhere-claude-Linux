using System.Collections.Concurrent;
using System.Security.Cryptography;

using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// File transfer, applet side (Platform 2.0, Phase 2b).
///
/// Upload (technician → this computer): the file is written to
/// <c>&lt;final&gt;.hdapart</c> while it arrives, hashed as it goes, and only renamed
/// to its real name once every byte is in and the SHA-256 the console computed
/// matches. It never overwrites anything — a clash becomes "name (1).ext" — and a
/// cancelled, failed or interrupted upload leaves no partial file behind.
///
/// Download (this computer → technician): read-only, streamed in 48 KiB chunks
/// with at most <see cref="FeatureProtocol.Window"/> unacknowledged, so a big
/// file can never flood the control channel ahead of an End Session.
///
/// The customer is told on their own session indicator every time a file comes
/// in or goes out (constraint #2). Contents are never logged.
/// </summary>
internal sealed class TransferManager : IDisposable
{
    private sealed class Upload
    {
        public required string FinalPath;
        public required string PartPath;
        public required FileStream Stream;
        public required long Size;
        public readonly IncrementalHash Hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        public long Bytes;
        public long Seq;
    }

    private sealed class Download
    {
        public readonly CancellationTokenSource Cts = new();
        public readonly SemaphoreSlim Window = new(FeatureProtocol.Window, FeatureProtocol.Window);
    }

    private readonly SessionClient _client;
    private readonly Action<string> _notifyUser;
    private readonly ConcurrentDictionary<string, Upload> _uploads = new();
    private readonly ConcurrentDictionary<string, Download> _downloads = new();
    private bool _disposed;

    public TransferManager(SessionClient client, Action<string> notifyUser)
    {
        _client = client;
        _notifyUser = notifyUser;
    }

    /// <summary>Where an upload lands when the technician did not pick a folder.</summary>
    public static string DefaultInbox() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Helpdesk Anywhere");

    /* ------------------------------------------------------------------ upload */

    public void BeginUpload(AgentFeatureRequest r)
    {
        var tid = r.Tid ?? "";
        if (_disposed || !Guid.TryParse(tid, out _)) return;

        string? dir;
        if (string.IsNullOrEmpty(r.Dir))
        {
            try { Directory.CreateDirectory(DefaultInbox()); }
            catch (Exception ex) { Fail(tid, FileService.Describe(ex)); return; }
            dir = PathPolicy.Canonical(DefaultInbox());
        }
        else
        {
            dir = PathPolicy.Canonical(r.Dir);
        }
        if (dir is null || !Directory.Exists(dir)) { Fail(tid, "That destination folder is not available."); return; }
        if (!PathPolicy.IsValidName(r.Name)) { Fail(tid, "That file name is not allowed on Windows."); return; }
        if (r.Size < 0) { Fail(tid, "Invalid size."); return; }

        try
        {
            var root = Path.GetPathRoot(dir);
            if (root is not null && new DriveInfo(root).AvailableFreeSpace < r.Size + 10L * 1024 * 1024)
            {
                Fail(tid, "There is not enough free disk space on the remote computer.");
                return;
            }

            var name = PathPolicy.UniqueName(dir, r.Name!, p => File.Exists(p) || Directory.Exists(p) || File.Exists(p + ".hdapart"));
            if (name is null) { Fail(tid, "Could not find a free file name."); return; }
            var final = PathPolicy.Join(dir, name);
            var part = final + ".hdapart";
            var stream = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024);

            _uploads[tid] = new Upload { FinalPath = final, PartPath = part, Stream = stream, Size = r.Size };
            _client.Send(new HostFileReady { Tid = tid, Path = final });
            _notifyUser($"The technician is sending you a file: {name}");
        }
        catch (Exception ex)
        {
            Fail(tid, FileService.Describe(ex));
        }
    }

    public void Chunk(AgentFeatureRequest r)
    {
        if (r.Tid is null || !_uploads.TryGetValue(r.Tid, out var u)) return;
        try
        {
            if (r.Seq != u.Seq + 1 || r.Data is null) throw new InvalidDataException("out-of-order chunk");
            var bytes = Convert.FromBase64String(r.Data);
            if (bytes.Length > FeatureProtocol.ChunkBytes || u.Bytes + bytes.Length > u.Size) throw new InvalidDataException("more data than declared");
            u.Stream.Write(bytes);
            u.Hash.AppendData(bytes);
            u.Bytes += bytes.Length;
            u.Seq = r.Seq;
            _client.Send(new HostFileAck { Tid = r.Tid, Seq = r.Seq });
        }
        catch (Exception ex)
        {
            Abort(r.Tid);
            Fail(r.Tid, ex is InvalidDataException or FormatException ? "The upload was corrupted in transit." : FileService.Describe(ex));
        }
    }

    public void End(AgentFeatureRequest r)
    {
        if (r.Tid is null || !_uploads.TryRemove(r.Tid, out var u)) return;
        try
        {
            u.Stream.Flush(flushToDisk: true);
            u.Stream.Dispose();
            var sha = Convert.ToHexString(u.Hash.GetHashAndReset()).ToLowerInvariant();
            if (u.Bytes != u.Size || (r.Sha256 is { Length: > 0 } expected && !string.Equals(expected, sha, StringComparison.OrdinalIgnoreCase)))
            {
                TryDelete(u.PartPath);
                Fail(r.Tid, "The file did not arrive intact (size or checksum mismatch) and was discarded.");
                return;
            }

            var final = u.FinalPath;
            if (File.Exists(final) || Directory.Exists(final))
            {
                var dir = PathPolicy.Parent(final)!;
                var name = PathPolicy.UniqueName(dir, PathPolicy.Leaf(final), p => File.Exists(p) || Directory.Exists(p));
                if (name is null) throw new IOException("no free file name");
                final = PathPolicy.Join(dir, name);
            }
            File.Move(u.PartPath, final, overwrite: false);
            _client.Send(new HostFileDone { Tid = r.Tid, Bytes = u.Bytes, Sha256 = sha, Path = final });
            _notifyUser($"File received: {PathPolicy.Leaf(final)} (in {PathPolicy.Parent(final)})");
        }
        catch (Exception ex)
        {
            TryDelete(u.PartPath);
            Fail(r.Tid, FileService.Describe(ex));
        }
        finally
        {
            u.Hash.Dispose();
        }
    }

    /* ---------------------------------------------------------------- download */

    public void BeginDownload(AgentFeatureRequest r)
    {
        var tid = r.Tid ?? "";
        if (_disposed || !Guid.TryParse(tid, out _)) return;
        var path = PathPolicy.Canonical(r.Path);
        if (path is null) { Fail(tid, "That path is not allowed."); return; }
        if (!File.Exists(path)) { Fail(tid, Directory.Exists(path) ? "Folders cannot be downloaded — download the files inside." : "That file does not exist."); return; }

        var d = new Download();
        _downloads[tid] = d;
        _ = Task.Run(() => SendFileAsync(tid, path, d));
    }

    private async Task SendFileAsync(string tid, string path, Download d)
    {
        try
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
            var size = stream.Length;
            _client.Send(new HostFileMeta { Tid = tid, Name = PathPolicy.Leaf(path), Size = size });
            _notifyUser($"The technician is copying a file from this computer: {PathPolicy.Leaf(path)}");

            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[FeatureProtocol.ChunkBytes];
            long sent = 0, seq = 0;
            while (sent < size)
            {
                await d.Window.WaitAsync(d.Cts.Token).ConfigureAwait(false);
                var want = (int)Math.Min(buffer.Length, size - sent);
                var read = await stream.ReadAsync(buffer.AsMemory(0, want), d.Cts.Token).ConfigureAwait(false);
                if (read == 0) break;  // shrank while reading: the relay's size check reports it
                hash.AppendData(buffer, 0, read);
                sent += read;
                _client.Send(new HostFileChunk { Tid = tid, Seq = ++seq, Data = Convert.ToBase64String(buffer, 0, read) });
            }
            _client.Send(new HostFileDone { Tid = tid, Bytes = sent, Sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() });
        }
        catch (OperationCanceledException)
        {
            // Cancelled by the technician, the relay or session end: nothing to report.
        }
        catch (Exception ex)
        {
            Fail(tid, FileService.Describe(ex));
        }
        finally
        {
            _downloads.TryRemove(tid, out _);
            d.Cts.Dispose();
        }
    }

    public void Ack(AgentFeatureRequest r)
    {
        if (r.Tid is not null && _downloads.TryGetValue(r.Tid, out var d))
        {
            try { d.Window.Release(); } catch (SemaphoreFullException) { } catch (ObjectDisposedException) { }
        }
    }

    /* ------------------------------------------------------------------ cancel */

    public void Cancel(string? tid)
    {
        if (tid is null) return;
        if (_downloads.TryGetValue(tid, out var d))
        {
            try { d.Cts.Cancel(); } catch (ObjectDisposedException) { }
        }
        if (Abort(tid)) _notifyUser("A file transfer was cancelled.");
    }

    /// <summary>Drop an upload in progress and its partial file. True if there was one.</summary>
    private bool Abort(string tid)
    {
        if (!_uploads.TryRemove(tid, out var u)) return false;
        try { u.Stream.Dispose(); } catch { }
        u.Hash.Dispose();
        TryDelete(u.PartPath);
        return true;
    }

    private void Fail(string tid, string error) => _client.Send(new HostFileError { Tid = tid, Error = error });

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { }
    }

    /// <summary>Session end: stop every transfer and leave no partial file behind (constraint #4).</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        foreach (var tid in _downloads.Keys.ToArray()) Cancel(tid);
        foreach (var tid in _uploads.Keys.ToArray()) Abort(tid);
    }
}
