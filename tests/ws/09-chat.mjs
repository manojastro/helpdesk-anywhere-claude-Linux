/**
 * Chat, Send URL and Notes at the relay (Feature Batch 2, `shared/protocol.md`
 * "agent.chat / host.chat / chat.message" and "agent.notes.save").
 *
 * Chat is layered around the remote-control engine, not through it, so this
 * block never touches `agent.input`/`agent.exec`/`agent.requestElevation` — it
 * drives the wire directly (no browser) to prove what the RELAY does: assigns
 * the canonical envelope (never trusts a client-supplied sender), refuses what
 * it should, keeps sessions isolated from each other, de-dupes a resend, and
 * lets chat through regardless of Hold.
 */
import { readFileSync, readdirSync } from "node:fs";
import { open, send, waitFor, check, sleep, report, AUDIT_DIR } from "../lib/harness.mjs";

const auditLines = () => readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8").trim().split("\n"))
  .filter(Boolean).map((l) => JSON.parse(l));

console.log("\n=== Feature Batch 2 — chat, Send URL, notes ===\n");

/** Build a consented, active session and return { agent, host, code }. */
async function pairedSession(label) {
  const agent = await open(`agent-${label}`);
  send(agent, { t: "agent.create" });
  const code = (await waitFor(agent, (m) => m.t === "session.created"))?.code;

  const host = await open(`host-${label}`);
  send(host, { t: "host.join", code, machine: `WIN-${label}`, user: "alice", os: "Windows 11" });
  await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  await waitFor(host, (m) => m.t === "peer.joined" && m.role === "agent");
  return { agent, host, code };
}

const a = await pairedSession("A");
const b = await pairedSession("B");

/* --- 1. technician -> customer -------------------------------------------- */
console.log("[9] technician -> customer");
a.agent.received.length = 0; a.host.received.length = 0;
send(a.agent, { t: "agent.chat", kind: "text", text: "I'm connecting now.", clientId: "c1" });

const toHost = await waitFor(a.host, (m) => m.t === "chat.message");
check("the customer receives it, attributed to the agent",
  toHost?.senderRole === "agent" && toHost.text === "I'm connecting now.", JSON.stringify(toHost));
check("the id is session-scoped and monotonic", /^\d{6}\.\d+$/.test(toHost?.id ?? ""), toHost?.id);

const echoToAgent = await waitFor(a.agent, (m) => m.t === "chat.message" && m.clientId === "c1");
check("the sender gets the same canonical message back, to reconcile its own bubble",
  echoToAgent?.id === toHost?.id && echoToAgent.senderRole === "agent", JSON.stringify(echoToAgent));

await sleep(150);
check("audited as metadata only — no text in the record (§11)",
  auditLines().some((l) => l.event === "chat.message" && l.code === a.code
    && l.senderRole === "agent" && l.length === "I'm connecting now.".length && l.text === undefined));

/* --- 2. customer -> technician --------------------------------------------- */
console.log("[9] customer -> technician");
a.agent.received.length = 0; a.host.received.length = 0;
send(a.host, { t: "host.chat", text: "It's stuck on 40%.", clientId: "h1" });

const toAgent = await waitFor(a.agent, (m) => m.t === "chat.message");
check("the technician receives it, attributed to the host",
  toAgent?.senderRole === "host" && toAgent.text === "It's stuck on 40%.", JSON.stringify(toAgent));
const echoToHost = await waitFor(a.host, (m) => m.t === "chat.message" && m.clientId === "h1");
check("the customer's own send is echoed back too", echoToHost?.id === toAgent?.id);

/* --- 3. session isolation ---------------------------------------------------- */
console.log("[9] session isolation");
b.agent.received.length = 0; b.host.received.length = 0;
send(a.agent, { t: "agent.chat", kind: "text", text: "session A only", clientId: "iso1" });
await sleep(200);
check("a different session's host never sees it",
  !b.host.received.some((m) => m.t === "chat.message"), JSON.stringify(b.host.received));
check("a different session's agent never sees it either",
  !b.agent.received.some((m) => m.t === "chat.message"));

