// Replays the EXACT frames the Phase 2 applet emits (captured from
// SessionClient.Send<T>() on Linux) against the real relay, so the server half of
// the Phase 2 flow is verified before the Windows machine is involved.
import { WebSocket, URL_WS } from "../lib/harness.mjs";

const URL_ = URL_WS;
let failed = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const open = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.once("open", () => res(ws));
  ws.once("error", rej);
});
const next = (ws) => new Promise((res) => ws.once("message", (d, bin) => res(bin ? d : JSON.parse(d.toString()))));

// --- happy path -------------------------------------------------------------
const agent = await open(URL_);
agent.send(JSON.stringify({ t: "agent.create" }));
const created = await next(agent);
check(created.t === "session.created" && /^\d{6}$/.test(created.code), "agent.create → session.created", created.code);

const host = await open(URL_);
// Verbatim applet output, including a leading-zero-safe six-digit code.
host.send(`{"t":"host.join","code":"${created.code}","machine":"WIN-TEST","user":"alice","os":"Microsoft Windows 10.0.22631"}`);
const req = await next(host);
check(req.t === "host.connectRequest" && typeof req.agentName === "string" && req.agentName.length > 0,
  "applet host.join → host.connectRequest names an agent", JSON.stringify(req.agentName));
const joined = await next(agent);
check(joined.t === "peer.joined" && joined.info?.machine === "WIN-TEST", "agent sees peer.joined with host info");

host.send('{"t":"host.consent","accepted":true}');
const consent = await next(agent);
check(consent.t === "consent.result" && consent.accepted === true, "applet consent accept → consent.result true");
const hostPeer = await next(host);
check(hostPeer.t === "peer.joined" && hostPeer.role === "agent", "applet is told the agent attached");

// The agent ends it: the applet must see peer.left and a close (its hard-stop path).
const left = next(host);
const closed = new Promise((res) => host.once("close", (code, reason) => res({ code, reason: reason.toString() })));
agent.send(JSON.stringify({ t: "agent.end" }));
check((await left).t === "peer.left", "agent.end → applet gets peer.left");
const c = await closed;
check(c.code === 1000, "…then the relay closes the applet socket", `${c.code} ${c.reason}`);
agent.close();

// --- wrong code, socket stays open, retype succeeds -------------------------
const agent2 = await open(URL_);
agent2.send(JSON.stringify({ t: "agent.create" }));
const created2 = await next(agent2);

const host2 = await open(URL_);
host2.send(`{"t":"host.join","code":"000000","machine":"WIN-TEST","user":"alice","os":"Windows"}`);
const err = await next(host2);
check(err.t === "error" && err.code === "bad_code", "wrong code → error bad_code", err.message);
check(host2.readyState === WebSocket.OPEN, "socket stays open so the user can retype");
host2.send(`{"t":"host.join","code":"${created2.code}","machine":"WIN-TEST","user":"alice","os":"Windows"}`);
check((await next(host2)).t === "host.connectRequest", "retype on the same socket succeeds");

// --- decline ----------------------------------------------------------------
await next(agent2); // peer.joined
host2.send('{"t":"host.consent","accepted":false}');
const declined = await next(agent2);
check(declined.t === "consent.result" && declined.accepted === false, "decline → consent.result false");
const agentClosed = await new Promise((res) => agent2.once("close", (code) => res(code)));
check(agentClosed === 1000, "decline tears the session down at the agent too", String(agentClosed));
host2.close();

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
