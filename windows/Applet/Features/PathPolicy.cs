namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// Which paths the remote file manager may touch (Platform 2.0, Phase 2b).
///
/// Pure string rules, deliberately not <c>Path.GetFullPath</c>: the decision must
/// be the same on every machine and testable off Windows, and normalising first
/// is exactly how ".." and device paths slip through. A path is accepted only if
/// it is ALREADY a plain absolute local path; nothing is resolved or repaired.
///
/// Accepted: <c>C:\</c>, <c>C:\Users\jo\Downloads\report.pdf</c>.
/// Refused: relative paths, <c>..</c> or <c>.</c> segments, UNC (<c>\\server</c>),
/// device and long-path prefixes (<c>\\?\</c>, <c>\\.\</c>), alternate data
/// streams (any <c>:</c> after the drive), reserved device names (<c>CON</c>,
/// <c>NUL</c>, <c>COM1</c>…, with or without an extension), characters Windows
/// forbids, segments ending in a dot or space, and anything too long.
///
/// This is a second line: the applet runs as the signed-in customer, so Windows
/// ACLs already bound what any accepted path can reach. It never elevates.
/// </summary>
public static class PathPolicy
{
    public const int MaxPath = 1024;
    public const int MaxSegment = 255;

    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$",
    };

    private static readonly char[] Forbidden = ['<', '>', ':', '"', '|', '?', '*', '/', '\\'];

    /// <summary>
    /// The canonical form of <paramref name="path"/> (upper-case drive letter,
    /// backslashes, no trailing separator except on a root), or null if refused.
    /// </summary>
    public static string? Canonical(string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > MaxPath) return null;
        var p = path.Replace('/', '\\');

        if (p.Length < 3 || !char.IsAsciiLetter(p[0]) || p[1] != ':' || p[2] != '\\') return null;

        var drive = char.ToUpperInvariant(p[0]);
        var rest = p[3..];
        if (rest.Length == 0) return $"{drive}:\\";
        if (rest.EndsWith('\\')) rest = rest[..^1];

        var segments = rest.Split('\\');
        foreach (var s in segments)
        {
            if (!IsValidName(s)) return null;
        }
        return $"{drive}:\\{string.Join('\\', segments)}";
    }

    /// <summary>A single file or folder name: one segment, nothing that navigates.</summary>
    public static bool IsValidName(string? name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > MaxSegment) return false;
        if (name == "." || name == "..") return false;
        if (name.EndsWith('.') || name.EndsWith(' ')) return false;
        foreach (var c in name)
        {
            if (c < 32 || c == 127) return false;
        }
        if (name.IndexOfAny(Forbidden) >= 0) return false;
        var stem = name.Split('.')[0].TrimEnd(' ');
        return !Reserved.Contains(stem);
    }

    /// <summary>True for <c>X:\</c>.</summary>
    public static bool IsRoot(string canonical) => canonical.Length == 3 && canonical[1] == ':' && canonical[2] == '\\';

    /// <summary>Parent of a canonical path, or null for a root.</summary>
    public static string? Parent(string canonical)
    {
        if (IsRoot(canonical)) return null;
        var i = canonical.LastIndexOf('\\');
        return i == 2 ? canonical[..3] : canonical[..i];
    }

    /// <summary>Last segment of a canonical path.</summary>
    public static string Leaf(string canonical) => IsRoot(canonical) ? canonical : canonical[(canonical.LastIndexOf('\\') + 1)..];

    /// <summary>Join a canonical directory and a validated name.</summary>
    public static string Join(string dir, string name) => dir.EndsWith('\\') ? dir + name : $"{dir}\\{name}";

    /// <summary>
    /// A name in <paramref name="dir"/> that does not exist yet: "report.pdf",
    /// then "report (1).pdf", "report (2).pdf"… An upload never overwrites.
    /// </summary>
    public static string? UniqueName(string dir, string name, Func<string, bool> exists)
    {
        if (!IsValidName(name)) return null;
        if (!exists(Join(dir, name))) return name;
        var dot = name.LastIndexOf('.');
        var (stem, ext) = dot > 0 ? (name[..dot], name[dot..]) : (name, "");
        for (var i = 1; i < 1000; i++)
        {
            var candidate = $"{stem} ({i}){ext}";
            if (candidate.Length <= MaxSegment && !exists(Join(dir, candidate))) return candidate;
        }
        return null;
    }
}
