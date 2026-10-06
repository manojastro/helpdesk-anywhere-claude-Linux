using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// The remote file manager's operations (Platform 2.0, Phase 2b): list a folder,
/// create a folder, rename, delete. Everything runs in the applet process — as
/// the signed-in customer, never elevated — so Windows ACLs bound what any of it
/// can reach, and <see cref="PathPolicy"/> refuses anything that is not a plain
/// absolute local path before Windows is even asked.
///
/// Deliberately conservative: delete removes a file or an EMPTY folder only
/// (nothing recursive), rename stays in the same folder, and a drive root can be
/// neither renamed nor deleted.
/// </summary>
internal static class FileService
{
    /// <summary>A folder with more entries than this is listed partially, and says so.</summary>
    private const int MaxEntries = 2000;

    public static HostFsResult List(string rid, string? path)
    {
        if (string.IsNullOrEmpty(path)) return ListRoots(rid);

        var dir = PathPolicy.Canonical(path);
        if (dir is null) return Fail(rid, "list", path, "That path is not allowed.");

        try
        {
            var info = new DirectoryInfo(dir);
            if (!info.Exists) return Fail(rid, "list", dir, "That folder does not exist.");

            var entries = new List<FsEntry>();
            var truncated = false;
            foreach (var e in info.EnumerateFileSystemInfos("*", new EnumerationOptions
            {
                IgnoreInaccessible = true,
                AttributesToSkip = 0,
                RecurseSubdirectories = false,
            }))
            {
                if (entries.Count >= MaxEntries) { truncated = true; break; }
                if (!PathPolicy.IsValidName(e.Name)) continue;
                var isDir = (e.Attributes & FileAttributes.Directory) != 0;
                entries.Add(new FsEntry
                {
                    Name = e.Name,
                    Type = isDir ? "dir" : "file",
                    Size = isDir ? null : ((FileInfo)e).Length,
                    Modified = new DateTimeOffset(e.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                });
            }
            entries.Sort((a, b) => a.Type != b.Type
                ? (a.Type == "dir" ? -1 : 1)
                : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

            return new HostFsResult
            {
                Rid = rid, Op = "list", Ok = true, Path = dir, Parent = PathPolicy.Parent(dir),
                Entries = entries, Truncated = truncated ? true : null,
            };
        }
        catch (Exception ex)
        {
            return Fail(rid, "list", dir, Describe(ex));
        }
    }

    /// <summary>The starting view: local drives and the customer's usual folders.</summary>
    private static HostFsResult ListRoots(string rid)
    {
        var entries = new List<FsEntry>();
        foreach (var (name, path) in KnownFolders())
        {
            if (Directory.Exists(path) && PathPolicy.Canonical(path) is { } c) entries.Add(new FsEntry { Name = name, Type = "dir", Path = c });
        }
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady || (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable)) continue;
                var label = string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.Name.TrimEnd('\\') : $"{d.VolumeLabel} ({d.Name.TrimEnd('\\')})";
                entries.Add(new FsEntry { Name = label, Type = "drive", Path = d.RootDirectory.FullName, Size = d.TotalSize });
            }
            catch (IOException)
            {
                // A drive that vanished between the listing and the query.
            }
        }
        return new HostFsResult { Rid = rid, Op = "list", Ok = true, Path = "", Entries = entries };
    }

    public static IEnumerable<(string Name, string Path)> KnownFolders()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        yield return ("Desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        yield return ("Documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
        yield return ("Downloads", System.IO.Path.Combine(profile, "Downloads"));
    }

    public static HostFsResult Mkdir(string rid, string? path)
    {
        var target = PathPolicy.Canonical(path);
        if (target is null || PathPolicy.IsRoot(target)) return Fail(rid, "mkdir", path, "That folder name is not allowed.");
        try
        {
            var parent = PathPolicy.Parent(target)!;
            if (!Directory.Exists(parent)) return Fail(rid, "mkdir", target, "The parent folder does not exist.");
            if (Directory.Exists(target) || File.Exists(target)) return Fail(rid, "mkdir", target, "Something with that name already exists.");
            Directory.CreateDirectory(target);
            return new HostFsResult { Rid = rid, Op = "mkdir", Ok = true, Path = target };
        }
        catch (Exception ex)
        {
            return Fail(rid, "mkdir", target, Describe(ex));
        }
    }

    public static HostFsResult Rename(string rid, string? path, string? newName)
    {
        var source = PathPolicy.Canonical(path);
        if (source is null || PathPolicy.IsRoot(source)) return Fail(rid, "rename", path, "That item cannot be renamed.");
        if (!PathPolicy.IsValidName(newName)) return Fail(rid, "rename", source, "That name is not allowed.");
        var target = PathPolicy.Join(PathPolicy.Parent(source)!, newName!);
        try
        {
            if (File.Exists(target) || Directory.Exists(target)) return Fail(rid, "rename", source, "Something with that name already exists.");
            if (File.Exists(source)) File.Move(source, target, overwrite: false);
            else if (Directory.Exists(source)) Directory.Move(source, target);
            else return Fail(rid, "rename", source, "That item no longer exists.");
            return new HostFsResult { Rid = rid, Op = "rename", Ok = true, Path = source, NewName = newName };
        }
        catch (Exception ex)
        {
            return Fail(rid, "rename", source, Describe(ex));
        }
    }

    public static HostFsResult Delete(string rid, string? path)
    {
        var target = PathPolicy.Canonical(path);
        if (target is null || PathPolicy.IsRoot(target)) return Fail(rid, "delete", path, "That item cannot be deleted.");
        try
        {
            if (File.Exists(target))
            {
                File.Delete(target);
            }
            else if (Directory.Exists(target))
            {
                if (Directory.EnumerateFileSystemEntries(target).Any())
                    return Fail(rid, "delete", target, "Only empty folders can be deleted. Delete what is inside first.");
                Directory.Delete(target, recursive: false);
            }
            else
            {
                return Fail(rid, "delete", target, "That item no longer exists.");
            }
            return new HostFsResult { Rid = rid, Op = "delete", Ok = true, Path = target };
        }
        catch (Exception ex)
        {
            return Fail(rid, "delete", target, Describe(ex));
        }
    }

    private static HostFsResult Fail(string rid, string op, string? path, string error) =>
        new() { Rid = rid, Op = op, Ok = false, Path = path, Error = error };

    /// <summary>A message the technician can act on; never a stack trace.</summary>
    public static string Describe(Exception ex) => ex switch
    {
        UnauthorizedAccessException => "Access denied — the signed-in user does not have permission.",
        DirectoryNotFoundException => "That folder does not exist.",
        FileNotFoundException => "That file does not exist.",
        PathTooLongException => "That path is too long.",
        IOException io when io.HResult == unchecked((int)0x80070020) => "The file is in use by another program.",
        IOException io => $"The operation failed: {io.Message}",
        _ => $"The operation failed ({ex.GetType().Name}).",
    };
}
