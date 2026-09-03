using HelpdeskAnywhere.Applet.Capture;
using HelpdeskAnywhere.Applet.Interop;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Input;

/// <summary>
/// Turns <c>agent.input</c> messages into real Windows input (PLAN 4.2).
///
/// Every key and button that goes down is remembered, and
/// <see cref="ReleaseAll"/> lifts anything still held. A session that drops
/// mid-drag or mid-Ctrl must not leave the user's machine with a stuck modifier —
/// that is a genuinely nasty failure mode, and the user cannot see why their
/// machine has started behaving strangely after the helper has gone.
/// </summary>
internal sealed class InputInjector
{
    private readonly IScreenCapture _capture;
    private readonly HashSet<string> _heldKeys = new(StringComparer.Ordinal);
    private readonly HashSet<int> _heldButtons = [];

    public InputInjector(IScreenCapture capture) => _capture = capture;

    public void Handle(AgentInput input)
    {
        switch (input.Kind)
        {
            case "mouse":
                Mouse(input);
                break;
            case "key":
                Key(input);
                break;
        }
    }

    /* -------------------------------------------------------------------- mouse */

    private void Mouse(AgentInput input)
    {
        var flags = Interop.Input.MOUSEEVENTF_ABSOLUTE | Interop.Input.MOUSEEVENTF_VIRTUALDESK;
        uint data = 0;

        switch (input.Action)
        {
            case "move":
                flags |= Interop.Input.MOUSEEVENTF_MOVE;
                break;

            case "wheel":
                flags |= Interop.Input.MOUSEEVENTF_MOVE | Interop.Input.MOUSEEVENTF_WHEEL;
                data = unchecked((uint)(input.WheelDelta ?? 0));
                break;

            case "down":
            case "up":
                var down = input.Action == "down";
                var button = input.Button ?? 0;

                flags |= Interop.Input.MOUSEEVENTF_MOVE | (button switch
                {
                    1 => down ? Interop.Input.MOUSEEVENTF_MIDDLEDOWN : Interop.Input.MOUSEEVENTF_MIDDLEUP,
                    2 => down ? Interop.Input.MOUSEEVENTF_RIGHTDOWN : Interop.Input.MOUSEEVENTF_RIGHTUP,
                    _ => down ? Interop.Input.MOUSEEVENTF_LEFTDOWN : Interop.Input.MOUSEEVENTF_LEFTUP,
                });

                if (down) _heldButtons.Add(button);
                else _heldButtons.Remove(button);
                break;

            default:
                return;
        }

        var (nx, ny) = Normalise(input.X, input.Y);
        Send(new Interop.Input.INPUT
        {
            type = Interop.Input.INPUT_MOUSE,
            u = new Interop.Input.InputUnion
            {
                mi = new Interop.Input.MOUSEINPUT
                {
                    dx = nx,
                    dy = ny,
                    mouseData = data,
                    dwFlags = flags,
                },
            },
        });
    }

    /// <summary>
    /// Remote pixels → the 0–65535 absolute space <c>SendInput</c> expects.
    ///
    /// The frame the agent clicked on starts at the virtual desktop's origin, which
    /// is negative when a monitor sits left of or above the primary — so the origin
    /// is subtracted before scaling. Getting this wrong is the usual cause of "the
    /// cursor lands in the wrong place on multi-monitor" (PLAN 4.2). Scaling uses
    /// width-1 so the far edge is reachable at all.
    /// </summary>
    private (int X, int Y) Normalise(int x, int y)
    {
        var screen = _capture.VirtualScreen;
        var width = Math.Max(screen.Width - 1, 1);
        var height = Math.Max(screen.Height - 1, 1);

        var clampedX = Math.Clamp(x, 0, screen.Width - 1);
        var clampedY = Math.Clamp(y, 0, screen.Height - 1);

        return (
            (int)((long)clampedX * 65535 / width),
            (int)((long)clampedY * 65535 / height));
    }

    /* ----------------------------------------------------------------- keyboard */

    private void Key(AgentInput input)
    {
        var code = input.Code;
        if (string.IsNullOrEmpty(code)) return;
        if (!KeyMap.TryVirtualKey(code, out var vk)) return;

        var down = input.Action == "down";
        if (down) _heldKeys.Add(code);
        else _heldKeys.Remove(code);

        SendKey(vk, KeyMap.IsExtended(code), down);
    }

    private static void SendKey(ushort vk, bool extended, bool down)
    {
        // Scancodes rather than virtual keys: some applications (and every DirectInput
        // game) read the scancode and ignore the VK entirely (PLAN 4.2).
        var scan = (ushort)Interop.Input.MapVirtualKeyW(vk, Interop.Input.MAPVK_VK_TO_VSC);

        var flags = Interop.Input.KEYEVENTF_SCANCODE;
        if (extended) flags |= Interop.Input.KEYEVENTF_EXTENDEDKEY;
        if (!down) flags |= Interop.Input.KEYEVENTF_KEYUP;

        Send(new Interop.Input.INPUT
        {
            type = Interop.Input.INPUT_KEYBOARD,
            u = new Interop.Input.InputUnion
            {
                ki = new Interop.Input.KEYBDINPUT
                {
                    // wVk must be 0 when sending a scancode, or Windows uses the VK.
                    wVk = scan == 0 ? vk : (ushort)0,
                    wScan = scan,
                    dwFlags = scan == 0 ? flags & ~Interop.Input.KEYEVENTF_SCANCODE : flags,
                },
            },
        });
    }

    /* ------------------------------------------------------------------ cleanup */

    /// <summary>
    /// Release everything still held (PLAN 4.2). Called on session end, on peer
    /// drop, and from the crash path — a stuck Ctrl or a stuck mouse button left
    /// behind on the user's machine is worse than a lost session.
    /// </summary>
    public void ReleaseAll()
    {
        foreach (var code in _heldKeys.ToArray())
        {
            if (KeyMap.TryVirtualKey(code, out var vk)) SendKey(vk, KeyMap.IsExtended(code), down: false);
        }
        _heldKeys.Clear();

        foreach (var button in _heldButtons.ToArray())
        {
            var flags = button switch
            {
                1 => Interop.Input.MOUSEEVENTF_MIDDLEUP,
                2 => Interop.Input.MOUSEEVENTF_RIGHTUP,
                _ => Interop.Input.MOUSEEVENTF_LEFTUP,
            };

            Send(new Interop.Input.INPUT
            {
                type = Interop.Input.INPUT_MOUSE,
                u = new Interop.Input.InputUnion
                {
                    mi = new Interop.Input.MOUSEINPUT { dwFlags = flags },
                },
            });
        }
        _heldButtons.Clear();
    }

    private static void Send(Interop.Input.INPUT input)
    {
        var buffer = new[] { input };
        Interop.Input.SendInput(1, buffer, System.Runtime.InteropServices.Marshal.SizeOf<Interop.Input.INPUT>());
    }
}
