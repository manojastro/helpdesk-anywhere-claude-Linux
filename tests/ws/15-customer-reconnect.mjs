/**
 * Platform 2.0 Phase 3 at the relay: the customer's applet reconnecting.
 *
 *   node 15-customer-reconnect.mjs main     (default grace)
 *   node 15-customer-reconnect.mjs expiry   (server started with HOST_RECONNECT_GRACE_MS=1500)
 */
import { check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { sql } from "../lib/db.mjs";
import { settle } from "../lib/session.mjs";

const mode = process.argv[2] ?? "main";
const cookie = process.env.HDA_AGENT_COOKIE;

async function session({ caps = ["resume"], machine = "RC-PC" } = {}) {
  const agent = await open("agent", { headers: { cookie } });
  send(agent, { t: "agent.create" });
  const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
  const host = await open("host");
  send(host, { t: "host.join", code: created.code, machine, user: "c", os: "Windows 11", ...(caps ? { protocolVersion: 2, capabilities: caps } : {}) });
  await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  const tok = await waitFor(host, (m) => m.t === "host.resumeToken", 1500);
  return { agent, host, created, sessionId: created.sessionId, token: tok?.resumeToken ?? null, tok };
}
async function resume(sessionId, resumeToken) {
  const ws = await open("host-resume");
  send(ws, { t: "host.resume", sessionId, resumeToken });
  const first = await waitFor(ws, (m) => m.t === "host.resumed" || m.t === "error", 3000);
  return { ws, first };
}
const phase = (agent, p) => waitFor(agent, (m) => m.t === "session.phase" && m.phase === p, 3000);

if (mode === "main") {
  console.log("\n=== Platform 2.0 Phase 3 — customer reconnect ===\n");

  console.log("[A] token issue");
  const s = await session();
  check("an applet that declares resume gets a token at consent, for its own session",
    s.tok?.sessionId === s.sessionId && typeof s.token === "string" && s.token.length >= 40);
  check("the token is never sent to the technician", !s.agent.received.some((m) => JSON.stringify(m).includes(s.token)));
  const old = await session({ caps: null, machine: "OLD-PC" });
  check("an old applet gets no token", old.tok === null);

  console.log("\n[B] drop and resume");
  s.host.terminate();
  check("a customer drop → DISCONNECTED (not ended)", !!(await phase(s.agent, "DISCONNECTED")) && !s.agent.received.some((m) => m.t === "peer.left"));
  s.agent.received.length = 0;
  send(s.agent, { t: "agent.exec", id: "x1", shell: "cmd", script: "whoami", asSystem: false });
  check("a script while the customer is away is refused clearly", (await waitFor(s.agent, (m) => m.t === "error"))?.code === "customer_reconnecting");
  send(s.agent, { t: "agent.input", kind: "mouse", x: 1, y: 1, action: "move" });
  await sleep(100);
  check("input meanwhile is dropped silently", s.agent.received.filter((m) => m.t === "error").length === 1);

  const wrong = await resume(s.sessionId, "A".repeat(43));
  check("a wrong token is refused (resume_failed) and closed", wrong.first?.code === "resume_failed");
  const otherSession = await resume(old.sessionId, s.token);
  check("the right token for another session is refused", otherSession.first?.code === "resume_failed");
  const ok = await resume(s.sessionId, s.token);
  check("the right token resumes: host.resumed with a fresh token", ok.first?.t === "host.resumed" && ok.first.resumeToken !== s.token);
  check("…the technician sees CONNECTED again", !!(await phase(s.agent, "CONNECTED")));
  const reused = await resume(s.sessionId, s.token);
  check("the old token no longer works (rotated)", reused.first?.code === "resume_failed");

  s.agent.received.length = 0;
  send(s.agent, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
  check("input reaches the resumed applet", !!(await waitFor(ok.ws, (m) => m.t === "agent.input")));
  ok.ws.send(JSON.stringify({ t: "host.chat", text: "back", clientId: "c1" }));
  check("…and the customer's messages reach the technician", !!(await waitFor(s.agent, (m) => m.t === "chat.message" && m.text === "back")));

  console.log("\n[C] hold survives a drop");
  send(s.agent, { t: "agent.hold", held: true });
  await phase(s.agent, "ON_HOLD");
  ok.ws.terminate();
  await phase(s.agent, "DISCONNECTED");
  s.agent.received.length = 0;
  const ok2 = await resume(s.sessionId, ok.first.resumeToken);
  check("a held session resumes ON_HOLD, and the applet is told it is held", ok2.first?.held === true && !!(await phase(s.agent, "ON_HOLD")));

  console.log("\n[D] what does NOT start a grace");
  old.host.terminate();
  check("an old applet's drop ends the session at once, as before", !!(await waitFor(old.agent, (m) => m.t === "peer.left", 3000)));
  const u = await session({ machine: "USER-END" });
  u.host.close(1000, "user ended the session");
  check("the customer's own End Session ends it at once (no grace)", !!(await waitFor(u.agent, (m) => m.t === "peer.left", 3000)));
  const tech = await session({ machine: "TECH-END" });
  send(tech.agent, { t: "agent.end" });
  await sleep(300);
  const late = await resume(tech.sessionId, tech.token);
  check("an ended session cannot be resumed", late.first?.code === "resume_failed");

  console.log("\n[E] records");
  send(s.agent, { t: "agent.end" });
  await settle(600);
  const ev = (await sql("SELECT type FROM session_events WHERE session_id = $1 ORDER BY seq", [s.sessionId])).map((r) => r.type);
  check("timeline: customer.reconnecting / customer.reconnected, twice", ev.filter((t) => t === "customer.reconnecting").length === 2 && ev.filter((t) => t === "customer.reconnected").length === 2);
  const row = (await sql("SELECT host_reconnect_count, phase FROM sessions WHERE id = $1", [s.sessionId]))[0];
  check("host_reconnect_count = 2 on the record", row?.host_reconnect_count === 2, JSON.stringify(row));
  const phases = (await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'session.phase' ORDER BY seq", [s.sessionId])).map((r) => `${r.detail.from}>${r.detail.to}`);
  check("phases include CONNECTED>DISCONNECTED>CONNECTED and ON_HOLD>DISCONNECTED>ON_HOLD",
    phases.includes("CONNECTED>DISCONNECTED") && phases.includes("DISCONNECTED>CONNECTED") && phases.includes("ON_HOLD>DISCONNECTED") && phases.includes("DISCONNECTED>ON_HOLD"), JSON.stringify(phases));

  console.log("\n[F] rate limit");
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await resume("00000000-0000-4000-8000-000000000000", "x");
    if (r.first?.code === "rate_limited") limited = true;
  }
  check("host.resume is rate-limited per IP", limited);
} else {
  console.log("\n=== Platform 2.0 Phase 3 — customer grace expiry ===\n");
  const s = await session({ machine: "GONE-PC" });
  s.host.terminate();
  await phase(s.agent, "DISCONNECTED");
  const ended = await waitFor(s.agent, (m) => m.t === "session.phase" && m.phase === "ENDED", 5000);
  check("if the customer does not come back within the grace, the session ends", !!ended);
  await settle(500);
  const row = (await sql("SELECT end_reason FROM sessions WHERE id = $1", [s.sessionId]))[0];
  check("…as customer_disconnected", row?.end_reason === "customer_disconnected");
  check("…with customer.reconnect_expired on the timeline",
    (await sql("SELECT count(*)::int AS n FROM session_events WHERE session_id = $1 AND type = 'customer.reconnect_expired'", [s.sessionId]))[0].n === 1);
  const late = await resume(s.sessionId, s.token);
  check("…and a late resume is refused", late.first?.code === "resume_failed");
}

report(`ws/15 customer reconnect (${mode})`);
