using System.Text;
using System.Text.Json;
using HelpdeskAnywhere.Shared;

// Exactly what SessionClient.Send<T>() puts on the wire.
static string Wire<T>(T msg) =>
    Encoding.UTF8.GetString(JsonSerializer.SerializeToUtf8Bytes(msg, Protocol.Json));

Console.WriteLine(Wire(new HostJoin { Code = "004821", Machine = "WIN-TEST", User = "alice", Os = "Microsoft Windows 10.0.22631" }));
Console.WriteLine(Wire(new HostConsent { Accepted = true }));
Console.WriteLine(Wire(new HostConsent { Accepted = false }));

// Inbound, as SessionClient.Dispatch() parses it.
var cr = JsonSerializer.Deserialize<HostConnectRequest>(
    """{"t":"host.connectRequest","agentName":"Support Agent"}""", Protocol.Json);
Console.WriteLine($"connectRequest agentName = '{cr!.AgentName}'");

var err = JsonSerializer.Deserialize<ProtocolError>(
    """{"t":"error","code":"bad_code","message":"That code is not valid."}""", Protocol.Json);
Console.WriteLine($"error {err!.Code} / {err.Message}");

var env = JsonSerializer.Deserialize<Envelope>(
    """{"t":"peer.left","role":"agent"}""", Protocol.Json);
Console.WriteLine($"envelope t = {env!.T}");
