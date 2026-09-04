using System.Text.Json;
using System.Text.Json.Serialization;

namespace HelpdeskAnywhere.Shared;

/// <summary>
/// Wire protocol — C# mirror of <c>shared/protocol.md</c>.
///
/// <c>shared/protocol.md</c> is the single source of truth; this file and
/// <c>server/src/protocol.ts</c> mirror it. CHANGE ALL THREE TOGETHER
/// (CLAUDE.md conventions).
/// </summary>
public static class Protocol
{
    /// <summary>Binary frame tag: <c>[0x01][jpeg bytes]</c> — full frame.</summary>
    public const byte FrameFull = 0x01;

    /// <summary>
    /// Binary frame tag: <c>[0x02][x:u16][y:u16][w:u16][h:u16][jpeg bytes]</c>
    /// — dirty rect (Phase 3.3). Integers are big-endian.
    /// </summary>
    public const byte FrameDirtyRect = 0x02;

    /// <summary>Byte length of the dirty-rect header, tag byte included.</summary>
    public const int DirtyRectHeaderBytes = 9;

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Message type discriminators (the <c>t</c> field).</summary>
    public static class T
    {
        // agent -> server
        public const string AgentCreate = "agent.create";
        public const string AgentInput = "agent.input";
        public const string AgentExec = "agent.exec";
        public const string AgentRequestElevation = "agent.requestElevation";
        public const string AgentEnd = "agent.end";

        // host -> server
        public const string HostJoin = "host.join";
        public const string HostConsent = "host.consent";
        public const string HostDesktopChanged = "host.desktopChanged";
        public const string HostElevated = "host.elevated";
        public const string HostExecResult = "host.execResult";

        // server -> peers
        public const string SessionCreated = "session.created";
        public const string HostConnectRequest = "host.connectRequest";
        public const string ConsentResult = "consent.result";
        public const string PeerJoined = "peer.joined";
        public const string PeerLeft = "peer.left";
        public const string Error = "error";
    }

    /// <summary>Desktop names reported by <c>GetUserObjectInformation(UOI_NAME)</c>.</summary>
    public static class Desktops
    {
        public const string Default = "Default";
        public const string Winlogon = "Winlogon";
        public const string ScreenSaver = "Screen-saver";
    }
}

/// <summary>Reads just the <c>t</c> discriminator so the dispatch loop can branch.</summary>
public sealed record Envelope
{
    [JsonPropertyName("t")]
    public string T { get; init; } = "";
}

// ------------------------------------------------------------------ host -> server

public sealed record HostJoin
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostJoin;
    [JsonPropertyName("code")] public required string Code { get; init; }
    [JsonPropertyName("machine")] public required string Machine { get; init; }
    [JsonPropertyName("user")] public required string User { get; init; }
    [JsonPropertyName("os")] public required string Os { get; init; }
}

public sealed record HostConsent
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostConsent;
    [JsonPropertyName("accepted")] public required bool Accepted { get; init; }
}

public sealed record HostDesktopChanged
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostDesktopChanged;
    [JsonPropertyName("desktop")] public required string Desktop { get; init; }
}

public sealed record HostElevated
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostElevated;
    [JsonPropertyName("ok")] public required bool Ok { get; init; }

    /// <summary>A mapped, human-readable message — NEVER a raw credential.</summary>
    [JsonPropertyName("error")] public string? Error { get; init; }
}

public sealed record HostExecResult
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostExecResult;
    [JsonPropertyName("id")] public required string Id { get; init; }

    /// <summary>Meaningless (-1) while <see cref="Partial"/> is true.</summary>
    [JsonPropertyName("exitCode")] public required int ExitCode { get; init; }

    [JsonPropertyName("stdout")] public string Stdout { get; init; } = "";
    [JsonPropertyName("stderr")] public string Stderr { get; init; } = "";

    /// <summary>
    /// True for an incremental chunk streamed while the script is still running.
    /// Only the final, non-partial result is audited. See
    /// <c>shared/protocol.md</c> "host.execResult streaming".
    /// </summary>
    [JsonPropertyName("partial")] public bool? Partial { get; init; }
}

// ------------------------------------------------------------------ server -> host

