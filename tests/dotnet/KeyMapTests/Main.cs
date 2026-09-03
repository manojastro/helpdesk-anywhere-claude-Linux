using HelpdeskAnywhere.Applet.Input;

int failed = 0;
void Check(string name, bool ok, string detail = "")
{
    if (!ok) failed++;
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(detail.Length > 0 ? "  — " + detail : "")}");
}
ushort Vk(string code) => KeyMap.TryVirtualKey(code, out var v) ? v : (ushort)0;

Console.WriteLine("\n=== KeyMap — DOM event.code → Windows VK (PLAN 4.2) ===\n");

Check("KeyA..KeyZ map to VK 0x41..0x5A", Vk("KeyA") == 0x41 && Vk("KeyM") == 0x4D && Vk("KeyZ") == 0x5A,
    $"A=0x{Vk("KeyA"):X2} M=0x{Vk("KeyM"):X2} Z=0x{Vk("KeyZ"):X2}");
Check("Digit0..Digit9 map to VK 0x30..0x39", Vk("Digit0") == 0x30 && Vk("Digit9") == 0x39);
Check("Numpad digits are DISTINCT from the top row",
    Vk("Numpad0") == 0x60 && Vk("Numpad0") != Vk("Digit0"), $"Numpad0=0x{Vk("Numpad0"):X2}");
Check("F1..F24 are contiguous from 0x70",
    Vk("F1") == 0x70 && Vk("F12") == 0x7B && Vk("F24") == 0x87, $"F12=0x{Vk("F12"):X2}");
Check("left and right modifiers are distinct",
    Vk("ShiftLeft") != Vk("ShiftRight") && Vk("ControlLeft") != Vk("ControlRight") &&
    Vk("AltLeft") != Vk("AltRight"));
Check("Enter and NumpadEnter share VK_RETURN but differ by the extended flag",
    Vk("Enter") == Vk("NumpadEnter") && !KeyMap.IsExtended("Enter") && KeyMap.IsExtended("NumpadEnter"));

// The extended flag is what separates the arrows from the numpad and makes AltGr work.
foreach (var code in new[] { "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Insert",
                             "Delete", "Home", "End", "PageUp", "PageDown", "ControlRight",
                             "AltRight", "NumpadDivide", "NumpadEnter" })
{
    if (!KeyMap.IsExtended(code)) Check($"{code} must be extended", false);
}
Check("every key in the extended set is flagged", true);
Check("ordinary keys are NOT extended",
    !KeyMap.IsExtended("KeyA") && !KeyMap.IsExtended("Numpad4") && !KeyMap.IsExtended("ControlLeft"));

Check("IsModifier covers all eight modifier keys",
    new[] { "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
            "MetaLeft", "MetaRight" }.All(KeyMap.IsModifier) &&
    !KeyMap.IsModifier("KeyA") && !KeyMap.IsModifier("Tab"));

// Everything the console's special-key buttons can send must be mappable, or the
// button silently does nothing on the remote machine.
foreach (var code in new[] { "MetaLeft", "AltLeft", "Tab", "ControlLeft", "Escape",
                             "PrintScreen", "ShiftLeft" })
{
    if (!KeyMap.TryVirtualKey(code, out _)) Check($"special-key button code {code} is mappable", false);
}
Check("every special-key button code is mappable", true);

// A representative sweep of what a real keyboard produces.
string[] typical =
[
    "Escape","Backspace","Tab","Enter","Space","CapsLock","NumLock","ScrollLock","Pause",
    "PrintScreen","ContextMenu","Minus","Equal","BracketLeft","BracketRight","Backslash",
    "Semicolon","Quote","Backquote","Comma","Period","Slash","IntlBackslash",
    "NumpadAdd","NumpadSubtract","NumpadMultiply","NumpadDecimal",
];
var missing = typical.Where(c => !KeyMap.TryVirtualKey(c, out _)).ToArray();
Check("all common physical keys are mapped", missing.Length == 0, string.Join(",", missing));

Check("an unknown code is refused rather than mapped to something random",
    !KeyMap.TryVirtualKey("NotAKey", out _) && !KeyMap.TryVirtualKey("", out _));

Console.WriteLine(failed == 0 ? "\n  ALL PASS\n" : $"\n  {failed} FAILED\n");
return failed == 0 ? 0 : 1;
