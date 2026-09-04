using System.Runtime.InteropServices;
using System.Text;

namespace HelpdeskAnywhere.Applet.Interop;

/// <summary>
/// Window-station and desktop APIs (PLAN 5.3, 5.4), plus the Secure Attention
/// Sequence (PLAN 4.3).
///
/// UAC renders on a separate desktop — usually <c>Winlogon</c> — inside the same
/// session. A process running as the interactive user cannot open, capture or
/// inject into it, and that isolation *is* the security boundary: it is what
/// stops malware from clicking the consent prompt for you. Reaching it therefore
/// requires SYSTEM, which is why <c>DesktopHelper</c> exists as a separate
/// process rather than a thread in the applet.
///
/// All P/Invoke lives in <c>Interop/</c> per CLAUDE.md conventions.
/// </summary>
internal static class Desktops
{
    private const string Library = "user32.dll";

    public const uint GENERIC_ALL = 0x10000000;

    /// <summary>`GetUserObjectInformation` — ask for the object's name.</summary>
    public const int UOI_NAME = 2;

    /// <summary>
    /// The desktop currently receiving input. Under a UAC prompt this is
    /// <c>Winlogon</c>; ordinarily <c>Default</c>; under the lock screen or a
    /// screensaver, one of those.
    /// </summary>
    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint desiredAccess);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenDesktop(string desktop, uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint desiredAccess);

    /// <summary>
    /// Bind the CALLING THREAD to a desktop. PLAN 5.4: this must happen before
    /// any window, DC or bitmap is created, because the desktop association is
    /// per-thread and is fixed at handle-creation time. Call it late and the
    /// capture silently reads the wrong desktop.
    /// </summary>
    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetThreadDesktop(IntPtr desktop);

    [DllImport(Library, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseDesktop(IntPtr desktop);

    [DllImport(Library, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetUserObjectInformation(
        IntPtr handle, int index, [Out] byte[] info, uint length, out uint lengthNeeded);

    /// <summary>
    /// Ctrl+Alt+Del. <c>SendInput</c> cannot produce this — the Secure Attention
    /// Sequence is reserved by the kernel precisely so that no program can fake
    /// it — so the elevated helper asks Windows to generate it instead.
    ///
    /// <c>asUser: false</c> means "as the SYSTEM service", which is what the
    /// helper is.
    /// </summary>
    [DllImport("sas.dll", SetLastError = true)]
    public static extern void SendSAS([MarshalAs(UnmanagedType.Bool)] bool asUser);

    /// <summary>The name of a desktop handle: <c>Default</c>, <c>Winlogon</c>, …</summary>
    public static string NameOf(IntPtr desktop)
    {
        var buffer = new byte[256];
        if (!GetUserObjectInformation(desktop, UOI_NAME, buffer, (uint)buffer.Length, out var needed))
            return "";

        // The API returns a null-terminated UTF-16 string and a byte count.
        var chars = (int)Math.Min(needed, (uint)buffer.Length) / sizeof(char);
        var name = Encoding.Unicode.GetString(buffer, 0, chars * sizeof(char));
        var nul = name.IndexOf('\0');
        return nul >= 0 ? name[..nul] : name;
    }
}
