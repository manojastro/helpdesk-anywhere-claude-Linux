using System.Diagnostics;

namespace HelpdeskAnywhere.Applet.Forms;

/// <summary>
/// Feature Batch 2. A compact, optional chat window alongside the session
/// indicator. Purely additive: <see cref="IndicatorForm"/> — CLAUDE.md
/// constraints #2 and #3 — is untouched by this file. Hiding this window never
/// hides the indicator, and closing it never ends the session; only End Session
/// on the indicator does that (enforced by <see cref="AppletContext"/>, which
/// owns this window's lifetime and disposes it as part of the one teardown
/// path, never through this window's own close button).
///
/// Deliberately simpler than the technician console's chat: no send/sent/failed
/// state machine and no client-side message-id reconciliation. The customer's
/// own messages are shown the instant they are typed, trusting an open socket
/// rather than waiting for the server's echo of it — the echo of the
/// customer's own message (<c>senderRole:"host"</c>) is never handed to this
/// window at all (<see cref="AppletContext"/> filters it out), so it can never
/// render twice. Only a message actually authored by the technician
/// (<c>senderRole:"agent"</c>) is ever appended as incoming.
/// </summary>
internal sealed class ChatForm : Form
{
    private readonly RichTextBox _log;
    private readonly TextBox _composer;
    private readonly Button _send;
    private readonly Label _state;

    /// <summary>The user pressed Send (or Enter) with non-empty text.</summary>
    public event Action<string>? MessageSubmitted;

    public ChatForm(string agentName)
    {
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        Text = $"Chat with {agentName}";
        ClientSize = new Size(320, 380);
        BackColor = Color.FromArgb(27, 30, 36);
        Font = new Font("Segoe UI", 9.25f);

        _state = new Label
        {
            Text = "Connecting…",
            Dock = DockStyle.Top,
            Height = 22,
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(8, 0, 0, 0),
            ForeColor = Color.FromArgb(186, 192, 202),
            BackColor = Color.FromArgb(20, 22, 27),
        };

        var composerRow = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 60,
            BackColor = Color.FromArgb(27, 30, 36),
            Padding = new Padding(6),
        };

        _send = new Button
        {
            Dock = DockStyle.Right,
            Width = 60,
            Text = "Send",
            Enabled = false,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(46, 107, 230),
            ForeColor = Color.White,
        };
        _send.FlatAppearance.BorderSize = 0;
        _send.Click += (_, _) => Submit();

        _composer = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            Enabled = false,
            PlaceholderText = "Type a message…",
            MaxLength = 4000,
        };
        _composer.KeyDown += OnComposerKeyDown;

        // Fill added last so it claims exactly what Top/Bottom leave behind.
        composerRow.Controls.Add(_composer);
        composerRow.Controls.Add(_send);

        _log = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BackColor = Color.FromArgb(20, 22, 27),
            ForeColor = Color.White,
            BorderStyle = BorderStyle.None,
            // Auto-detects a plain URL in the appended text and underlines it;
            // clicking raises LinkClicked rather than navigating by itself — the
            // customer's own click is still what decides whether it opens (§7A).
            DetectUrls = true,
            Font = new Font("Segoe UI", 9.25f),
        };
        _log.LinkClicked += OnLinkClicked;

        Controls.Add(_log);
        Controls.Add(composerRow);
        Controls.Add(_state);
    }

    /// <summary>
    /// The one state this window's lifetime actually has: it is created only
    /// after consent, when the session is already active, and this app has no
    /// reconnect path — a dropped socket ends the session for every feature,
    /// chat included (`shared/protocol.md`). So there is exactly one transition
    /// to show, and no Connecting/Unavailable to fabricate.
    /// </summary>
    public void SetConnected(bool connected)
    {
        _composer.Enabled = connected;
        _send.Enabled = connected;
        _state.Text = connected ? "Connected" : "Unavailable";
    }

    public void AppendIncoming(string text) => AppendLine("Support", text, Color.FromArgb(255, 196, 92));

    public void AppendIncomingUrl(string? label, string url)
    {
        var shown = string.IsNullOrWhiteSpace(label) ? url : $"{label} — {url}";
        AppendLine("Support shared a link", shown, Color.FromArgb(255, 196, 92));
    }

    private void OnComposerKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.Enter || e.Shift) return;
        e.SuppressKeyPress = true;
        e.Handled = true;
        Submit();
    }

    private void Submit()
    {
        var text = _composer.Text.Trim();
        if (text.Length == 0 || !_send.Enabled) return;

        AppendLine("You", text, Color.FromArgb(140, 180, 255));
        _composer.Clear();
        MessageSubmitted?.Invoke(text);
    }

    private void AppendLine(string who, string text, Color color)
    {
        _log.SelectionStart = _log.TextLength;
        _log.SelectionLength = 0;
        _log.SelectionColor = color;
        _log.SelectionFont = new Font(_log.Font, FontStyle.Bold);
        // AppendText, never SelectedRtf or anything that would parse `text` as
        // markup — chat content is untrusted plain text (§26), and RichTextBox's
        // own DetectUrls does the only "linkification" this window performs.
        _log.AppendText($"{who} · {DateTime.Now:t}{Environment.NewLine}");
        _log.SelectionFont = _log.Font;
        _log.SelectionColor = Color.White;
        _log.AppendText($"{text}{Environment.NewLine}{Environment.NewLine}");
        _log.ScrollToCaret();
    }

    /// <summary>
    /// Defense in depth: the server already refuses anything but http/https
    /// (`shared/protocol.md` "agent.chat"), but this window renders whatever
    /// text arrived, so the scheme is checked again before this process ever
    /// launches anything — and even then, only because the customer clicked it
    /// themselves (CLAUDE.md constraint #1's spirit: nothing here acts without
    /// that click).
    /// </summary>
    private static void OnLinkClicked(object? sender, LinkClickedEventArgs e)
    {
        if (!Uri.TryCreate(e.LinkText, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;

        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch
        {
            // Best effort: there is no default browser, or the shell refused it.
            // Nothing on this machine depends on the link having opened.
        }
    }

    /// <summary>
    /// Hiding, never closing: the X button is a convenience toggle, and
    /// <see cref="AppletContext"/> — not this window — owns when it is actually
    /// disposed (at session teardown). Mirrors why `IndicatorForm` cannot be
    /// closed away, but for a much lower stake: this window carries no
    /// consent/streaming state, so hiding it is simply hiding it.
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
        }
    }
}