/* --- 4. sender identity cannot be spoofed ------------------------------------ */
console.log("[9] sender identity cannot be spoofed");
a.host.received.length = 0;
send(a.agent, { t: "agent.chat", kind: "text", text: "spoof attempt", clientId: "spf1", senderRole: "host" });
const spoofed = await waitFor(a.host, (m) => m.t === "chat.message" && m.text === "spoof attempt");
check("the relay assigns senderRole from the socket, ignoring any client-supplied value",
  spoofed?.senderRole === "agent", JSON.stringify(spoofed));

/* --- 5. XSS payload is delivered as plain data, never interpreted ------------ */
console.log("[9] XSS payload travels as plain text");
a.host.received.length = 0;
const xss = "<script>alert(1)</script>";
send(a.agent, { t: "agent.chat", kind: "text", text: xss, clientId: "xss1" });
const xssMsg = await waitFor(a.host, (m) => m.t === "chat.message" && m.clientId === "xss1");
check("the relay does not sanitise or reject it — rendering safety is the client's job (textContent, never innerHTML)",
  xssMsg?.text === xss, JSON.stringify(xssMsg));

/* --- 6. malformed / oversized rejected --------------------------------------- */
console.log("[9] malformed and oversized messages are rejected");
send(a.agent, { t: "agent.chat", kind: "text", clientId: "bad1" }); // no text at all
const noText = await waitFor(a.agent, (m) => m.t === "error" && m.clientId === "bad1");
check("a chat message with no text is refused chat_too_long",
  noText?.code === "chat_too_long", JSON.stringify(noText));

const oversized = "x".repeat(4001);
send(a.agent, { t: "agent.chat", kind: "text", text: oversized, clientId: "big1" });
const tooLong = await waitFor(a.agent, (m) => m.t === "error" && m.clientId === "big1");
check("a 4001-char message is refused chat_too_long, naming the clientId",
  tooLong?.code === "chat_too_long", JSON.stringify(tooLong));

send(a.agent, { t: "agent.chat", kind: "text", text: "x".repeat(4000), clientId: "max1" });
check("exactly 4000 chars is accepted",
  !!(await waitFor(a.host, (m) => m.t === "chat.message" && m.clientId === "max1")));

/* --- 7. duplicate handling ---------------------------------------------------- */
console.log("[9] a resent clientId is de-duplicated, not delivered twice");
a.host.received.length = 0; a.agent.received.length = 0;
send(a.agent, { t: "agent.chat", kind: "text", text: "dedup me", clientId: "dup1" });
await waitFor(a.host, (m) => m.t === "chat.message" && m.clientId === "dup1");
await sleep(50);
send(a.agent, { t: "agent.chat", kind: "text", text: "dedup me", clientId: "dup1" }); // resent
await sleep(200);
check("the peer receives exactly one copy",
  a.host.received.filter((m) => m.t === "chat.message" && m.clientId === "dup1").length === 1,
  JSON.stringify(a.host.received));
check("the resending sender still gets an ack (the stored canonical message)",
  a.agent.received.filter((m) => m.t === "chat.message" && m.clientId === "dup1").length === 2);

/* --- 8. Send URL --------------------------------------------------------------- */
console.log("[9] Send URL — http(s) only, parsed with URL, never a regex");
for (const url of ["https://support.example.com/kb/42", "http://example.com"]) {
  a.host.received.length = 0;
  send(a.agent, { t: "agent.chat", kind: "url", url, label: "Knowledge article", clientId: `u-${url}` });
  const got = await waitFor(a.host, (m) => m.t === "chat.message" && m.kind === "url");
  check(`${url} is accepted and delivered as a url message`,
    got?.url === url && got.label === "Knowledge article", JSON.stringify(got));
}

for (const url of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd",
  "vbscript:msgbox(1)", "not a url", "ftp://example.com/file"]) {
  const clientId = `bad-${url}`;
  send(a.agent, { t: "agent.chat", kind: "url", url, clientId });
  const refused = await waitFor(a.agent, (m) => m.t === "error" && m.clientId === clientId);
  check(`${url} is refused invalid_url`, refused?.code === "invalid_url", JSON.stringify(refused));
}

