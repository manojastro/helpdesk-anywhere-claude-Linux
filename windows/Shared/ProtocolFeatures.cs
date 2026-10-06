using System.Text.Json.Serialization;

namespace HelpdeskAnywhere.Shared;

/// <summary>
/// Technician Platform 2.0, Phase 2b — wire messages for file transfer, the
/// remote file manager, clipboard text, system information and script cancel.
/// C# mirror of <c>shared/protocol.md</c> "Phase 2b"; the TypeScript side is
/// <c>server/src/features.ts</c>. CHANGE ALL THREE TOGETHER.
///
/// Kept apart from <see cref="Protocol"/> so the messages the verified
/// privileged-control build depends on stay exactly as they were. Every message
/// here is JSON on the existing control channel: file data travels as base64
/// chunks, never as a new binary frame type, so the video framing is untouched.
/// </summary>
public static class FeatureProtocol
{
    /// <summary>Sent in <c>host.join</c>; 1 (or absent) means "no Phase 2b features".</summary>
    public const int Version = 2;

    public static readonly string[] Capabilities = ["files", "clipboard", "sysinfo", "execCancel", "resume", "transfer", "quality", "monitors"];

    /// <summary>Raw bytes per file chunk. Mirrors <c>CHUNK_BYTES</c> in features.ts.</summary>
    public const int ChunkBytes = 48 * 1024;

    /// <summary>Chunks a sender may have in flight before it waits for an ack.</summary>
    public const int Window = 8;

    /// <summary>Mirrors <c>MAX_CLIPBOARD_CHARS</c> in features.ts.</summary>
    public const int MaxClipboardChars = 60_000;

    public static class T
    {
        // agent -> host
        public const string FsList = "agent.fs.list";
        public const string FsMkdir = "agent.fs.mkdir";
        public const string FsRename = "agent.fs.rename";
        public const string FsDelete = "agent.fs.delete";
        public const string FilePut = "agent.file.put";
        public const string FileChunk = "agent.file.chunk";
        public const string FileEnd = "agent.file.end";
        public const string FileGet = "agent.file.get";
        public const string FileAck = "agent.file.ack";
        public const string FileCancel = "agent.file.cancel";
        public const string ClipboardSet = "agent.clipboard.set";
        public const string ClipboardGet = "agent.clipboard.get";
        public const string SysinfoGet = "agent.sysinfo.get";
        public const string ExecCancel = "agent.exec.cancel";

        // host -> agent
        public const string FsResult = "host.fs.result";
        public const string FileReady = "host.file.ready";
        public const string HostFileAck = "host.file.ack";
        public const string FileMeta = "host.file.meta";
        public const string HostFileChunk = "host.file.chunk";
        public const string FileDone = "host.file.done";
        public const string FileError = "host.file.error";
        public const string ClipboardResult = "host.clipboard.result";
        public const string Sysinfo = "host.sysinfo";

        // Phase 3: customer-side reconnect
        public const string ResumeToken = "host.resumeToken";   // server -> host, at consent
        public const string Resume = "host.resume";             // host -> server, first message on a new socket
        public const string Resumed = "host.resumed";           // server -> host

        // Phase 5: session transfer (the customer approves the new technician)
        public const string TransferRequest = "host.transferRequest";       // server -> host
        public const string TransferCancelled = "host.transferCancelled";   // server -> host
        public const string TransferConsent = "host.transferConsent";       // host -> server

        // Stream quality profile and monitor layout
        public const string Quality = "agent.quality";          // agent -> host {profile}
        public const string QualityResult = "host.quality";     // host -> agent {profile, fps}
        public const string Monitors = "host.monitors";         // host -> agent, at start and on display change
    }
}

// ----------------------------------------------------------------- agent -> host

/// <summary>Any agent feature request: the fields each one uses are optional here.</summary>
public sealed record AgentFeatureRequest
{
    [JsonPropertyName("t")] public string T { get; init; } = "";
    [JsonPropertyName("rid")] public string? Rid { get; init; }
    [JsonPropertyName("tid")] public string? Tid { get; init; }
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
    [JsonPropertyName("newName")] public string? NewName { get; init; }
    [JsonPropertyName("dir")] public string? Dir { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("size")] public long Size { get; init; }
    [JsonPropertyName("seq")] public long Seq { get; init; }
    [JsonPropertyName("data")] public string? Data { get; init; }
    [JsonPropertyName("sha256")] public string? Sha256 { get; init; }
    [JsonPropertyName("profile")] public string? Profile { get; init; }

    /// <summary>Clipboard text. Never logged anywhere (it can be a password).</summary>
    [JsonPropertyName("text")] public string? Text { get; init; }

    public override string ToString() => $"AgentFeatureRequest {{ T = {T}, Rid = {Rid}, Tid = {Tid} }}";
}

// ----------------------------------------------------------------- host -> agent

public sealed record FsEntry
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    /// <summary><c>"drive"</c>, <c>"dir"</c> or <c>"file"</c>.</summary>
    [JsonPropertyName("type")] public required string Type { get; init; }
    [JsonPropertyName("size")] public long? Size { get; init; }
    [JsonPropertyName("modified")] public long? Modified { get; init; }
    /// <summary>For drives and shortcuts: the absolute path to open.</summary>
    [JsonPropertyName("path")] public string? Path { get; init; }
}

