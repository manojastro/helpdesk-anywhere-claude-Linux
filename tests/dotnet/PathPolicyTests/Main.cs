// Platform 2.0 Phase 2b: the remote file manager's path rules (PathPolicy.cs).
// Pure string logic, so it runs here exactly as it does on Windows.
using HelpdeskAnywhere.Applet.Features;

var failed = 0;
void Check(string name, bool ok) { if (!ok) failed++; Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}"); }

Console.WriteLine("\n=== PathPolicy ===\n");

// Accepted, canonicalised
Check("drive root", PathPolicy.Canonical(@"c:\") == @"C:\");
Check("plain path, upper-case drive", PathPolicy.Canonical(@"c:\Users\jo\Downloads") == @"C:\Users\jo\Downloads");
Check("forward slashes become backslashes", PathPolicy.Canonical("C:/Users/jo/a.txt") == @"C:\Users\jo\a.txt");
Check("one trailing separator dropped", PathPolicy.Canonical(@"C:\Temp\") == @"C:\Temp");
Check("unicode names allowed", PathPolicy.Canonical(@"C:\Users\ராஜா\கோப்பு.txt") == @"C:\Users\ராஜா\கோப்பு.txt");

// Refused
string[] bad =
[
    "", "relative\\path", @"\Windows", @"C:", "C:relative", @"C:\a\..\b", @"C:\a\.\b", @"C:\..",
    @"\\server\share\x", @"\\?\C:\x", @"\\.\PhysicalDrive0", @"//server/share",
    @"C:\a\file.txt:secret", @"C:\a\b:c",
    @"C:\a\CON", @"C:\a\con.txt", @"C:\a\NUL", @"C:\a\com1.log", @"C:\a\LPT9", @"C:\a\aux .txt",
    @"C:\a\trail.", @"C:\a\trail ", @"C:\a\b<c", @"C:\a\b|c", @"C:\a\b?c", @"C:\a\b*c", "C:\\a\\b\"c",
    "C:\\a\\b\u0001c", @"C:\a\\b", "C:\\" + new string('a', 300), "C:\\" + string.Join("\\", Enumerable.Repeat("abcd", 300)),
];
foreach (var b in bad) Check($"refused: {(b.Length > 40 ? b[..40] + "…" : b)}", PathPolicy.Canonical(b) is null);

// Names
Check("valid name", PathPolicy.IsValidName("report final.pdf"));
foreach (var n in new[] { "", ".", "..", "a\\b", "a/b", "CON", "nul.txt", "x.", "x ", "a:b" })
    Check($"invalid name: '{n}'", !PathPolicy.IsValidName(n));

// Structure helpers
Check("parent of a file", PathPolicy.Parent(@"C:\a\b.txt") == @"C:\a");
Check("parent of a top-level folder is the root", PathPolicy.Parent(@"C:\a") == @"C:\");
Check("a root has no parent", PathPolicy.Parent(@"C:\") is null);
Check("leaf", PathPolicy.Leaf(@"C:\a\b.txt") == "b.txt");
Check("join at root", PathPolicy.Join(@"C:\", "x") == @"C:\x");

// Never overwrite
var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { @"C:\in\r.pdf", @"C:\in\r (1).pdf" };
Check("unique name skips taken ones", PathPolicy.UniqueName(@"C:\in", "r.pdf", existing.Contains) == "r (2).pdf");
Check("unique name keeps a free one", PathPolicy.UniqueName(@"C:\in", "s.pdf", existing.Contains) == "s.pdf");
Check("unique name refuses an invalid name", PathPolicy.UniqueName(@"C:\in", "..", existing.Contains) is null);

Console.WriteLine($"\n--- PathPolicy: {(failed == 0 ? "all passed" : $"{failed} failed")} ---");
return failed == 0 ? 0 : 1;
