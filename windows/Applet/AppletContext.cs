using System.Text.Json;

using HelpdeskAnywhere.Applet.Capture;
using HelpdeskAnywhere.Applet.Forms;
using HelpdeskAnywhere.Applet.Input;
using HelpdeskAnywhere.Applet.Scripting;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet;

/// <summary>
/// Drives the applet's one and only flow (PLAN 2.2): code entry → consent →
/// live-session indicator → teardown. Owns the transport so the forms stay
/// presentation-only.
///
/// The ordering here is a security property, not a UI preference: the consent
/// dialog is shown, and answered, before anything else can happen, and a
/// Decline is a full teardown rather than a return to the code box.
/// </summary>
internal sealed class AppletContext : ApplicationContext
{
    private const string UnknownAgent = "Your support agent";

    /// <summary>
    /// A handle-owning control created on the UI thread. Creating it installs the
    /// WinForms synchronization context, which <see cref="SessionClient"/> uses to
    /// raise every event back on this thread.
    /// </summary>
    private readonly Control _marshal;

    private readonly SynchronizationContext _ui;
    private readonly CodeEntryForm _codeForm;

    private SessionClient? _client;
    private ConsentForm? _consentForm;
    private IndicatorForm? _indicator;
    private ScreenStreamer? _streamer;
    private InputInjector? _injector;
    private ScriptRunner? _scripts;

    private string _agentName = UnknownAgent;
    private bool _consented;
    private bool _finished;

    public AppletContext(string serverUrl, string? presetCode)
    {
        _marshal = new Control();
        _ = _marshal.Handle;
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        _codeForm = new CodeEntryForm(serverUrl, presetCode);
        _codeForm.ConnectRequested += OnConnectRequested;
        _codeForm.FormClosed += (_, _) =>
        {
            if (!_consented) Finish("closed before the session started");
        };

        _codeForm.Show();
    }

    /* ------------------------------------------------------------------ connect */

    private async void OnConnectRequested(string serverText, string code)
    {
        if (!AppletConfig.TryParseServerUrl(serverText, out var uri, out var urlError))
        {
            _codeForm.ShowError(urlError);
            return;
        }

        if (!AppletConfig.IsValidCode(code))
        {
            _codeForm.ShowError("The code is six digits.");
            return;
        }

        _codeForm.SetBusy(true, "Contacting the server…");

        // A refused code leaves the socket open (`DEV_NOTES.md`), so a retype
        // reuses the same connection rather than re-dialling the relay.
        if (_client is null || !_client.IsOpen || _client.Server != uri)
        {
            await DiscardClientAsync();

            var client = new SessionClient(uri, _ui);
            client.ConnectRequested += OnConnectRequest;
            client.ErrorReceived += OnServerError;
            client.PeerLeft += OnPeerLeft;
            client.Closed += OnClosed;
            client.Unhandled += OnUnhandled;

            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await client.ConnectAsync(timeout.Token);
            }
            catch (Exception)
            {
                await client.DisposeAsync();
                _codeForm.ShowError(
                    $"Could not reach {uri.Host}. Check your internet connection and " +
                    "that the address is right, then try again.");
                return;
            }

            _client = client;
            Program.TrackClient(client);
        }

