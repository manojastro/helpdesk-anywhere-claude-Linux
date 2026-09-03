using HelpdeskAnywhere.Applet;

int failed = 0;
void Url(string input, string? expected)
{
    var ok = AppletConfig.TryParseServerUrl(input, out var uri, out var err);
    var actual = ok ? uri!.ToString() : $"ERROR: {err}";
    var pass = expected is null ? !ok : ok && uri!.ToString() == expected;
    if (!pass) failed++;
    Console.WriteLine($"{(pass ? "ok  " : "FAIL")}  {input,-42} -> {actual}");
}
void Code(string input, bool expected)
{
    var pass = AppletConfig.IsValidCode(input) == expected;
    if (!pass) failed++;
    Console.WriteLine($"{(pass ? "ok  " : "FAIL")}  code {input,-12} -> {AppletConfig.IsValidCode(input)}");
}

Url("example.duckdns.org", "wss://example.duckdns.org/ws");
Url("  example.duckdns.org  ", "wss://example.duckdns.org/ws");
Url("https://example.duckdns.org", "wss://example.duckdns.org/ws");
Url("https://example.duckdns.org/", "wss://example.duckdns.org/ws");
Url("wss://example.duckdns.org/ws", "wss://example.duckdns.org/ws");
Url("http://localhost:8080", "ws://localhost:8080/ws");
Url("ws://localhost:8080/ws", "ws://localhost:8080/ws");
Url("localhost:8080", "wss://localhost:8080/ws");
Url("https://example.org/custom", "wss://example.org/custom");
Url("https://example.org/ws?x=1#y", "wss://example.org/ws");
Url("", null);
Url("   ", null);
Url("ftp://example.org", null);
Url("file:///etc/passwd", null);
Url("://nope", null);

Code("482913", true);
Code("004821", true);
Code("48291", false);
Code("4829133", false);
Code("48a913", false);
Code("", false);
Code("４８２９１３", false);

Console.WriteLine(failed == 0 ? "\nALL PASS" : $"\n{failed} FAILED");
return failed == 0 ? 0 : 1;
