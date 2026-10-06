using System.Text.Json;

using HelpdeskAnywhere.Applet.Scripting;
using HelpdeskAnywhere.Shared;

namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// Entry point for every Platform 2.0, Phase 2b message (file manager, file
/// transfer, clipboard text, system information, script cancel).
///
/// It sits beside the verified control path, not inside it: AppletContext hands
/// it only message types nothing else handles, and only after consent. Nothing
/// here touches capture, input, the desktop watch or elevation. Every action the
/// customer would want to know about is announced on their session indicator.
///
/// Runs on the UI thread (messages are posted there), which is also what the
/// WinForms clipboard needs (STA).
/// </summary>
internal sealed class FeatureHost : IDisposable
{
    private readonly SessionClient _client;
    private readonly Action<string> _notifyUser;
    private readonly ScriptRunner? _scripts;
    private readonly TransferManager _transfers;
    private bool _disposed;

    public FeatureHost(SessionClient client, Action<string> notifyUser, ScriptRunner? scripts)
    {
        _client = client;
        _notifyUser = notifyUser;
        _scripts = scripts;
        _transfers = new TransferManager(client, notifyUser);
    }

    /// <summary>True if <paramref name="type"/> was a feature message (handled or dropped).</summary>
    public bool TryHandle(string type, string json)
    {
        if (_disposed || !type.StartsWith("agent.", StringComparison.Ordinal)) return false;

        AgentFeatureRequest? r;
        try
        {
            r = JsonSerializer.Deserialize<AgentFeatureRequest>(json, Protocol.Json);
        }
        catch (JsonException)
        {
            return false;
        }
        if (r is null) return false;

        switch (type)
        {
            case FeatureProtocol.T.FsList:
                if (r.Rid is not null) _client.Send(FileService.List(r.Rid, r.Path));
                return true;
            case FeatureProtocol.T.FsMkdir:
                if (r.Rid is not null) Announce(FileService.Mkdir(r.Rid, r.Path), "created a folder");
                return true;
            case FeatureProtocol.T.FsRename:
                if (r.Rid is not null) Announce(FileService.Rename(r.Rid, r.Path, r.NewName), "renamed");
                return true;
            case FeatureProtocol.T.FsDelete:
                if (r.Rid is not null) Announce(FileService.Delete(r.Rid, r.Path), "deleted");
                return true;

            case FeatureProtocol.T.FilePut: _transfers.BeginUpload(r); return true;
            case FeatureProtocol.T.FileChunk: _transfers.Chunk(r); return true;
            case FeatureProtocol.T.FileEnd: _transfers.End(r); return true;
            case FeatureProtocol.T.FileGet: _transfers.BeginDownload(r); return true;
            case FeatureProtocol.T.FileAck: _transfers.Ack(r); return true;
            case FeatureProtocol.T.FileCancel: _transfers.Cancel(r.Tid); return true;

            case FeatureProtocol.T.ClipboardSet: SetClipboard(r); return true;
            case FeatureProtocol.T.ClipboardGet: GetClipboard(r); return true;

            case FeatureProtocol.T.SysinfoGet:
                if (r.Rid is null) return true;
                var rid = r.Rid;
                _ = Task.Run(() =>
                {
                    // Network and registry queries can take a moment; off the UI thread.
                    var info = SystemInfoCollector.Collect();
                    _client.Send(new HostSysinfo { Rid = rid, Info = info });
                });
                return true;

            case FeatureProtocol.T.ExecCancel:
                if (r.Id is not null && _scripts?.Cancel(r.Id) == true) _notifyUser("The technician stopped a script.");
                return true;
        }
        return false;
    }

    /// <summary>Send the result, and tell the customer about a change the technician made.</summary>
    private void Announce(HostFsResult result, string verb)
    {
        _client.Send(result);
        if (result.Ok && result.Path is { Length: > 0 } p)
        {
            _notifyUser($"The technician {verb}: {PathPolicy.Leaf(p)}{(result.NewName is null ? "" : $" → {result.NewName}")}");
        }
    }

    private void SetClipboard(AgentFeatureRequest r)
    {
        if (r.Rid is null) return;
        var text = r.Text ?? "";
        if (text.Length > FeatureProtocol.MaxClipboardChars)
        {
            _client.Send(new HostClipboardResult { Rid = r.Rid, Op = "set", Ok = false, Error = "That text is too long for the clipboard transfer." });
            return;
        }
        try
        {
            if (text.Length == 0) Clipboard.Clear();
            else Clipboard.SetText(text, TextDataFormat.UnicodeText);
            _client.Send(new HostClipboardResult { Rid = r.Rid, Op = "set", Ok = true });
            _notifyUser("The technician put text on your clipboard.");
        }
        catch (Exception ex)
        {
            _client.Send(new HostClipboardResult { Rid = r.Rid, Op = "set", Ok = false, Error = $"The clipboard is busy ({ex.GetType().Name}). Try again." });
        }
    }

    private void GetClipboard(AgentFeatureRequest r)
    {
        if (r.Rid is null) return;
        try
        {
            var text = Clipboard.ContainsText() ? Clipboard.GetText(TextDataFormat.UnicodeText) : "";
            var truncated = text.Length > FeatureProtocol.MaxClipboardChars;
            if (truncated) text = text[..FeatureProtocol.MaxClipboardChars];
            _client.Send(new HostClipboardResult { Rid = r.Rid, Op = "get", Ok = true, Text = text, Truncated = truncated ? true : null });
            // Reading someone's clipboard is exactly what they should hear about.
            _notifyUser("The technician copied the text on your clipboard.");
        }
        catch (Exception ex)
        {
            _client.Send(new HostClipboardResult { Rid = r.Rid, Op = "get", Ok = false, Error = $"The clipboard is busy ({ex.GetType().Name}). Try again." });
        }
    }

    /// <summary>Session end: stop every transfer and remove partial files.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _transfers.Dispose();
    }
}
