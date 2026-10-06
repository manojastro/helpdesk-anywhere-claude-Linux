/**
 * Platform 2.0 Phase 5 at the relay: session transfer between technicians
 * (DECISIONS.md D-020 — the receiving technician accepts AND the customer approves).
 */
import { client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { settle } from "../lib/session.mjs";

const cookieA = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const cookieB = await ensureActiveUser(adminCookie, { objectId: "a1a1a1a1-0000-4000-8000-0000000000b9", name: "Bea Receiver", roles: ["Agent"], agentCode: "BEA-1" });
const cookieC = await ensureActiveUser(adminCookie, { objectId: "a1a1a1a1-0000-4000-8000-0000000000c9", name: "Cal Offline", roles: ["Agent"], agentCode: "CAL-1" });

async function lobbyOf(cookie, label) {
  const ws = await open(label, { headers: { cookie } });
  send(ws, { t: "agent.listen" });
  await waitFor(ws, (m) => m.t === "lobby.ready");
  return ws;
}
async function session(cookie, { caps = ["transfer", "resume"], machine = "TX-PC" } = {}) {
  const agent = await open("agent", { headers: { cookie } });
  send(agent, { t: "agent.create" });
  const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
  const host = await open("host");
  send(host, { t: "host.join", code: created.code, machine, user: "jo", os: "Windows 11", ...(caps ? { protocolVersion: 2, capabilities: caps } : {}) });
  await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  return { agent, host, sessionId: created.sessionId, created };
}
const status = (ws, st, ms = 3000) => waitFor(ws, (m) => m.t === "transfer.status" && m.status === st, ms);

console.log("\n=== Platform 2.0 Phase 5 — session transfer ===\n");

console.log("[A] who can receive");
const lobbyB = await lobbyOf(cookieB, "lobbyB");
const avail = await client("agent", cookieA).get("/technicians/available");
check("available technicians: signed-in colleagues only (B, not offline C, not me)",
  avail.data.items.length === 1 && avail.data.items[0].displayName === "Bea Receiver" && avail.data.items[0].available === true, JSON.stringify(avail.data));
const anonLobby = await open("anon");
send(anonLobby, { t: "agent.listen" });
check("an anonymous socket cannot open a lobby", (await waitFor(anonLobby, (m) => m.t === "error"))?.code === "unauthorized");
send(lobbyB, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
check("a lobby socket can only accept or decline offers", (await waitFor(lobbyB, (m) => m.t === "error"))?.code === "protocol");

console.log("\n[B] refusals");
const s = await session(cookieA);
const userIdOf = async (code) => (await client("admin", adminCookie).get("/users")).data.items.find((u) => u.agentCode === code).id;
const idB = await userIdOf("BEA-1");
const idC = await userIdOf("CAL-1");
send(s.agent, { t: "agent.transfer.offer", toUserId: idC });
check("an offline technician cannot be offered a session", (await waitFor(s.agent, (m) => m.t === "error"))?.code === "transfer_failed");
s.agent.received.length = 0;
const oldApp = await session(cookieA, { caps: null, machine: "OLD-PC" });
send(oldApp.agent, { t: "agent.transfer.offer", toUserId: idB });
check("an older applet cannot be transferred (not_supported)", (await waitFor(oldApp.agent, (m) => m.t === "error"))?.code === "not_supported");
send(oldApp.agent, { t: "agent.end" });

console.log("\n[C] technician declines");
send(s.agent, { t: "agent.transfer.offer", toUserId: idB, note: "needs <b>Outlook</b> fix" });
const offer = await waitFor(lobbyB, (m) => m.t === "transfer.offer");
check("B is offered the session with device, customer and note", offer?.device === "TX-PC" && offer.customerUser === "jo" && offer.note === "needs <b>Outlook</b> fix" && offer.fromName);
check("A is told it is offered", !!(await status(s.agent, "offered")));
send(s.agent, { t: "agent.transfer.offer", toUserId: idB });
check("a second concurrent offer is refused", (await waitFor(s.agent, (m) => m.t === "error" && m.code === "transfer_failed"))?.message.includes("already"));
send(lobbyB, { t: "agent.transfer.decline", transferId: offer.transferId });
check("B declines → A is told, A keeps the session", !!(await status(s.agent, "declined_by_technician")) && !s.host.received.some((m) => m.t === "host.transferRequest"));

console.log("\n[D] customer declines");
lobbyB.received.length = 0;
send(s.agent, { t: "agent.transfer.offer", toUserId: idB });
const offer2 = await waitFor(lobbyB, (m) => m.t === "transfer.offer");
send(lobbyB, { t: "agent.transfer.accept", transferId: offer2.transferId });
const ask = await waitFor(s.host, (m) => m.t === "host.transferRequest");
check("after B accepts, the CUSTOMER is asked, naming B and A", ask?.agentName === "Bea Receiver" && !!ask.fromName);
check("A sees 'awaiting customer'", !!(await status(s.agent, "awaiting_customer")));
s.host.received.length = 0;
send(s.agent, { t: "agent.input", kind: "key", code: "KeyB", action: "down" });
check("A keeps control while the customer decides", !!(await waitFor(s.host, (m) => m.t === "agent.input")));
send(s.host, { t: "host.transferConsent", transferId: ask.transferId, accepted: false });
check("customer declines → A keeps the session", !!(await status(s.agent, "declined_by_customer")));
check("…and B is told it is off", !!(await waitFor(lobbyB, (m) => m.t === "transfer.status" && m.status === "cancelled" && m.transferId === offer2.transferId)));

console.log("\n[E] completed");
lobbyB.received.length = 0;
s.agent.received.length = 0;
send(s.agent, { t: "agent.transfer.offer", toUserId: idB });
const offer3 = await waitFor(lobbyB, (m) => m.t === "transfer.offer");
send(lobbyB, { t: "agent.transfer.accept", transferId: offer3.transferId });
const ask3 = await waitFor(s.host, (m) => m.t === "host.transferRequest" && m.transferId === offer3.transferId);
const aClosed = new Promise((res) => s.agent.once("close", (code) => res(code)));
send(s.host, { t: "host.transferConsent", transferId: ask3.transferId, accepted: true });
check("customer approves → A is told completed", !!(await status(s.agent, "completed")));
check("…and A's socket is closed with 4410 (final, not resumable)", (await aClosed) === 4410);
const ready = await waitFor(lobbyB, (m) => m.t === "transfer.ready");
check("B receives the session id and a resume token on B's own lobby", ready?.sessionId === s.sessionId && typeof ready.resumeToken === "string" && ready.resumeToken.length >= 40);
const reuseA = await open("reuseA", { headers: { cookie: cookieA } });
send(reuseA, { t: "agent.resume", sessionId: s.sessionId, resumeToken: s.created.resumeToken });
check("A can no longer resume it (not the owner, old token)", (await waitFor(reuseA, (m) => m.t === "error"))?.code === "resume_failed");
const stolen = await open("stolen", { headers: { cookie: cookieA } });
send(stolen, { t: "agent.resume", sessionId: s.sessionId, resumeToken: ready.resumeToken });
check("…not even with B's token (ownership is checked too)", (await waitFor(stolen, (m) => m.t === "error"))?.code === "resume_failed");
const b = await open("B", { headers: { cookie: cookieB } });
send(b, { t: "agent.resume", sessionId: s.sessionId, resumeToken: ready.resumeToken });
const resumed = await waitFor(b, (m) => m.t === "session.resumed", 3000);
check("B picks the session up", resumed?.state === "active" && resumed.host?.machine === "TX-PC");
s.host.received.length = 0;
send(b, { t: "agent.input", kind: "key", code: "KeyC", action: "down" });
check("B now controls the machine", !!(await waitFor(s.host, (m) => m.t === "agent.input" && m.code === "KeyC")));
const liveB = await client("agent", cookieB).get("/sessions/live");
const liveA = await client("agent", cookieA).get("/sessions/live");
check("the session counts against B's limit, not A's", liveB.data.items.some((x) => x.id === s.sessionId) && !liveA.data.items.some((x) => x.id === s.sessionId));

send(b, { t: "agent.end" });
await settle(600);
const rows = await sql("SELECT status, from_name, to_name, note FROM session_transfers WHERE session_id = $1 ORDER BY created_at", [s.sessionId]);
check("every attempt is recorded with its outcome", rows.map((r) => r.status).join(",") === "declined_by_technician,declined_by_customer,completed", JSON.stringify(rows.map((r) => r.status)));
const owner = (await sql("SELECT agent_display_name FROM sessions WHERE id = $1", [s.sessionId]))[0];
check("the session record now belongs to B", owner?.agent_display_name === "Bea Receiver");
const ev = (await sql("SELECT type FROM session_events WHERE session_id = $1", [s.sessionId])).map((r) => r.type);
check("timeline: offered, accepted, declined, completed", ["transfer.offered", "transfer.accepted", "transfer.declined", "transfer.completed"].every((t) => ev.includes(t)));
const histA = await client("agent", cookieA).get("/dashboard");
const entry = histA.data.recent.find((x) => x.id === s.sessionId);
check("A still sees it in history, marked transferred to B", entry?.transferredTo === "Bea Receiver");
check("A can still read its activity", (await client("agent", cookieA).get(`/sessions/${s.sessionId}/events`)).status === 200);
check("…but not write its notes", (await client("agent", cookieA).post(`/sessions/${s.sessionId}/notes`, { body: "x" })).status === 404);

console.log("\n[F] expiry and session end");
const s2 = await session(cookieA, { machine: "EXP-PC" });
lobbyB.received.length = 0;
send(s2.agent, { t: "agent.transfer.offer", toUserId: idB });
await waitFor(lobbyB, (m) => m.t === "transfer.offer");
send(s2.agent, { t: "agent.transfer.cancel" });
check("A can cancel a pending offer", !!(await status(s2.agent, "cancelled")) && !!(await waitFor(lobbyB, (m) => m.t === "transfer.status" && m.status === "cancelled")));
send(s2.agent, { t: "agent.transfer.offer", toUserId: idB });
const o5 = await waitFor(lobbyB, (m) => m.t === "transfer.offer" && m.transferId !== offer3.transferId, 3000);
send(s2.agent, { t: "agent.end" });
await sleep(300);
send(lobbyB, { t: "agent.transfer.accept", transferId: o5?.transferId });
check("accepting an offer whose session ended is refused ('gone')", (await waitFor(lobbyB, (m) => m.t === "transfer.status" && m.transferId === o5?.transferId && (m.status === "gone" || m.status === "cancelled")))?.status !== undefined);

report("ws/16 session transfer");
