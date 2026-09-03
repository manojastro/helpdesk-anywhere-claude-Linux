namespace HelpdeskAnywhere.Applet.Input;

/// <summary>
/// DOM <c>event.code</c> → Windows virtual-key code (PLAN 4.2).
///
/// <c>event.code</c> is the *physical* key, so this table is layout-independent:
/// an agent on an AZERTY keyboard pressing the key where QWERTY has Q sends
/// <c>KeyQ</c>, and the remote machine applies its own layout. Using
/// <c>event.key</c> instead would scramble input between mismatched layouts.
/// </summary>
internal static class KeyMap
{
    /// <summary>
    /// Keys that need <c>KEYEVENTF_EXTENDEDKEY</c>. Without it the arrow keys and
    /// the navigation cluster are indistinguishable from their numpad twins, and
    /// right Alt/Ctrl behave as the left ones — which breaks AltGr entirely.
    /// </summary>
    private static readonly HashSet<string> Extended =
    [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
        "ControlRight", "AltRight", "NumpadDivide", "NumpadEnter",
        "NumLock", "PrintScreen", "ContextMenu", "MetaLeft", "MetaRight",
    ];

    private static readonly Dictionary<string, ushort> Codes = Build();

    public static bool TryVirtualKey(string code, out ushort vk) => Codes.TryGetValue(code, out vk);

    public static bool IsExtended(string code) => Extended.Contains(code);

    /// <summary>Modifier keys, tracked so they can be force-released (PLAN 4.2).</summary>
    public static bool IsModifier(string code) => code is
        "ShiftLeft" or "ShiftRight" or "ControlLeft" or "ControlRight" or
        "AltLeft" or "AltRight" or "MetaLeft" or "MetaRight";

    private static Dictionary<string, ushort> Build()
    {
        var map = new Dictionary<string, ushort>(StringComparer.Ordinal)
        {
            ["Escape"] = 0x1B,
            ["Backspace"] = 0x08,
            ["Tab"] = 0x09,
            ["Enter"] = 0x0D,
            ["Space"] = 0x20,
            ["CapsLock"] = 0x14,
            ["NumLock"] = 0x90,
            ["ScrollLock"] = 0x91,
            ["Pause"] = 0x13,
            ["PrintScreen"] = 0x2C,
            ["ContextMenu"] = 0x5D,

            ["ShiftLeft"] = 0xA0,
            ["ShiftRight"] = 0xA1,
            ["ControlLeft"] = 0xA2,
            ["ControlRight"] = 0xA3,
            ["AltLeft"] = 0xA4,
            ["AltRight"] = 0xA5,
            ["MetaLeft"] = 0x5B,
            ["MetaRight"] = 0x5C,

            ["Insert"] = 0x2D,
            ["Delete"] = 0x2E,
            ["Home"] = 0x24,
            ["End"] = 0x23,
            ["PageUp"] = 0x21,
            ["PageDown"] = 0x22,
            ["ArrowLeft"] = 0x25,
            ["ArrowUp"] = 0x26,
            ["ArrowRight"] = 0x27,
            ["ArrowDown"] = 0x28,

            ["Minus"] = 0xBD,
            ["Equal"] = 0xBB,
            ["BracketLeft"] = 0xDB,
            ["BracketRight"] = 0xDD,
            ["Backslash"] = 0xDC,
            ["Semicolon"] = 0xBA,
            ["Quote"] = 0xDE,
            ["Backquote"] = 0xC0,
            ["Comma"] = 0xBC,
            ["Period"] = 0xBE,
            ["Slash"] = 0xBF,
            ["IntlBackslash"] = 0xE2,
            ["IntlRo"] = 0xC1,
            ["IntlYen"] = 0xDC,

            ["NumpadDivide"] = 0x6F,
            ["NumpadMultiply"] = 0x6A,
            ["NumpadSubtract"] = 0x6D,
            ["NumpadAdd"] = 0x6B,
            ["NumpadDecimal"] = 0x6E,
            ["NumpadEnter"] = 0x0D,
        };

        // Letters: KeyA..KeyZ → VK 0x41..0x5A (they share ASCII values).
        for (var c = 'A'; c <= 'Z'; c++) map[$"Key{c}"] = (ushort)c;

        // Digits: Digit0..Digit9 → VK 0x30..0x39.
        for (var d = 0; d <= 9; d++) map[$"Digit{d}"] = (ushort)('0' + d);

        // Numpad digits: VK_NUMPAD0 = 0x60.
        for (var d = 0; d <= 9; d++) map[$"Numpad{d}"] = (ushort)(0x60 + d);

        // Function keys: VK_F1 = 0x70, contiguous through F24.
        for (var f = 1; f <= 24; f++) map[$"F{f}"] = (ushort)(0x70 + f - 1);

        return map;
    }
}
