namespace HelpdeskAnywhere.Applet.Forms;

/// <summary>
/// PLAN 2.2 step 2 and CLAUDE.md constraint #1: explicit consent before every
/// session. Nothing is captured or streamed until this dialog returns Accept —
/// the relay itself also drops any frame sent before <c>host.consent{true}</c>.
///
/// Deliberately hard to dismiss by accident: topmost, centered, no control box,
/// Esc swallowed. Every route out other than the Accept button — Alt+F4, task
/// manager, shutdown — resolves to Decline, so the failure mode is "no session",
/// never "session the user did not agree to". Do not add a default button;
/// consent must be a deliberate click.
/// </summary>
internal sealed class ConsentForm : Form
{
    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_CLOSE = 0xF060;

    /// <summary>True only if the Accept button was pressed.</summary>
    public bool Accepted { get; private set; }

    public ConsentForm(string agentName, bool secureTransport)
    {
        Text = "Allow remote support?";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        TopMost = true;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, secureTransport ? 300 : 336);
        Font = new Font("Segoe UI", 9.75f);
        BackColor = Color.White;

        var heading = new Label
        {
            Text = $"{agentName} is requesting to view and control this computer.",
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            Location = new Point(24, 24),
            Size = new Size(412, 60),
        };

        var detail = new Label
        {
            Text =
                "If you accept, they will be able to:\n" +
                "    •  see everything on your screen\n" +
                "    •  move your mouse and type on your keyboard\n" +
                "    •  run support commands on this computer\n\n" +
                "A red indicator stays on your screen for the whole session, and you " +
                "can end it at any time from that indicator.",
            ForeColor = Color.FromArgb(40, 44, 52),
            Location = new Point(24, 90),
            Size = new Size(412, 132),
        };

        var y = 224;

        if (!secureTransport)
        {
            // CLAUDE.md "Public URL and TLS": plaintext is a dev-only path, and the
            // person being asked to consent is the one who deserves to know.
            var warning = new Label
            {
                Text = "⚠  This connection is not encrypted. Only continue on a trusted network.",
                ForeColor = Color.FromArgb(150, 90, 0),
                BackColor = Color.FromArgb(255, 246, 224),
                Location = new Point(24, y),
                Size = new Size(412, 30),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            Controls.Add(warning);
            y += 36;
        }

        var accept = new Button
        {
            Text = "Accept",
            Location = new Point(236, y),
            Size = new Size(200, 44),
            BackColor = Color.FromArgb(26, 99, 216),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 11f, FontStyle.Bold),
        };
        accept.FlatAppearance.BorderSize = 0;
        accept.Click += (_, _) =>
        {
            Accepted = true;
            DialogResult = DialogResult.OK;
            Close();
        };

        var decline = new Button
        {
            Text = "Decline",
            Location = new Point(24, y),
            Size = new Size(200, 44),
            FlatStyle = FlatStyle.System,
            Font = new Font("Segoe UI", 11f),
        };
        decline.Click += (_, _) =>
        {
            DialogResult = DialogResult.Cancel;
            Close();
        };

        Controls.AddRange([heading, detail, accept, decline]);

        // No AcceptButton: Enter must not consent on the user's behalf.
        ActiveControl = decline;
    }

    /// <summary>Esc must not dismiss the dialog (PLAN 2.2).</summary>
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape) return true;
        return base.ProcessCmdKey(ref msg, keyData);
    }

    /// <summary>Alt+F4 and the system Close command resolve to Decline, not to nothing.</summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_SYSCOMMAND && (m.WParam.ToInt32() & 0xFFF0) == SC_CLOSE)
        {
            DialogResult = DialogResult.Cancel;
            Close();
            return;
        }

        base.WndProc(ref m);
    }

    /// <summary>Bring it in front of whatever the user was doing, once.</summary>
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
    }
}
