/**
 * Durable session records: the ordered timeline, canonical chat transcript
 * (saved before it is confirmed, deduplicated on retry), private notes, and
 * storage failures that are visible instead of silent.
 */
import { client } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, report, send, sleep, waitFor, WebSocket } from "../lib/harness.mjs";
import { active, settle } from "../lib/session.mjs";

const agentCookie = process.env.HDA_AGENT_COOKIE;
const admin = client("admin", process.env.HDA_ADMIN_COOKIE);
const tech = client("agent", agentCookie);

console.log("\n=== Session records: timeline, chat, notes, storage failure ===\n");

/* ------------------------------------------------------------ lifecycle */
console.log("[P1] A full session leaves a complete, ordered timeline");
const s = await active(agentCookie, { machine: "WIN-REC-01", user: "dana", os: "Windows 11 Pro", label: "rec" });
check("the session has a permanent UUID distinct from the pairing code",
  /^[0-9a-f-]{36}$/.test(s.sessionId) && /^\d{6}$/.test(s.code));
check("the consent dialog names the verified technician, not a configured constant",
  s.connectRequest?.agentName === "Suite Technician", s.connectRequest?.agentName);

send(s.agent, { t: "agent.hold", held: true });
send(s.agent, { t: "agent.hold", held: false });
send(s.agent, { t: "agent.exec", id: "e1", shell: "powershell", script: "Write-Output 'secret-token-123'", asSystem: false });
await waitFor(s.host, (m) => m.t === "agent.exec");
send(s.host, { t: "host.execResult", id: "e1", exitCode: 0, stdout: "secret-token-123", stderr: "" });
send(s.agent, { t: "agent.requestElevation", mode: "interactive" });
await waitFor(s.host, (m) => m.t === "agent.requestElevation");
send(s.host, { t: "host.elevated", ok: true });
send(s.host, { t: "host.desktopChanged", desktop: "Winlogon" });
send(s.agent, { t: "agent.chat", kind: "url", url: "https://support.example.com/kb?id=42", label: "KB", clientId: "u1" });
await waitFor(s.host, (m) => m.t === "chat.message" && m.kind === "url");

/* --------------------------------------------------------------- chat */
console.log("\n[P2] Chat is stored before it is confirmed, once per client message id");
send(s.agent, { t: "agent.chat", kind: "text", text: "Hello from support", clientId: "c-1" });
const firstAck = await waitFor(s.agent, (m) => m.t === "chat.message" && m.clientId === "c-1");
const inDbAtAck = await sql("SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1 AND client_msg_id = 'c-1'", [s.sessionId]);
check("when the sender is told 'sent', the message is already in the database", !!firstAck && inDbAtAck[0].n === 1);
// A retry after a perceived failure (same clientId), twice.
send(s.agent, { t: "agent.chat", kind: "text", text: "Hello from support", clientId: "c-1" });
send(s.agent, { t: "agent.chat", kind: "text", text: "Hello from support", clientId: "c-1" });
await sleep(400);
const acks = s.agent.received.filter((m) => m.t === "chat.message" && m.clientId === "c-1");
check("each retry is re-acknowledged to the sender", acks.length === 3);
check("…with the same canonical id every time", new Set(acks.map((m) => m.id)).size === 1);
check("the customer received it exactly once", s.host.received.filter((m) => m.t === "chat.message" && m.clientId === "c-1").length === 1);
send(s.host, { t: "host.chat", text: "Thanks, it works <script>alert(1)</script>", clientId: "c-1" });
await waitFor(s.agent, (m) => m.t === "chat.message" && m.senderRole === "host");
check("the customer may reuse the same client id without colliding with the technician's",
  s.host.received.some((m) => m.t === "chat.message" && m.senderRole === "host" && m.clientId === "c-1"));
const rows = await sql("SELECT seq, sender_role, kind, body, url, client_msg_id FROM chat_messages WHERE session_id = $1 ORDER BY seq", [s.sessionId]);
check("the transcript has one row per distinct message, both sides", rows.length === 3, JSON.stringify(rows.map((r) => [r.seq, r.sender_role, r.client_msg_id])));
check("…in sequence order 1..n", rows.map((r) => r.seq).join() === "1,2,3");
check("…storing the text verbatim (escaping is the renderer's job)", rows[2]?.body === "Thanks, it works <script>alert(1)</script>");
check("chat ids carry the session UUID, never the code", firstAck.id.startsWith(`${s.sessionId}.`));