send(a.agent, { t: "agent.chat", kind: "url", url: "https://example.com", label: "x".repeat(201), clientId: "lbl1" });
const labelTooLong = await waitFor(a.agent, (m) => m.t === "error" && m.clientId === "lbl1");
check("a label over 200 chars is refused chat_too_long", labelTooLong?.code === "chat_too_long");

await sleep(150);
check("a shared URL is audited by domain only, never the full URL or label",
  auditLines().some((l) => l.event === "url.shared" && l.code === a.code
    && l.domain === "support.example.com" && l.url === undefined && l.label === undefined));

/* --- 9. the customer side is text-only: an injected "kind" is simply ignored --- */
console.log("[9] host.chat has no URL affordance at all");
send(a.host, { t: "host.chat", kind: "url", url: "https://example.com", clientId: "hostkind1" });
const hostKindRefused = await waitFor(a.host, (m) => m.t === "error" && m.clientId === "hostkind1");
check("host.chat only ever reads `text`; with none present it is refused, not silently turned into a link",
  hostKindRefused?.code === "chat_too_long", JSON.stringify(hostKindRefused));

/* --- 10. rate limiting --------------------------------------------------------- */
console.log("[9] chat is rate-limited per session");
let limited = null;
for (let i = 0; i < 40 && !limited; i++) {
  const clientId = `flood-${i}`;
  send(b.agent, { t: "agent.chat", kind: "text", text: "flood", clientId });
  limited = await waitFor(b.agent, (m) => m.t === "error" && m.code === "chat_rate_limited", 50);
}
check("flooding a session eventually gets chat_rate_limited, naming the refused clientId",
  limited !== null && typeof limited.clientId === "string", JSON.stringify(limited));

/* --- 11. chat is NOT gated by Hold --------------------------------------------- */
console.log("[9] chat keeps working while the session is held");
send(a.agent, { t: "agent.hold", held: true });
await waitFor(a.host, (m) => m.t === "agent.hold" && m.held === true);

a.host.received.length = 0;
send(a.agent, { t: "agent.chat", kind: "text", text: "still here while held", clientId: "held1" });
check("technician -> customer chat is delivered while held",
  !!(await waitFor(a.host, (m) => m.t === "chat.message" && m.clientId === "held1")));

a.agent.received.length = 0;
send(a.host, { t: "host.chat", text: "me too", clientId: "held2" });
check("customer -> technician chat is delivered while held",
  !!(await waitFor(a.agent, (m) => m.t === "chat.message" && m.clientId === "held2")));

a.host.received.length = 0;
send(a.agent, { t: "agent.input", kind: "mouse", x: 1, y: 1, action: "down", button: 0 });
await sleep(150);
check("…while remote input is still refused, unchanged from Feature Batch 1",
  !a.host.received.some((m) => m.t === "agent.input"));
send(a.agent, { t: "agent.hold", held: false });
await waitFor(a.host, (m) => m.t === "agent.hold" && m.held === false);

/* --- 12. technician notes: audited by length only, never forwarded ------------- */
console.log("[9] agent.notes.save — length only, never content, never to the host");
a.host.received.length = 0;
send(a.agent, { t: "agent.notes.save", length: 42 });
await sleep(150);
check("a save is audited with only a length",
  auditLines().some((l) => l.event === "notes.saved" && l.code === a.code && l.length === 42));
check("the host never receives anything for it — notes are technician-private by construction",
  a.host.received.length === 0, JSON.stringify(a.host.received));

send(a.agent, { t: "agent.notes.save", length: -1 });
const badLen = await waitFor(a.agent, (m) => m.t === "error");
check("a negative length is refused", badLen?.code === "protocol", JSON.stringify(badLen));

/* --- 13. chat needs an active session, same as everything else ---------------- */
console.log("[9] chat before consent is refused not_active, like every other message");
const lone = await open("lone");
send(lone, { t: "agent.create" });
await waitFor(lone, (m) => m.t === "session.created");
send(lone, { t: "agent.chat", kind: "text", text: "too early", clientId: "early1" });
const early = await waitFor(lone, (m) => m.t === "error");
check("refused not_active", early?.code === "not_active", JSON.stringify(early));
lone.close();

report("chat / send url / notes");
