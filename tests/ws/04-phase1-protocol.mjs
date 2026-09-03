/** Consent decline, state machine enforcement and role handshake. */
import { open, send, waitFor, check, report, sleep, WebSocket } from "../lib/harness.mjs";

console.log("\n=== Phase 1 acceptance — consent decline, state machine, handshake ===\n");

console.log("[8] host.consent{accepted:false} declines and tears the session down");
const a1 = await open();
send(a1, { t: "agent.create" });
const s1 = await waitFor(a1, (m) => m.t === "session.created");
const h1 = await open();
send(h1, { t: "host.join", code: s1.code, machine: "M", user: "u", os: "o" });
await waitFor(h1, (m) => m.t === "host.connectRequest");
send(h1, { t: "host.consent", accepted: false });
const res = await waitFor(a1, (m) => m.t === "consent.result");
check("agent receives consent.result accepted:false", res?.accepted === false);
await sleep(300);
check("agent socket closed after decline", a1.readyState === WebSocket.CLOSED, `rs=${a1.readyState}`);
check("host socket closed after decline", h1.readyState === WebSocket.CLOSED, `rs=${h1.readyState}`);

console.log("\n[9] First message must declare a role");
const rogue = await open();
send(rogue, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
const rogueErr = await waitFor(rogue, (m) => m.t === "error");
check("non-role first message → error protocol", rogueErr?.code === "protocol", JSON.stringify(rogueErr));
await sleep(200);
check("socket closed after undeclared role", rogue.readyState === WebSocket.CLOSED);

const junk = await open();
junk.send("this is not json");
const junkErr = await waitFor(junk, (m) => m.t === "error");
check("malformed JSON → error protocol", junkErr?.code === "protocol");
await sleep(200);
check("socket closed after malformed JSON", junk.readyState === WebSocket.CLOSED);

console.log("\n[10] Agent input before consent is dropped (state machine)");
const a2 = await open();
send(a2, { t: "agent.create" });
const s2 = await waitFor(a2, (m) => m.t === "session.created");
send(a2, { t: "agent.input", kind: "key", code: "KeyB", action: "down" });
const na = await waitFor(a2, (m) => m.t === "error" && m.code === "not_active");
check("agent.input while waiting_for_host → not_active", !!na);

const h2 = await open();
send(h2, { t: "host.join", code: s2.code, machine: "M", user: "u", os: "o" });
await waitFor(h2, (m) => m.t === "host.connectRequest");
send(a2, { t: "agent.input", kind: "key", code: "KeyC", action: "down" });
await sleep(300);
check("agent.input while waiting_for_consent never reaches host",
  !h2.received.find((m) => m.t === "agent.input"));

console.log("\n[11] Host dropping tears down the agent side");
send(h2, { t: "host.consent", accepted: true });
await waitFor(a2, (m) => m.t === "consent.result");
h2.terminate();
const left = await waitFor(a2, (m) => m.t === "peer.left" && m.role === "host", 3000);
check("agent receives peer.left role:host", !!left);
await sleep(300);
check("agent socket closed after host drop", a2.readyState === WebSocket.CLOSED, `rs=${a2.readyState}`);

await sleep(100);
report("protocol block");