public sealed record HostFsResult
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.FsResult;
    [JsonPropertyName("rid")] public required string Rid { get; init; }
    /// <summary><c>list</c>, <c>mkdir</c>, <c>rename</c> or <c>delete</c>.</summary>
    [JsonPropertyName("op")] public required string Op { get; init; }
    [JsonPropertyName("ok")] public required bool Ok { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
    [JsonPropertyName("newName")] public string? NewName { get; init; }
    [JsonPropertyName("parent")] public string? Parent { get; init; }
    [JsonPropertyName("entries")] public List<FsEntry>? Entries { get; init; }
    [JsonPropertyName("truncated")] public bool? Truncated { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
}

public sealed record HostFileReady
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.FileReady;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("path")] public required string Path { get; init; }
}

public sealed record HostFileAck
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.HostFileAck;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("seq")] public required long Seq { get; init; }
}

public sealed record HostFileMeta
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.FileMeta;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("size")] public required long Size { get; init; }
}

public sealed record HostFileChunk
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.HostFileChunk;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("seq")] public required long Seq { get; init; }
    [JsonPropertyName("data")] public required string Data { get; init; }
}

public sealed record HostFileDone
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.FileDone;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("bytes")] public required long Bytes { get; init; }
    [JsonPropertyName("sha256")] public required string Sha256 { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
}

public sealed record HostFileError
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.FileError;
    [JsonPropertyName("tid")] public required string Tid { get; init; }
    [JsonPropertyName("error")] public required string Error { get; init; }
}

public sealed record HostClipboardResult
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.ClipboardResult;
    [JsonPropertyName("rid")] public required string Rid { get; init; }
    /// <summary><c>set</c> or <c>get</c>.</summary>
    [JsonPropertyName("op")] public required string Op { get; init; }
    [JsonPropertyName("ok")] public required bool Ok { get; init; }
    /// <summary>Only for <c>get</c>. Never logged.</summary>
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("truncated")] public bool? Truncated { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }

    public override string ToString() => $"HostClipboardResult {{ Op = {Op}, Ok = {Ok}, Text = [redacted] }}";
}

public sealed record HostSysinfo
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.Sysinfo;
    [JsonPropertyName("rid")] public required string Rid { get; init; }
    [JsonPropertyName("info")] public required Dictionary<string, object?> Info { get; init; }
}

// -------------------------------------------------- Phase 3: customer reconnect

/// <summary>The relay's resume secret for this applet. Never logged; redacted in ToString.</summary>
public sealed record HostResumeToken
{
    [JsonPropertyName("t")] public string T { get; init; } = FeatureProtocol.T.ResumeToken;
    [JsonPropertyName("sessionId")] public string SessionId { get; init; } = "";
    [JsonPropertyName("resumeToken")] public string ResumeToken { get; init; } = "";
    public override string ToString() => "HostResumeToken { ResumeToken = [redacted] }";
}

public sealed record HostResume
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.Resume;
    [JsonPropertyName("sessionId")] public required string SessionId { get; init; }
    [JsonPropertyName("resumeToken")] public required string ResumeToken { get; init; }
    public override string ToString() => "HostResume { ResumeToken = [redacted] }";
}

public sealed record HostResumed
{
    [JsonPropertyName("t")] public string T { get; init; } = FeatureProtocol.T.Resumed;
    [JsonPropertyName("resumeToken")] public string ResumeToken { get; init; } = "";
    [JsonPropertyName("held")] public bool Held { get; init; }
    public override string ToString() => "HostResumed { ResumeToken = [redacted] }";
}

// ---------------------------------------------------- Phase 5: session transfer

public sealed record HostTransferRequest
{
    [JsonPropertyName("t")] public string T { get; init; } = FeatureProtocol.T.TransferRequest;
    [JsonPropertyName("transferId")] public string TransferId { get; init; } = "";
    [JsonPropertyName("agentName")] public string AgentName { get; init; } = "";
    [JsonPropertyName("fromName")] public string FromName { get; init; } = "";
}

public sealed record HostTransferCancelled
{
    [JsonPropertyName("t")] public string T { get; init; } = FeatureProtocol.T.TransferCancelled;
    [JsonPropertyName("transferId")] public string TransferId { get; init; } = "";
}

public sealed record HostTransferConsent
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.TransferConsent;
    [JsonPropertyName("transferId")] public required string TransferId { get; init; }
    [JsonPropertyName("accepted")] public required bool Accepted { get; init; }
}

// ------------------------------------------------- stream quality and monitors

public sealed record HostQuality
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.QualityResult;
    [JsonPropertyName("profile")] public required string Profile { get; init; }
    [JsonPropertyName("fps")] public required int Fps { get; init; }
}

public sealed record MonitorInfo
{
    [JsonPropertyName("index")] public required int Index { get; init; }
    [JsonPropertyName("primary")] public required bool Primary { get; init; }
    /// <summary>Position relative to the captured virtual screen's top-left, in pixels.</summary>
    [JsonPropertyName("x")] public required int X { get; init; }
    [JsonPropertyName("y")] public required int Y { get; init; }
    [JsonPropertyName("width")] public required int Width { get; init; }
    [JsonPropertyName("height")] public required int Height { get; init; }
}

public sealed record HostMonitors
{
    [JsonPropertyName("t")] public string T => FeatureProtocol.T.Monitors;
    [JsonPropertyName("monitors")] public required List<MonitorInfo> Monitors { get; init; }
    [JsonPropertyName("width")] public required int Width { get; init; }
    [JsonPropertyName("height")] public required int Height { get; init; }
}
