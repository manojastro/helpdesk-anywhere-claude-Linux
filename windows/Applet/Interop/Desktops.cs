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

    /// <summary>
    /// The least access that still lets a caller name a desktop. Asking for
    /// GENERIC_ALL to answer "which desktop has input?" turns an ordinary query
    /// into one the interactive user is refused on their own Default desktop
    /// under some policies; this is enough for <c>GetUserObjectInformation</c>.
    /// </summary>
    public const uint DESKTOP_READOBJECTS = 0x0001;

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

    /// <summary>The desktop this thread is bound to — what capture will actually read.</summary>
    [DllImport(Library, SetLastError = true)]
    public static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

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

    /// <summary>
    /// The name of the desktop this thread is bound to, or "" if it cannot be
    /// read. This is the desktop every DC and bitmap created here will belong to.
    /// </summary>
    public static string ThreadDesktopName()
    {
        // Not closed: GetThreadDesktop does not open a new handle, and closing
        // the thread's own desktop handle is documented as invalid.
        var handle = GetThreadDesktop(GetCurrentThreadId());
        return handle == IntPtr.Zero ? "" : NameOf(handle);
    }

    /// <summary>
    /// Which desktop is currently receiving input, from the calling process's
    /// point of view.
    ///
    /// THE THING THAT BROKE MT-06 (2026-09-05): this is scoped to the window
    /// station of the CALLING PROCESS, and window stations are per-session. A
    /// LocalSystem service in session 0 lives on <c>Service-0x0-3e7$</c>, which
    /// has no input desktop, so it can never see the interactive session switch
    /// from <c>Default</c> to <c>Winlogon</c> — it gets a failure, or its own
    /// window station's Default, and either way it never notices UAC. Only a
    /// process running inside the interactive session, on <c>WinSta0</c>, can
    /// answer this question. That is why <c>SessionWatcher</c> exists.
    ///
    /// Returns:
    ///  * the name, when the input desktop can be opened;
    ///  * <see cref="Denied"/>, when it exists but this process may not open it —
    ///    which is precisely what an unelevated process sees while a UAC prompt is
    ///    on the Secure Desktop, and is therefore a positive signal, not an error;
    ///  * "" when it cannot be determined at all, which callers must treat as
    ///    "carry on", never as "a secure desktop is up".
    /// </summary>
    public static string InputDesktopName(out int error)
    {
        error = 0;
        var handle = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (handle == IntPtr.Zero)
        {
            error = Marshal.GetLastWin32Error();
            return error == ErrorAccessDenied ? Denied : "";
        }

        try { return NameOf(handle); }
        finally { CloseDesktop(handle); }
    }

    /// <summary>
    /// Stand-in name for "there is an input desktop and this process may not open
    /// it". Not a real desktop name, and deliberately not one: it must never be
    /// passed to <c>OpenDesktop</c>.
    /// </summary>
    public const string Denied = "<denied>";

    public const int ErrorAccessDenied = 5;

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