public sealed record HostConnectRequest
{
    [JsonPropertyName("t")] public string T => Protocol.T.HostConnectRequest;
    [JsonPropertyName("agentName")] public string AgentName { get; init; } = "";
}

public sealed record ProtocolError
{
    [JsonPropertyName("t")] public string T => Protocol.T.Error;
    [JsonPropertyName("code")] public string Code { get; init; } = "";
    [JsonPropertyName("message")] public string Message { get; init; } = "";
}

// ----------------------------------------------------------------- agent -> host

/// <summary>
/// Mouse, keyboard, or the Secure Attention Sequence.
///
/// <c>Kind == "sas"</c> is Ctrl+Alt+Del and is not a key chord: no amount of
/// <c>SendInput</c> produces a SAS — that isolation is the point of it. The
/// applet routes it to the elevated service's <c>SendSAS()</c>, and the console
/// leaves its button disabled until elevation succeeds (PLAN 4.3, 5.3).
/// </summary>
public sealed record AgentInput
{
    [JsonPropertyName("t")] public string T => Protocol.T.AgentInput;

    /// <summary><c>"mouse"</c>, <c>"key"</c> or <c>"sas"</c>.</summary>
    [JsonPropertyName("kind")] public required string Kind { get; init; }

    // mouse
    [JsonPropertyName("x")] public int X { get; init; }
    [JsonPropertyName("y")] public int Y { get; init; }
    [JsonPropertyName("button")] public int? Button { get; init; }
    [JsonPropertyName("wheelDelta")] public int? WheelDelta { get; init; }

    /// <summary>DOM <c>event.code</c> (physical key), not <c>event.key</c>.</summary>
    [JsonPropertyName("code")] public string? Code { get; init; }

    [JsonPropertyName("action")] public required string Action { get; init; }
}

public sealed record AgentExec
{
    [JsonPropertyName("t")] public string T => Protocol.T.AgentExec;
    [JsonPropertyName("id")] public required string Id { get; init; }
    [JsonPropertyName("shell")] public required string Shell { get; init; }
    [JsonPropertyName("script")] public required string Script { get; init; }
    [JsonPropertyName("asSystem")] public bool AsSystem { get; init; }
}

/// <summary>
/// Elevation request (Phase 5.2).
///
/// SECURITY: when <see cref="Mode"/> is <c>"credential"</c>, <see cref="Password"/>
/// must never be logged, persisted, or held past the single
/// <c>CreateProcessWithLogonW</c> call, and must be zeroed in a <c>finally</c>.
/// Never add this type to a <c>ToString()</c>, exception message or log line.
/// See <c>shared/protocol.md</c> "Credential handling" and PLAN 5.2c.
/// </summary>
public sealed record AgentRequestElevation
{
    [JsonPropertyName("t")] public string T => Protocol.T.AgentRequestElevation;

    /// <summary><c>"interactive"</c> (5.2a) or <c>"credential"</c> (5.2b).</summary>
    [JsonPropertyName("mode")] public required string Mode { get; init; }

    [JsonPropertyName("domain")] public string? Domain { get; init; }
    [JsonPropertyName("username")] public string? Username { get; init; }
    [JsonPropertyName("password")] public string? Password { get; init; }

    /// <summary>
    /// The password as a mutable buffer the caller can zero (PLAN 5.2c rule 4).
    ///
    /// KNOWN LIMITATION, recorded rather than hidden: <c>System.Text.Json</c> has
    /// already materialised the password as an immutable <c>string</c> by the time
    /// this is called, and a .NET string cannot be overwritten. So a copy remains
    /// reachable until the GC collects it, and could appear in a crash dump taken
    /// meanwhile. What this method buys is that every *subsequent* hop — the
    /// unmanaged buffer, the P/Invoke argument — is zeroable, and it is those that
    /// live longest. Closing the gap entirely needs a hand-written reader that
    /// never builds the string, which is beyond this POC (`DEV_NOTES.md`).
    /// </summary>
    public char[] PasswordChars() => Password?.ToCharArray() ?? [];

    /// <summary>Redacted — guards against an accidental interpolation into a log.</summary>
    public override string ToString() =>
        $"AgentRequestElevation {{ Mode = {Mode}, Username = {Username}, Password = [redacted] }}";
}
