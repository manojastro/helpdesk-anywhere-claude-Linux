/**
 * Platform 2.0 Phase 1 at the relay: the explicit session lifecycle, its record,
 * connection health, and the technician dashboard API.
 *
 * Driven over the real wire (technician socket + applet-shaped host socket),
 * then checked against the database — the phase a console shows must be the
 * phase the record keeps.
 */
import { client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { readFileSync, readdirSync } from "node:fs";

import { AUDIT_DIR, SERVER_LOG, check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { active, create, settle } from "../lib/session.mjs";

const agentCookie = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const agentApi = client("agent", agentCookie);

const phasesSeen = (ws) => ws.received.filter((m) => m.t === "session.phase").map((m) => m.phase);
const storedPhases = async (id) =>
  (await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'session.phase' ORDER BY seq", [id]))
    .map((r) => `${r.detail.from}>${r.detail.to}`);

console.log("\n=== Platform 2.0 — session lifecycle at the relay ===\n");

/* --- A. create carries phase + expiry ----------------------------------------------- */
console.log("[A] create");
const before = Date.now();
const c1 = await create(agentCookie, "a");
check("session.created carries phase WAITING", c1.created?.phase === "WAITING", JSON.stringify(c1.created?.phase));
check("…and the code's expiry (now + 10 min ± 5 s)",
  typeof c1.created?.expiresAt === "number" && Math.abs(c1.created.expiresAt - (before + 600_000)) < 5000,
  String(c1.created?.expiresAt));
await settle();
let row = (await sql("SELECT phase, phase_changed_at FROM sessions WHERE id = $1", [c1.created.sessionId]))[0];
check("the record says WAITING with a timestamp", row?.phase === "WAITING" && row.phase_changed_at instanceof Date);

/* --- B. join → consent → control → hold → resume → end ---------------------------------- */
console.log("\n[B] the full path, as the console sees it and as it is stored");
const host = await open("host-b");
send(host, { t: "host.join", code: c1.created.code, machine: "PC-LIFE", user: "jo", os: "Windows 11" });
await waitFor(host, (m) => m.t === "host.connectRequest");
check("join → peer.joined carries phase CONSENT_PENDING (no extra message)",
  (await waitFor(c1.agent, (m) => m.t === "peer.joined"))?.phase === "CONSENT_PENDING");
send(host, { t: "host.consent", accepted: true });
check("consent → consent.result carries phase CONNECTED",
  (await waitFor(c1.agent, (m) => m.t === "consent.result"))?.phase === "CONNECTED");
check("…and no separate session.phase precedes them (strict-order clients see the old sequence)",
  !c1.agent.received.some((m) => m.t === "session.phase" && (m.phase === "CONSENT_PENDING" || m.phase === "CONNECTED")));

send(c1.agent, { t: "agent.input", kind: "mouse", x: 1, y: 1, action: "move" });
send(c1.agent, { t: "agent.input", kind: "mouse", x: 2, y: 2, action: "move" });
send(c1.agent, { t: "agent.input", kind: "key", code: "KeyA", action: "down" });
check("first input → CONTROLLING", !!(await waitFor(c1.agent, (m) => m.t === "session.phase" && m.phase === "CONTROLLING")));
await sleep(150);
check("…once, not once per input event", phasesSeen(c1.agent).filter((p) => p === "CONTROLLING").length === 1);
check("input still reaches the host exactly as before", (await waitFor(host, (m) => m.t === "agent.input" && m.kind === "key")) !== null);

send(c1.agent, { t: "agent.hold", held: true });
check("hold → ON_HOLD", !!(await waitFor(c1.agent, (m) => m.t === "session.phase" && m.phase === "ON_HOLD")));
send(c1.agent, { t: "agent.hold", held: false });
check("resume → CONNECTED", !!(await waitFor(c1.agent, (m) => m.t === "session.phase" && m.phase === "CONNECTED" && phasesSeen(c1.agent).includes("ON_HOLD"))));
const phaseMsgs = c1.agent.received.filter((m) => m.t === "session.phase");
check("every session.phase message carries its time",
  phaseMsgs.length >= 3 && phaseMsgs.every((m) => typeof m.since === "number" && m.since >= before), String(phaseMsgs.length));

/* --- C. health ---------------------------------------------------------------------------- */
console.log("\n[C] connection health (relay-measured round trips)");
const health = await waitFor(c1.agent, (m) => m.t === "session.health" && typeof m.hostRttMs === "number" && typeof m.agentRttMs === "number", 12_000);
check("session.health reports both legs' round trip", !!health, JSON.stringify(health));
check("…as small, real numbers on loopback", health && health.hostRttMs >= 0 && health.hostRttMs < 1000 && health.agentRttMs < 1000);
check("health is never sent to the customer", !host.received.some((m) => m.t === "session.health" || m.t === "session.phase"));

/* --- D. technician reconnect ---------------------------------------------------------------- */
console.log("\n[D] technician reconnect");
const token = c1.created.resumeToken;
c1.agent.terminate();
await sleep(300);
let live = (await agentApi.get("/sessions/live")).data;
check("a dropped console puts the session in RECONNECTING", live.items.find((s) => s.id === c1.created.sessionId)?.phase === "RECONNECTING",
  JSON.stringify(live.items.map((s) => s.phase)));
const r = await open("resume", { headers: { cookie: agentCookie } });
send(r, { t: "agent.resume", sessionId: c1.created.sessionId, resumeToken: token });
const resumed = await waitFor(r, (m) => m.t === "session.resumed", 3000);
check("session.resumed carries the phase it came back to (CONNECTED)", resumed?.phase === "CONNECTED", JSON.stringify(resumed?.phase));
check("…and since when", typeof resumed?.phaseSince === "number");

send(r, { t: "agent.end" });
check("end → ENDED reaches the console before the socket closes",
  !!(await waitFor(r, (m) => m.t === "session.phase" && m.phase === "ENDED")));
await settle(600);

const stored = await storedPhases(c1.created.sessionId);
const expected = ["CREATED>WAITING", "WAITING>CONSENT_PENDING", "CONSENT_PENDING>CONNECTED", "CONNECTED>CONTROLLING",
  "CONTROLLING>ON_HOLD", "ON_HOLD>CONNECTED", "CONNECTED>RECONNECTING", "RECONNECTING>CONNECTED", "CONNECTED>ENDED"];
check("the timeline stores every transition, in order", JSON.stringify(stored) === JSON.stringify(expected), JSON.stringify(stored));
row = (await sql("SELECT phase, status FROM sessions WHERE id = $1", [c1.created.sessionId]))[0];
check("the record ends ENDED (status still 'ended' for every existing query)", row?.phase === "ENDED" && row?.status === "ended");
const ts = (await sql("SELECT at FROM session_events WHERE session_id = $1 AND type = 'session.phase' ORDER BY seq", [c1.created.sessionId])).map((x) => x.at.getTime());
check("transition timestamps never go backwards", ts.every((v, i) => i === 0 || v >= ts[i - 1]));

/* --- E. decline ------------------------------------------------------------------------------ */
console.log("\n[E] decline");
const c2 = await create(agentCookie, "e");
const h2 = await open("host-e");
send(h2, { t: "host.join", code: c2.created.code, machine: "PC-NO", user: "x", os: "Windows 10" });
await waitFor(h2, (m) => m.t === "host.connectRequest");
send(h2, { t: "host.consent", accepted: false });
check("decline → DECLINED", !!(await waitFor(c2.agent, (m) => m.t === "session.phase" && m.phase === "DECLINED")));
await settle();
check("…stored as DECLINED", (await sql("SELECT phase FROM sessions WHERE id = $1", [c2.created.sessionId]))[0]?.phase === "DECLINED");

/* --- F. dashboard -------------------------------------------------------------------------------- */
console.log("\n[F] technician dashboard API");
const a1 = await active(agentCookie, { machine: "DASH-ACTIVE", label: "f1" });
const w1 = await create(agentCookie, "f2");
await settle();
const dash = await agentApi.get("/dashboard");
check("GET /api/agent/dashboard answers", dash.status === 200, String(dash.status));
check("counts: 1 active, 1 waiting, 0 reconnecting", dash.data?.counts?.active === 1 && dash.data.counts.waiting === 1 && dash.data.counts.reconnecting === 0,
  JSON.stringify(dash.data?.counts));
check("completed today counts sessions that actually connected (1 — the declined one never did)",
  dash.data?.counts?.completedToday === 1, JSON.stringify(dash.data?.counts));
check("the limit is reported", dash.data?.maxSessions === 4 && dash.data?.live === 2);
const recentIds = (dash.data?.recent ?? []).map((x) => x.id);
check("recent lists ended sessions, newest first", recentIds[0] === c2.created.sessionId && recentIds.includes(c1.created.sessionId));
check("recent rows carry phase and a readable end reason",
  dash.data.recent.find((x) => x.id === c1.created.sessionId)?.endReasonLabel === "Ended by technician"
  && dash.data.recent.find((x) => x.id === c2.created.sessionId)?.phase === "DECLINED");
check("no pairing code anywhere in the dashboard", !JSON.stringify(dash.data).includes(c1.created.code) && !JSON.stringify(dash.data).includes(w1.created.code));

const byMachine = await agentApi.get("/dashboard?q=PC-LIFE");
check("search by machine", byMachine.data.recent.length === 1 && byMachine.data.recent[0].id === c1.created.sessionId);
const byPhase = await agentApi.get("/dashboard?phase=DECLINED");
check("filter by phase", byPhase.data.recent.length === 1 && byPhase.data.recent[0].phase === "DECLINED");
const wild = await agentApi.get("/dashboard?q=%25");
check("a LIKE wildcard in the search is literal", wild.data.recent.length === 0);
const junk = await agentApi.get("/dashboard?phase=DROP%20TABLE&since=garbage");
check("junk filters are ignored, not errors", junk.status === 200 && junk.data.recent.length >= 2);

const otherCookie = await ensureActiveUser(adminCookie, {
  objectId: "eeeeeeee-0000-4000-8000-00000000a912", name: "Dash Other", roles: ["Agent"], agentCode: "T-912",
});
const other = await client("agent", otherCookie).get(`/dashboard?q=${c1.created.sessionId}`);
check("another technician sees none of these sessions, even by exact id",
  other.status === 200 && other.data.recent.length === 0 && other.data.counts.active === 0 && other.data.counts.waiting === 0);
const anon = await fetch(new URL("/api/agent/dashboard", process.env.BASE ?? "http://127.0.0.1:8099"));
check("the dashboard needs a sign-in", anon.status === 401 || anon.status === 403, String(anon.status));

send(a1.agent, { t: "agent.end" });
send(w1.agent, { t: "agent.end" });
await settle();

/* --- G. invalid transitions are never caused by clients --------------------------------------------- */
console.log("\n[G] nothing a client sends names a phase");
const c3 = await active(agentCookie, { machine: "PC-G", label: "g" });
c3.agent.received.length = 0;
send(c3.agent, { t: "session.phase", phase: "ENDED" });
send(c3.agent, { t: "agent.phase", phase: "ENDED" });
await sleep(200);
const live3 = (await agentApi.get("/sessions/live")).data.items.find((s) => s.id === c3.sessionId);
check("a forged phase message changes nothing", live3?.phase === "CONNECTED", JSON.stringify(live3?.phase));
send(c3.agent, { t: "agent.end" });
await settle();
const auditText = readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8")).join("");
check("the relay attempted no invalid transition during this whole block (audit)", !auditText.includes("session.invalid_transition"));
check("…nor logged one", !readFileSync(SERVER_LOG, "utf8").includes("[lifecycle] refused"));

report("ws/12 lifecycle");