        _codeForm.SetBusy(true, "Checking the code…");
        _client.SendJoin(code);
    }

    /* ------------------------------------------------------------------ consent */

    /// <summary>
    /// The code was accepted. Nothing has been captured or sent at this point and
    /// nothing will be until the user clicks Accept (CLAUDE.md constraint #1).
    /// </summary>
    private void OnConnectRequest(HostConnectRequest request)
    {
        if (_client is null || _finished) return;

        _agentName = string.IsNullOrWhiteSpace(request.AgentName)
            ? UnknownAgent
            : request.AgentName;

        _codeForm.Hide();

        _consentForm = new ConsentForm(_agentName, _client.IsSecure);
        var result = _consentForm.ShowDialog();
        var accepted = _consentForm.Accepted && result == DialogResult.OK;
        _consentForm.Dispose();
        _consentForm = null;

        // A drop while the dialog was open already tore the session down.
        if (_finished) return;

        _client.SendConsent(accepted);

        if (!accepted)
        {
            Finish("user declined consent");
            return;
        }

        _consented = true;
        _codeForm.Close();
        ShowIndicator();
        StartRemoteControl();
    }

    /// <summary>
    /// CLAUDE.md constraints #2 and #3. From here on the user can see the session
    /// exists and can end it in one click, for as long as it lasts.
    /// </summary>
    private void ShowIndicator()
    {
        _indicator = new IndicatorForm(_agentName);
        _indicator.EndSessionRequested += () => Finish("user ended the session");
        _indicator.Show();
    }

    /// <summary>
    /// PLAN 3.2 and 4.2. Capture and input both start here and nowhere else — after
    /// Accept, never before (CLAUDE.md constraint #1). One capture object is shared:
    /// the injector needs the same virtual-screen rectangle the frames were taken
    /// from, or a click lands somewhere other than where the agent aimed.
    ///
    /// A capture failure degrades the session to "connected but not streaming"
    /// rather than killing it, and says so on the indicator the user is watching.
    /// </summary>
    private void StartRemoteControl()
    {
        if (_client is null) return;

        try
        {
            var capture = new GdiCapture();
            _injector = new InputInjector(capture);
            Program.TrackInjector(_injector);

            _streamer = new ScreenStreamer(capture, _client);
            _streamer.Failed += reason => _ui.Post(_ => _indicator?.ShowNotice(reason), null);
            _streamer.Start();
            Program.TrackStreamer(_streamer);

            _scripts = new ScriptRunner(_client, notice => _ui.Post(_ => _indicator?.ShowNotice(notice), null));
            Program.TrackScripts(_scripts);
        }
        catch (Exception ex)
        {
            _indicator?.ShowNotice($"Screen sharing unavailable ({ex.GetType().Name}).");
        }
    }

    /// <summary>
    /// Control messages this phase's flow does not own. Input is injected only while
    /// a consented session is live — the relay already refuses to forward anything
    /// before that, and this is the second gate.
    /// </summary>
    private void OnUnhandled(string type, string json)
    {
        if (!_consented || _finished) return;

        try
        {
            switch (type)
            {
                case Protocol.T.AgentInput:
                    var input = JsonSerializer.Deserialize<AgentInput>(json, Protocol.Json);
                    if (input is not null) _injector?.Handle(input);
                    break;

                case Protocol.T.AgentExec:
                    var exec = JsonSerializer.Deserialize<AgentExec>(json, Protocol.Json);
                    if (exec is not null) _scripts?.Run(exec);
                    break;
            }
        }
        catch (JsonException)
        {
            // A malformed frame is dropped, not fatal.
        }
    }

    /* ------------------------------------------------------------------- errors */

    private void OnServerError(ProtocolError error)
    {
        if (_finished) return;

        // Before consent, a refusal is retryable: show it and let the user retype.
        var retryable = error.Code is "bad_code" or "code_expired" or "rate_limited";
        if (!_consented && _consentForm is null && retryable)
        {
            _codeForm.Show();
            _codeForm.ShowError(error.Message);
            return;
        }

        MessageBox.Show(
            error.Message,
            "Helpdesk Anywhere",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);

        Finish($"server error: {error.Code}");
    }

    private void OnPeerLeft(string who) => Finish($"{who} left the session");

    private void OnClosed(string reason)
    {
        if (_finished) return;

        // Before a session exists this is just a failed attempt — stay in the code
        // form. Once the session is live the relay has already torn it down at both
        // ends and the code is burned, so there is nothing to reconnect to: exit
        // (PLAN 2.3 "hard-stop and exit if the session is ended").
        if (!_consented && _consentForm is null)
        {
            _codeForm.Show();
            _codeForm.ShowError($"Connection lost — {reason}. Try again.");
            return;
        }

        Finish(reason);
    }

    /* ----------------------------------------------------------------- teardown */

    /// <summary>
    /// The single exit path (PLAN 2.4). Idempotent: closes the socket politely if
    /// there is still time, runs the global teardown, and ends the message loop.
    /// </summary>
    private async void Finish(string reason)
    {
        if (_finished) return;
        _finished = true;

        // Capture stops before anything else: no frame may outlive the session
        // (PLAN 3.7, CLAUDE.md constraint #2). Held keys and buttons are released
        // first — a stuck Ctrl left on the user's machine outlives everything else
        // here and is invisible to them (PLAN 4.2).
        // Scripts first: a process the agent started must not outlive the consent
        // that authorised it (PLAN 6.1).
        Program.TrackScripts(null);
        _scripts?.Dispose();
        _scripts = null;

        Program.TrackInjector(null);
        _injector?.ReleaseAll();
        _injector = null;

        Program.TrackStreamer(null);
        _streamer?.Dispose();
        _streamer = null;

        _consentForm?.Close();
        _indicator?.Close();
        _indicator?.Dispose();
        _indicator = null;

        await DiscardClientAsync(reason);

        Program.Teardown();

        _codeForm.Dispose();
        _marshal.Dispose();
        ExitThread();
    }

    private async Task DiscardClientAsync(string reason = "closing")
    {
        var client = _client;
        _client = null;
        Program.TrackClient(null);
        if (client is null) return;

        await client.CloseAsync(reason);
        await client.DisposeAsync();
    }
}