/* -------------------------------------------------------------- notes */
console.log("\n[P3] Notes are private and durable");
const noteText = "Customer's printer queue was stuck; cleared spooler. Follow up Friday.";
const saved = await tech.post(`/sessions/${s.sessionId}/notes`, { body: noteText });
check("the technician saves notes for their own session", saved.status === 200);
const tooLong = await tech.post(`/sessions/${s.sessionId}/notes`, { body: "x".repeat(10_001) });
check("notes over the limit are refused", tooLong.status === 400);
check("the technician reads back the latest revision", (await tech.get(`/sessions/${s.sessionId}/notes`)).data.body === noteText);
await sleep(200);
check("notes never reach the customer's socket", !JSON.stringify(s.host.received).includes("spooler"));

send(s.agent, { t: "agent.end" });
await settle(600);

const ev = await sql("SELECT seq, type, actor_role, detail FROM session_events WHERE session_id = $1 ORDER BY seq", [s.sessionId]);
const types = ev.map((e) => e.type);
console.log(`    timeline: ${types.join(" → ")}`);
const expectOrder = ["session.created", "customer.joined", "consent.requested", "consent.accepted", "session.active",
  "session.held", "session.resumed", "script.requested", "script.result", "elevation.requested", "elevation.result",
  "desktop.changed", "url.shared", "notes.saved", "session.ended"];
let idx = -1;
const inOrder = expectOrder.every((t) => { const i = types.indexOf(t, idx + 1); if (i === -1) return false; idx = i; return true; });
check("every lifecycle event is recorded, in order", inOrder, `missing/out of order among: ${expectOrder.filter((t) => !types.includes(t)).join(",")}`);
check("sequence numbers are contiguous from 1", ev.every((e, i) => e.seq === i + 1));
check("the end reason is recorded", ev.at(-1)?.detail.reason === "agent_ended");
const script = ev.find((e) => e.type === "script.requested");
check("the script event keeps shell, size and hash — not the text", script?.detail.shell === "powershell"
  && typeof script.detail.scriptSha256 === "string" && !JSON.stringify(script.detail).includes("secret-token"));
const allText = JSON.stringify(await sql("SELECT * FROM session_events WHERE session_id = $1", [s.sessionId]))
  + JSON.stringify(await sql("SELECT * FROM sessions WHERE id = $1", [s.sessionId]));
check("neither the script output nor the pairing code is stored anywhere in the record",
  !allText.includes("secret-token-123") && !allText.includes(`"${s.code}"`));
const url = ev.find((e) => e.type === "url.shared");
check("a shared link is on the timeline by domain only", url?.detail.domain === "support.example.com" && !JSON.stringify(url.detail).includes("id=42"));

const row = (await sql("SELECT * FROM sessions WHERE id = $1", [s.sessionId]))[0];
check("the session row carries device, consent, times and end reason", row.customer_machine === "WIN-REC-01"
  && row.consent_decision === "accepted" && row.active_at && row.ended_at && row.end_reason === "agent_ended" && row.record_complete === true);

const detail = await admin.get(`/sessions/${s.sessionId}`);
check("the admin API returns the detail and timeline", detail.status === 200 && detail.data.timeline.length === ev.length);
const tr = await admin.get(`/sessions/${s.sessionId}/transcript`);
check("…and the transcript", tr.data.messages.length === 3);
const viewed = await sql("SELECT actor_user_id FROM audit_log WHERE action = 'transcript.viewed' AND target_id = $1", [s.sessionId]);
check("viewing the transcript is audited", viewed.length === 1);
await admin.get(`/sessions/${s.sessionId}/notes`);
check("viewing notes is audited", (await sql("SELECT 1 FROM audit_log WHERE action = 'notes.viewed' AND target_id = $1", [s.sessionId])).length === 1);
const chatInJsonl = await sql("SELECT count(*)::int AS n FROM audit_log WHERE detail::text LIKE '%Hello from support%'");
check("chat content is not copied into the audit trail", chatInJsonl[0].n === 0);

