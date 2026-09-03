using HelpdeskAnywhere.Applet.Scripting;

// Regression for the 2026-09-03 security review: a wire-supplied exec id must
// not be able to place the staged script outside the session's temp folder.

var pass = 0;
var fail = 0;

void Check(string name, bool ok, string detail = "")
{
    if (ok) pass++; else fail++;
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(detail.Length > 0 ? $"  — {detail}" : "")}");
}

Console.WriteLine("\n=== ScriptStaging — a job id cannot escape the temp folder ===\n");

var tempDir = Path.Combine(Path.GetTempPath(), "HelpdeskAnywhere", "session");

// The real console only ever sends this shape, and it must survive untouched.
Check("an ordinary console id is unchanged",
    ScriptStaging.SafeFileName("xmtlr6xw4") == "xmtlr6xw4",
    ScriptStaging.SafeFileName("xmtlr6xw4"));

string[] hostile =
[
    @"..\..\..\Windows\System32\evil",
    @"C:\Windows\Temp\evil",
    "/etc/cron.d/evil",
    @"..\Startup\evil",
    "..",
    ".",
    "",
    "con",                       // a DOS device name is still confined by the folder
    "a/b",
    "a:b",
    "a\0b",
    new string('x', 500),
];

foreach (var id in hostile)
{
    var name = ScriptStaging.SafeFileName(id);
    var full = Path.GetFullPath(Path.Combine(tempDir, $"{name}.ps1"));
    var inside = full.StartsWith(Path.GetFullPath(tempDir) + Path.DirectorySeparatorChar,
        StringComparison.Ordinal);
    Check($"id {Display(id)} stays inside the session folder", inside, full);
}

Check("no separator, colon, dot-dot or NUL survives",
    hostile.Select(ScriptStaging.SafeFileName)
        .All(n => !n.Contains('/') && !n.Contains('\\') && !n.Contains(':') &&
                  !n.Contains("..") && !n.Contains('\0')));

Check("an empty id gets a usable name",
    ScriptStaging.SafeFileName("") == "job", ScriptStaging.SafeFileName(""));
Check("a dots-only id becomes underscores, never a directory reference",
    ScriptStaging.SafeFileName("...") == "___", ScriptStaging.SafeFileName("..."));

Check("the name is length-capped", ScriptStaging.SafeFileName(new string('x', 500)).Length <= 64,
    ScriptStaging.SafeFileName(new string('x', 500)).Length.ToString());

Console.WriteLine($"\n  {(fail == 0 ? "ALL PASS" : $"{fail} FAILED")}  ({pass} passed)\n");
return fail == 0 ? 0 : 1;

static string Display(string s) =>
    s.Length == 0 ? "<empty>" : s.Length > 24 ? s[..24] + "…" : s.Replace("\0", "\\0");
