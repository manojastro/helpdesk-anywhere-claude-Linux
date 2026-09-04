using System.Text.Json;

using HelpdeskAnywhere.Applet.Capture;
using HelpdeskAnywhere.Applet.Elevation;
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
internal sealed class AppletContext : ApplicationContext, IFrameSinkForwarder
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
    private ElevationManager? _elevation;
    private SecureDesktopBridge? _bridge;

    /// <summary>
    /// The desktop the helper last reported. <c>"Default"</c> means the user's own
    /// desktop and the applet's own capture; anything else means a helper is
    /// driving (PLAN 5.6).
    /// </summary>
    private string _desktop = "Default";

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
                    RouteInput(json);
                    break;

                case Protocol.T.AgentRequestElevation:
                    var elevation = JsonSerializer.Deserialize<AgentRequestElevation>(json, Protocol.Json);
                    if (elevation is not null) RequestElevation(elevation);
                    break;

                case Protocol.T.AgentExec:
                    RouteExec(json);
                    break;
            }
        }
        catch (JsonException)
        {
            // A malformed frame is dropped, not fatal.
        }
    }

    /* --------------------------------------------------------------- elevation */

    /// <summary>
    /// PLAN 5.6. While a helper is attached the input belongs to the secure
    /// desktop, not the user's — a click meant for a UAC prompt must not land on
    /// the desktop behind it. Exactly one of the two paths runs.
    ///
    /// Ctrl+Alt+Del is separate because no injected key sequence can produce a
    /// Secure Attention Sequence; without a helper there is nothing to route it
    /// to, and it is dropped rather than silently downgraded to three key presses
    /// that do something else (PLAN 4.3).
    /// </summary>
    private void RouteInput(string json)
    {
        var input = JsonSerializer.Deserialize<AgentInput>(json, Protocol.Json);
        if (input is null) return;

        if (input.Kind == "sas")
        {
            _bridge?.TrySendSas();
            return;
        }

        if (_bridge?.TrySendInput(json) == true) return;
        _injector?.Handle(input);
    }

    /// <summary>
    /// PLAN 6.1 + 5.3. A script marked <c>asSystem</c> goes to the elevated
    /// service, which is the only process here that runs as SYSTEM. Without
    /// elevation it is refused with a clear message rather than silently run with
    /// the user's own privileges — that would be a lie about what just ran on
    /// their machine.
    /// </summary>
    private void RouteExec(string json)
    {
        var exec = JsonSerializer.Deserialize<AgentExec>(json, Protocol.Json);
        if (exec is null) return;

        if (exec.AsSystem)
        {
            if (_bridge?.TrySendExec(json) == true)
            {
                // The notice follows the dispatch, not the request: telling the
                // user a script ran as SYSTEM when it was actually refused would
                // make their indicator — the one thing they can always see — say
                // something untrue about their own machine (constraint #2).
                _indicator?.ShowNotice("The agent ran a script as SYSTEM on this computer.");
                return;
            }

            _client?.Send(new HostExecResult
            {
                Id = exec.Id,
                ExitCode = -1,
                Stdout = "",
                Stderr = "Run as SYSTEM needs elevation. Elevate the session first.",
            });
            return;
        }

        _scripts?.Run(exec);
    }

    /// <summary>
    /// PLAN 5.2. The server has already refused credential mode on a non-TLS
    /// connection and enforced the per-session attempt limit, so what arrives here
    /// is an attempt that is allowed to proceed.
    /// </summary>
    private void RequestElevation(AgentRequestElevation request)
    {
        if (_client is null) return;

        _elevation ??= new ElevationManager(
            notice => _ui.Post(_ => _indicator?.ShowNotice(notice), null),
            (ok, error) => _ui.Post(_ => OnElevationResult(ok, error), null));

        Program.TrackElevation(_elevation);

        // The bridge listens from the moment elevation is attempted, not from the
        // moment it succeeds: the service starts the first helper as soon as it
        // is running, and a helper with nowhere to connect would sit retrying.
        //
        // Re-created per attempt, because a failed attempt disposes it: the pipe
        // name belongs to the manager and does not change, so a retry that found
        // no listener here would install a service that could never connect to
        // the applet — and whose watchdog would then uninstall it a minute later.
        EnsureBridge(_elevation.PipeName);
        _elevation.OnShutdownRequested = () => _bridge?.RequestShutdown();

        _elevation.Request(request);
    }

    private void EnsureBridge(string pipeName)
    {
        if (_bridge is not null) return;

        _bridge = new SecureDesktopBridge(
            pipeName,
            this,
            OnDesktopChanged,
            notice => _ui.Post(_ => _indicator?.ShowNotice(notice), null),
            json => _client?.SendRaw(json));
        _bridge.Start();
    }

    private void OnElevationResult(bool ok, string? error)
    {
        if (_finished || _client is null) return;

        _client.Send(new HostElevated { Ok = ok, Error = error });

        if (!ok)
        {
            // Nothing was installed, so there is nothing for a helper to connect
            // to. Drop the listener rather than leaving a pipe open all session.
            _bridge?.Dispose();
            _bridge = null;
        }
    }

    /// <summary>
    /// PLAN 5.6. The console shows its "UAC prompt active" banner from this, and
    /// the applet's own capture pauses while the helper owns the screen — two
    /// capturers streaming at once would interleave two different desktops.
    /// </summary>
    private void OnDesktopChanged(string desktop)
    {
        _ui.Post(_ =>
        {
            if (_finished || _client is null) return;

            _desktop = string.IsNullOrWhiteSpace(desktop) ? "Default" : desktop;
            var secure = _desktop != "Default";

            _streamer?.SetPaused(secure);
            _client.Send(new HostDesktopChanged { Desktop = _desktop });

            _indicator?.ShowNotice(secure
                ? "A Windows security prompt is being shown to the agent."
                : "The agent is viewing your desktop again.");
        }, null);
    }

    /// <summary>
    /// A helper frame, already in the wire format, forwarded without decoding it
    /// (PLAN 5.5). Called from the pipe thread.
    /// </summary>
    void IFrameSinkForwarder.Forward(ReadOnlyMemory<byte> frame) =>
        _client?.TrySendFrame(frame);

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

        // The order below is the order of the promises, strongest first, and each
        // step is wrapped so a failure in one cannot stop the next. That matters
        // because each step un-tracks its object before disposing it: a throw
        // half-way would otherwise leave the object neither torn down here nor
        // reachable from Program.Teardown's backstop.

        // 1. Stop sending pixels. The user clicked End Session; not one more
        //    frame of their screen may leave this machine (PLAN 3.7, constraint
        //    #2). This is why it is first and not, as it once was, last.
        Program.Attempt(() =>
        {
            Program.TrackStreamer(null);
            _streamer?.Dispose();
            _streamer = null;
        });

        // 2. Release whatever the agent was holding. A stuck Ctrl or a held
        //    mouse button outlives everything else here and is invisible to the
        //    user, who has no idea why their machine is behaving strangely
        //    (PLAN 4.2).
        Program.Attempt(() =>
        {
            Program.TrackInjector(null);
            _injector?.ReleaseAll();
            _injector = null;
        });

        // 3. Kill anything the agent started, whole process tree. A process that
        //    outlives the consent authorising it is exactly what constraint #4
        //    forbids (PLAN 6.1).
        Program.Attempt(() =>
        {
            Program.TrackScripts(null);
            _scripts?.Dispose();
            _scripts = null;
        });

        // 4. Remove the elevated service, by every route available. Ask over the
        //    pipe first — the applet runs as the end user and normally cannot
        //    delete a LocalSystem service — then try directly, for the case where
        //    this process does hold the rights. The service's own watchdog is the
        //    third route, for the case where this code never runs at all. A
        //    SYSTEM service left behind is the single worst thing this program
        //    could do (constraint #4).
        Program.Attempt(() =>
        {
            Program.TrackElevation(null);
            _elevation?.Shutdown();      // asks over the pipe, then tries directly
            _bridge?.RequestShutdown();  // also covers an attempt that never reported
            _elevation = null;

            // Disposing the bridge closes the pipe, which also stops any helper
            // frames still being forwarded.
            _bridge?.Dispose();
            _bridge = null;
        });

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
