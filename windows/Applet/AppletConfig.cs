using System.Diagnostics.CodeAnalysis;
using System.Reflection;

namespace HelpdeskAnywhere.Applet;

/// <summary>
/// Applet-side configuration (PLAN 2.2: "server URL, pre-baked from config,
/// overridable").
///
/// The URL is baked in at publish time from the <c>ServerUrl</c> MSBuild property
/// (<c>scripts/build-windows.sh</c> derives it from <c>PUBLIC_HOST</c>), so the
/// end user normally types nothing but the six digits. It stays editable because
/// a POC gets pointed at a dev box more often than at the real host.
/// </summary>
internal static class AppletConfig
{
    private const string ServerUrlKey = "ServerUrl";

    /// <summary>Used only when nothing was baked in at publish time.</summary>
    private const string FallbackServerUrl = "wss://localhost:8080/ws";

    /// <summary>The WebSocket path the server listens on (`shared/protocol.md`).</summary>
    private const string WebSocketPath = "/ws";

    /// <summary>Session codes are exactly six digits, leading zeros included.</summary>
    public const int CodeLength = 6;

    public static string DefaultServerUrl { get; } = ReadBakedServerUrl();

    private static string ReadBakedServerUrl()
    {
        var baked = typeof(AppletConfig).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == ServerUrlKey)?.Value;

        return string.IsNullOrWhiteSpace(baked) ? FallbackServerUrl : baked;
    }

    /// <summary>
    /// Accepts what a support agent might read down the phone — <c>example.duckdns.org</c>,
    /// <c>https://example.duckdns.org</c>, <c>wss://example.duckdns.org/ws</c> — and
    /// normalises it to the one URL the applet actually dials.
    ///
    /// A bare host becomes <c>wss:</c>, never <c>ws:</c>: plaintext is only ever reached
    /// by typing it deliberately (CLAUDE.md "Public URL and TLS"). Credential-mode
    /// elevation is refused server-side on such a connection anyway (PLAN 5.2c).
    /// </summary>
    public static bool TryParseServerUrl(
        string input,
        [NotNullWhen(true)] out Uri? uri,
        [NotNullWhen(false)] out string? error)
    {
        uri = null;
        error = null;

        var text = input.Trim();
        if (text.Length == 0)
        {
            error = "Enter the server address.";
            return false;
        }

        if (!text.Contains("://", StringComparison.Ordinal)) text = "wss://" + text;

        if (!Uri.TryCreate(text, UriKind.Absolute, out var parsed) ||
            string.IsNullOrEmpty(parsed.Host))
        {
            error = "That server address is not valid.";
            return false;
        }

        var scheme = parsed.Scheme switch
        {
            "https" or "wss" => "wss",
            "http" or "ws" => "ws",
            _ => null,
        };

        if (scheme is null)
        {
            error = "The server address must start with https:// or wss://.";
            return false;
        }

        var builder = new UriBuilder(parsed) { Scheme = scheme, Fragment = "", Query = "" };
        if (builder.Path.Length <= 1) builder.Path = WebSocketPath;

        uri = builder.Uri;
        return true;
    }

    /// <summary>
    /// Codes are six digits and keep their leading zeros — <c>004821</c> is valid
    /// (PLAN 1.2, and `DEV_NOTES.md` "Codes keep their leading zeros").
    /// </summary>
    public static bool IsValidCode(string code) =>
        code.Length == CodeLength && code.All(char.IsAsciiDigit);
}
