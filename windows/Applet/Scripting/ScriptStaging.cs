namespace HelpdeskAnywhere.Applet.Scripting;

/// <summary>
/// Turns a wire-supplied job id into a file name that cannot leave the session's
/// own temp folder.
///
/// The id arrives over the network. <c>Path.Combine</c> silently discards its
/// first argument when the second is rooted, so an id of <c>C:\Windows\…</c> or
/// <c>..\..\Startup\x</c> would stage — and execute — the script somewhere the
/// session teardown never cleans up. That contradicts CLAUDE.md constraint #4
/// ("nothing survives"), and it is the applet's job to distrust the wire even
/// though the console only ever sends <c>x&lt;base36&gt;</c>. Found by the
/// 2026-09-03 security review.
///
/// Dependency-free on purpose, so it is unit-testable on Linux
/// (<c>tests/dotnet/StagingTests</c>).
/// </summary>
internal static class ScriptStaging
{
    /// <summary>Longest staged name, before the extension.</summary>
    private const int MaxLength = 64;

    /// <summary>
    /// Every character outside <c>[A-Za-z0-9_-]</c> becomes <c>_</c>, so no
    /// separator, drive letter, colon, NUL or dot can survive — the dot is
    /// excluded too, since the extension is chosen here and a name with no dots
    /// at all cannot contain <c>..</c> under any reading. An id that is empty or
    /// reduces to nothing usable becomes <c>job</c>.
    /// </summary>
    public static string SafeFileName(string id)
    {
        if (string.IsNullOrEmpty(id)) return "job";

        var chars = new char[Math.Min(id.Length, MaxLength)];
        for (var i = 0; i < chars.Length; i++)
        {
            var c = id[i];
            chars[i] = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '-'
                ? c
                : '_';
        }

        return new string(chars);
    }
}
