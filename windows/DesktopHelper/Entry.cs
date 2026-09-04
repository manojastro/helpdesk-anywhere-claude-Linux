namespace HelpdeskAnywhere.DesktopHelper;

/// <summary>
/// Standalone entry point, so this project still builds and runs as its own .exe
/// for debugging on the Windows test machine.
///
/// The shipped product does NOT use this file: the applet compiles
/// <c>Program.cs</c> in and dispatches to <see cref="Program.Run"/> from its own
/// <c>--desktop-helper</c> mode, so the end user downloads one binary instead of
/// three (DECISIONS.md D-009). This file is excluded from that compilation —
/// two <c>Main</c> methods in one assembly would need a StartupObject to
/// disambiguate, and one entry point is clearer than a build setting.
/// </summary>
internal static class Entry
{
    private static int Main(string[] args) => Program.Run(args);
}
