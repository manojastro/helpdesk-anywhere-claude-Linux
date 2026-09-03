namespace HelpdeskAnywhere.Applet.Forms;

/// <summary>
/// PLAN 2.2 step 3 and CLAUDE.md constraints #2 and #3: while a session is live
/// the user always knows, and can always stop it in one click.
///
/// This window is a feature, not chrome. It is borderless, always on top, has no
/// close box, cannot be minimised, and re-asserts its z-order on a timer so a
/// later topmost window cannot bury it. It *can* be dragged, because "get it out
/// of the way" is a legitimate need and hiding it is not the way to grant that.
/// Never add an option that suppresses it.
/// </summary>
internal sealed class IndicatorForm : Form
{
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;

    private const int EdgeGap = 16;
    private const int DotSize = 14;

    private readonly Label _title;
    private readonly Label _notice;
    private readonly System.Windows.Forms.Timer _assertTopmost;

    private Point _dragOrigin;
    private bool _dragging;
    private bool _ending;

    /// <summary>The user pressed End Session (or closed the window, which means the same).</summary>
    public event Action? EndSessionRequested;

    public IndicatorForm(string agentName)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = true;
        Text = "Helpdesk Anywhere — session active";
        ClientSize = new Size(340, 92);
        BackColor = Color.FromArgb(27, 30, 36);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 9.75f);

        _title = new Label
        {
            Text = $"Screen is being shared with {agentName}",
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = Color.White,
            Location = new Point(34, 14),
            Size = new Size(292, 20),
            BackColor = Color.Transparent,
        };

        _notice = new Label
        {
            Text = "They can see this screen and control it.",
            ForeColor = Color.FromArgb(186, 192, 202),
            Location = new Point(34, 34),
            Size = new Size(292, 18),
            BackColor = Color.Transparent,
        };

        var end = new Button
        {
            Text = "End Session",
            Location = new Point(14, 56),
            Size = new Size(312, 28),
            BackColor = Color.FromArgb(190, 40, 40),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
        };
        end.FlatAppearance.BorderSize = 0;
        end.Click += (_, _) => RequestEnd();

        Controls.AddRange([_title, _notice, end]);

        foreach (var draggable in new Control[] { this, _title, _notice })
        {
            draggable.MouseDown += OnDragStart;
            draggable.MouseMove += OnDragMove;
            draggable.MouseUp += (_, _) => _dragging = false;
        }

        _assertTopmost = new System.Windows.Forms.Timer { Interval = 2000 };
        _assertTopmost.Tick += (_, _) => Reassert();
        _assertTopmost.Start();

        MoveToCorner();
    }

    /// <summary>
    /// Surface something the user must know about mid-session — currently an
    /// elevation attempt (CLAUDE.md constraint #6: "the user consented to being
    /// helped, not to silent privilege escalation"). Phase 5 calls this.
    /// </summary>
    public void ShowNotice(string text)
    {
        _notice.Text = text;
        _notice.ForeColor = Color.FromArgb(255, 196, 92);
    }

    private void RequestEnd()
    {
        if (_ending) return;
        _ending = true;
        EndSessionRequested?.Invoke();
    }

    /* ------------------------------------------------------------- positioning */

    private void MoveToCorner()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - Width - EdgeGap, area.Bottom - Height - EdgeGap);
    }

    /// <summary>
    /// Re-assert topmost without stealing focus, and pull the window back on
    /// screen if the desktop was resized or a display disconnected under it.
    /// </summary>
    private void Reassert()
    {
        if (_ending) return;

        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;

        // Toggling re-inserts the window at the top of the topmost band; unlike
        // Activate() it does not take focus from whatever the user is typing in.
        TopMost = false;
        TopMost = true;

        var bounds = Screen.FromControl(this).WorkingArea;
        if (!bounds.IntersectsWith(Bounds)) MoveToCorner();
    }

    private void OnDragStart(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _dragging = true;
        _dragOrigin = e.Location;
        if (sender is Control c && !ReferenceEquals(c, this))
        {
            _dragOrigin = new Point(e.X + c.Left, e.Y + c.Top);
        }
    }

    private void OnDragMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging) return;

        var offset = e.Location;
        if (sender is Control c && !ReferenceEquals(c, this))
        {
            offset = new Point(e.X + c.Left, e.Y + c.Top);
        }

        Location = new Point(Location.X + offset.X - _dragOrigin.X,
                             Location.Y + offset.Y - _dragOrigin.Y);
    }

    /* ------------------------------------------------------------------ chrome */

    /// <summary>The red dot. Painted rather than shipped as an image asset.</summary>
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);

        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using var dot = new SolidBrush(Color.FromArgb(228, 62, 62));
        e.Graphics.FillEllipse(dot, 14, 16, DotSize, DotSize);

        using var border = new Pen(Color.FromArgb(70, 76, 88));
        e.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
    }

    /// <summary>
    /// Any close is an end-of-session, never a hide (constraint #2). Logging off
    /// or shutting down goes through the same idempotent teardown (PLAN 2.4).
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);

        if (_ending) return;

        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            RequestEnd();
            return;
        }

        Program.Teardown();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg is WM_QUERYENDSESSION or WM_ENDSESSION) Program.Teardown();
        base.WndProc(ref m);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _assertTopmost.Dispose();
        base.Dispose(disposing);
    }
}
