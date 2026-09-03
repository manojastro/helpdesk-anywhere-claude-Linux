namespace HelpdeskAnywhere.Applet.Forms;

/// <summary>
/// PLAN 2.2 step 1 — the first thing the end user sees: the server address
/// (pre-filled), a six-digit code box, Connect, and clear error text.
///
/// A refused code does not close the socket, so the user can simply retype
/// (`DEV_NOTES.md` "A refused host.join does not close the socket"). Guessing is
/// capped by the relay's per-IP limiter, not by anything here.
/// </summary>
internal sealed class CodeEntryForm : Form
{
    private readonly TextBox _server;
    private readonly TextBox _code;
    private readonly Button _connect;
    private readonly Label _status;
    private readonly LinkLabel _advanced;
    private readonly Label _serverLabel;

    /// <summary>Raised with the entered server URL and code when Connect is pressed.</summary>
    public event Action<string, string>? ConnectRequested;

    public CodeEntryForm(string serverUrl, string? presetCode)
    {
        Text = "Helpdesk Anywhere";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 300);
        Font = new Font("Segoe UI", 9.75f);
        BackColor = Color.White;

        var heading = new Label
        {
            Text = "Connect to your support agent",
            Font = new Font("Segoe UI", 14f, FontStyle.Bold),
            Location = new Point(24, 22),
            Size = new Size(372, 30),
        };

        var lead = new Label
        {
            Text = "Type the six-digit code your agent gave you.",
            ForeColor = Color.FromArgb(84, 90, 99),
            Location = new Point(24, 52),
            Size = new Size(372, 22),
        };

        _code = new TextBox
        {
            Font = new Font("Consolas", 26f, FontStyle.Bold),
            TextAlign = HorizontalAlignment.Center,
            MaxLength = AppletConfig.CodeLength,
            Location = new Point(24, 84),
            Size = new Size(372, 52),
            Text = presetCode ?? "",
        };
        _code.KeyPress += OnCodeKeyPress;
        _code.TextChanged += (_, _) => UpdateConnectEnabled();

        _status = new Label
        {
            ForeColor = Color.FromArgb(178, 34, 34),
            Location = new Point(24, 142),
            Size = new Size(372, 36),
        };

        _connect = new Button
        {
            Text = "Connect",
            Location = new Point(24, 182),
            Size = new Size(372, 40),
            BackColor = Color.FromArgb(26, 99, 216),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 11f, FontStyle.Bold),
        };
        _connect.FlatAppearance.BorderSize = 0;
        _connect.Click += (_, _) => RaiseConnect();

        _advanced = new LinkLabel
        {
            Text = "Server address",
            Location = new Point(24, 234),
            Size = new Size(140, 20),
        };

        _serverLabel = new Label
        {
            Text = "Only change this if your agent asks you to.",
            ForeColor = Color.FromArgb(84, 90, 99),
            Location = new Point(24, 234),
            Size = new Size(372, 20),
            Visible = false,
        };

        _server = new TextBox
        {
            Text = serverUrl,
            Location = new Point(24, 256),
            Size = new Size(372, 26),
            Visible = false,
        };

        _advanced.LinkClicked += (_, _) => SetServerVisible(!_server.Visible);

        AcceptButton = _connect;
        Controls.AddRange([heading, lead, _code, _status, _connect, _advanced, _serverLabel, _server]);

        UpdateConnectEnabled();
        ActiveControl = _code;
    }

    /// <summary>Digits only — the code is six characters and nothing else.</summary>
    private static void OnCodeKeyPress(object? sender, KeyPressEventArgs e)
    {
        if (!char.IsControl(e.KeyChar) && !char.IsAsciiDigit(e.KeyChar)) e.Handled = true;
    }

    private void SetServerVisible(bool visible)
    {
        _advanced.Visible = !visible;
        _serverLabel.Visible = visible;
        _server.Visible = visible;
    }

    private void UpdateConnectEnabled() =>
        _connect.Enabled = !Busy && AppletConfig.IsValidCode(_code.Text);

    private void RaiseConnect()
    {
        if (!_connect.Enabled) return;
        ShowStatus("");
        ConnectRequested?.Invoke(_server.Text, _code.Text);
    }

    /// <summary>True while a connect attempt is in flight; the form goes read-only.</summary>
    public bool Busy { get; private set; }

    public void SetBusy(bool busy, string? message = null)
    {
        Busy = busy;
        _code.ReadOnly = busy;
        _server.ReadOnly = busy;
        _connect.Text = busy ? "Connecting…" : "Connect";
        UseWaitCursor = busy;

        if (message is not null)
        {
            _status.ForeColor = Color.FromArgb(84, 90, 99);
            _status.Text = message;
        }

        UpdateConnectEnabled();
    }

    /// <summary>Show a refusal and let the user retype (PLAN 2.2).</summary>
    public void ShowError(string message)
    {
        SetBusy(false);
        _status.ForeColor = Color.FromArgb(178, 34, 34);
        _status.Text = message;
        _code.SelectAll();
        ActiveControl = _code;
    }

    private void ShowStatus(string message)
    {
        _status.ForeColor = Color.FromArgb(84, 90, 99);
        _status.Text = message;
    }

}
