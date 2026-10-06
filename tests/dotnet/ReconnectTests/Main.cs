// Platform 2.0 Phase 3 — customer-side reconnect, with the applet's own SessionClient.
// Needs the suite's server (WS_URL, HDA_AGENT_COOKIE); run from tests/run-all.sh.
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using HelpdeskAnywhere.Applet;
using HelpdeskAnywhere.Shared;

var failed = 0;
void Check(string name, bool ok, string detail = "") { if (!ok) failed++; Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(detail.Length > 0 ? "  — " + detail : "")}"); }

var wsUrl = new Uri(Environment.GetEnvironmentVariable("WS_URL") ?? "ws://127.0.0.1:8099/ws");
var cookie = Environment.GetEnvironmentVariable("HDA_AGENT_COOKIE") ?? "";
var httpOrigin = $"http://{wsUrl.Authority}";

Console.WriteLine("\n=== Applet SessionClient reconnect (real C# against the real relay) ===\n");

// A technician socket, as the console opens it.
var agent = new ClientWebSocket();
agent.Options.SetRequestHeader("Cookie", cookie);
agent.Options.SetRequestHeader("Origin", httpOrigin);
await agent.ConnectAsync(wsUrl, CancellationToken.None);
var agentMsgs = new List<JsonElement>();
_ = Task.Run(async () =>
{
    var buf = new byte[1 << 20];
    var sb = new MemoryStream();
    while (agent.State == WebSocketState.Open)
    {
        WebSocketReceiveResult r;
        try { r = await agent.ReceiveAsync(buf, CancellationToken.None); } catch { break; }
        if (r.MessageType == WebSocketMessageType.Close) break;
        sb.Write(buf, 0, r.Count);
        if (!r.EndOfMessage) continue;
        if (r.MessageType == WebSocketMessageType.Text)
            lock (agentMsgs) agentMsgs.Add(JsonDocument.Parse(sb.ToArray()).RootElement.Clone());
        sb.SetLength(0);
    }
});
async Task SendAgent(object o) => await agent.SendAsync(JsonSerializer.SerializeToUtf8Bytes(o), WebSocketMessageType.Text, true, CancellationToken.None);
async Task<JsonElement?> WaitAgent(Func<JsonElement, bool> pred, int ms = 5000)
{
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until)
    {
        lock (agentMsgs) foreach (var m in agentMsgs) if (pred(m)) return m;
        await Task.Delay(30);
    }
    return null;
}
static string T(JsonElement m) => m.TryGetProperty("t", out var t) ? t.GetString() ?? "" : "";
static string Str(JsonElement m, string k) => m.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

await SendAgent(new { t = "agent.create" });
var created = await WaitAgent(m => T(m) == "session.created");
var code = created is { } c ? Str(c, "code") : "";
Check("technician created a session", code.Length == 6);

// The applet's transport — the exact class the .exe uses.
var client = new SessionClient(wsUrl, new SynchronizationContext());
var reconnecting = 0; var reconnected = 0; string? closed = null;
client.Reconnecting += () => Interlocked.Increment(ref reconnecting);
client.Reconnected += () => Interlocked.Increment(ref reconnected);
client.Closed += r => closed = r;
var connectRequested = new TaskCompletionSource();
client.ConnectRequested += _ => connectRequested.TrySetResult();
await client.ConnectAsync(CancellationToken.None);
client.SendJoin(code);
await Task.WhenAny(connectRequested.Task, Task.Delay(5000));
var joined = await WaitAgent(m => T(m) == "peer.joined");
Check("the applet joined and declared protocol 2 with resume",
    joined is { } j && j.GetProperty("protocolVersion").GetInt32() == 2 && j.GetProperty("capabilities").EnumerateArray().Any(e => e.GetString() == "resume"));
client.SendConsent(true);
await WaitAgent(m => T(m) == "consent.result");
await Task.Delay(400);

var resumeToken = typeof(SessionClient).GetField("_resumeToken", BindingFlags.NonPublic | BindingFlags.Instance)!;
Check("the relay issued a resume token at consent (kept inside the transport)", resumeToken.GetValue(client) is string { Length: > 40 });
var firstToken = (string?)resumeToken.GetValue(client);

// Cut the line underneath it, as a Wi-Fi drop would.
var wsField = typeof(SessionClient).GetField("_ws", BindingFlags.NonPublic | BindingFlags.Instance)!;
((ClientWebSocket)wsField.GetValue(client)!).Abort();

var disc = await WaitAgent(m => T(m) == "session.phase" && Str(m, "phase") == "DISCONNECTED", 8000);
Check("the technician is told the customer is reconnecting (DISCONNECTED)", disc is not null);
var back = await WaitAgent(m => T(m) == "session.phase" && Str(m, "phase") == "CONNECTED" && disc is not null, 15000);
Check("the applet came back by itself and the session is CONNECTED again", back is not null);
await Task.Delay(300);
Check("Reconnecting then Reconnected were raised once each", reconnecting == 1 && reconnected == 1, $"{reconnecting}/{reconnected}");
Check("no Closed — the session never ended", closed is null, closed ?? "");
Check("the token was rotated by the resume", resumeToken.GetValue(client) is string t2 && t2 != firstToken);
Check("the transport is open again", client.IsOpen);

// The same session still carries traffic both ways.
client.Send(new HostChat { Text = "still here", ClientId = Guid.NewGuid().ToString("n") });
var chat = await WaitAgent(m => T(m) == "chat.message" && Str(m, "text") == "still here");
Check("customer → technician works after the reconnect (same session)", chat is not null);

// A server-side end is final: no reconnect.
await SendAgent(new { t = "agent.end" });
await Task.Delay(1500);
Check("an end from the technician closes the applet without a reconnect attempt", closed is not null && reconnecting == 1, $"closed={closed} reconnecting={reconnecting}");

await client.DisposeAsync();
Console.WriteLine($"\n--- ReconnectTests: {(failed == 0 ? "all passed" : $"{failed} failed")} ---");
return failed == 0 ? 0 : 1;