/* -------------------------------------------------------- declined and customer-ended */
console.log("\n[P4] Other endings");
{
  const { open } = await import("../lib/harness.mjs");
  const { create } = await import("../lib/session.mjs");
  const d = await create(agentCookie, "decl");
  const h = await open("host-decl");
  send(h, { t: "host.join", code: d.created.code, machine: "WIN-NO", user: "x", os: "Windows 10" });
  await waitFor(h, (m) => m.t === "host.connectRequest");
  send(h, { t: "host.consent", accepted: false });
  await settle();
  const dr = (await sql("SELECT status, end_reason, consent_decision, active_at FROM sessions WHERE id = $1", [d.created.sessionId]))[0];
  check("a declined session is recorded as declined and never active",
    dr.consent_decision === "declined" && dr.end_reason === "customer_declined" && dr.active_at === null);

  const c = await active(agentCookie, { label: "cust" });
  c.host.close(1000, "user ended the session");
  await settle();
  check("the applet's End Session is recorded as ended by the customer",
    (await sql("SELECT end_reason FROM sessions WHERE id = $1", [c.sessionId]))[0].end_reason === "customer_ended");

  const n = await active(agentCookie, { label: "drop" });
  n.host.terminate();
  await settle();
  check("a dropped applet is recorded as a disconnect, not a customer choice",
    (await sql("SELECT end_reason FROM sessions WHERE id = $1", [n.sessionId]))[0].end_reason === "customer_disconnected");
}

/* ------------------------------------------------------------ storage failure */
console.log("\n[P5] A storage failure is visible, never a silently complete record");
const f = await active(agentCookie, { label: "fail" });
await settle();
await sql("ALTER TABLE chat_messages RENAME TO chat_messages_offline");
send(f.agent, { t: "agent.chat", kind: "text", text: "cannot be stored", clientId: "lost-1" });
const notSaved = await waitFor(f.agent, (m) => m.t === "error" && m.code === "chat_not_saved", 3000);
check("a chat message that cannot be stored is refused with chat_not_saved", notSaved?.clientId === "lost-1", JSON.stringify(notSaved));
await sleep(200);
check("…and is NOT delivered to the customer", !f.host.received.some((m) => m.t === "chat.message"));
await sql("ALTER TABLE chat_messages_offline RENAME TO chat_messages");
send(f.agent, { t: "agent.chat", kind: "text", text: "cannot be stored", clientId: "lost-1" });
check("the retry succeeds once storage is back", !!(await waitFor(f.agent, (m) => m.t === "chat.message" && m.clientId === "lost-1", 3000)));

await sql("ALTER TABLE session_events RENAME TO session_events_offline");
send(f.agent, { t: "agent.exec", id: "e-fail", shell: "cmd", script: "dir", asSystem: false });
const execFail = await waitFor(f.agent, (m) => m.t === "error" && m.code === "storage_unavailable", 3000);
check("a script whose audit record cannot be written is refused", !!execFail);
await sleep(200);
check("…and never reaches the customer's machine", !f.host.received.some((m) => m.t === "agent.exec"));
send(f.agent, { t: "agent.hold", held: true });
await sleep(300);
check("best-effort events still let the live session continue (hold works)", f.agent.readyState === WebSocket.OPEN);
await sql("ALTER TABLE session_events_offline RENAME TO session_events");
send(f.agent, { t: "agent.end" });
await settle(600);
const fr = (await sql("SELECT record_complete, persist_failures FROM sessions WHERE id = $1", [f.sessionId]))[0];
check("the session is marked incomplete, with the failure count", fr.record_complete === false && fr.persist_failures >= 2, JSON.stringify(fr));
const listed = (await admin.get(`/sessions/${f.sessionId}`)).data.session;
check("…and the admin API says so", listed.recordComplete === false);
const dash = (await admin.get("/dashboard")).data;
check("the dashboard reports write failures and incomplete records", dash.storage.recordWriteFailuresSinceStart >= 2 && dash.incompleteRecords >= 1);

report("session records");
