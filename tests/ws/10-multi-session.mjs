/**
 * Multi-session support at the relay — the boundary that decides everything.
 *
 *   node 10-multi-session.mjs main     limit, race, isolation, disconnect, resume, video priority
 *   node 10-multi-session.mjs expiry   reconnect grace running out (server started with a short grace)
 *
 * Needs a server with generous per-IP join/create limits (every host socket in
 * this file comes from 127.0.0.1): see tests/run-all.sh.
 */
import { IDS, client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, open, report, send, sleep, waitFor, WebSocket } from "../lib/harness.mjs";
import { active, create, settle } from "../lib/session.mjs";

const mode = process.argv[2] ?? "main";
const agentCookie = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const admin = client("admin", adminCookie);
const agentApi = client("agent", agentCookie);

const FULL = (tag) => Buffer.from([0x01, tag, 0xff, 0xd8]);
const RECT = (tag) => Buffer.from([0x02, 0, 0, 0, 0, 0, 1, 0, 1, tag]);
const binaries = (ws) => ws.received.filter((m) => m.t === "<binary>");

/** Collect binary payloads verbatim (harness only keeps their length). */
function tapFrames(ws) {
  ws.frames = [];
  ws.on("message", (d, bin) => { if (bin) ws.frames.push(Buffer.from(d)); });
}

/** A socket that tries to resume, returning the first answer. */
async function resume(sessionId, resumeToken, cookie = agentCookie, label = "resume") {
  const ws = await open(label, { headers: { cookie } });
  tapFrames(ws);
  send(ws, { t: "agent.resume", sessionId, resumeToken });
  const first = await waitFor(ws, (m) => m.t === "session.resumed" || m.t === "error", 4000);
  return { ws, first };
}

const liveCount = async () => (await agentApi.get("/sessions/live")).data;

if (mode === "main") {
  console.log("\n=== Multi-session: limit, isolation, resume ===\n");

  /* ---------------------------------------------------------------- A limit */
  console.log("[A] Four concurrent sessions; the fifth is refused");
  const me = await agentApi.get("/me");
  check("the console is told its effective limit (4)", me.data?.user?.maxSessions === 4, JSON.stringify(me.data?.user?.maxSessions));

  const s = [];
  for (let i = 1; i <= 4; i++) s.push(await active(agentCookie, { machine: `PC-${i}`, label: `m${i}` }));
  for (const x of s) tapFrames(x.agent);
  check("four sessions are active at once", s.every((x) => x.agent.readyState === WebSocket.OPEN && x.host.readyState === WebSocket.OPEN));
  check("each has its own session id", new Set(s.map((x) => x.sessionId)).size === 4);
  check("each got a resume token", s.every((x) => typeof x.created.resumeToken === "string" && x.created.resumeToken.length >= 40));

  const fifth = await create(agentCookie, "fifth");
  check("a fifth create is refused with session_limit", fifth.error?.code === "session_limit", JSON.stringify(fifth.error));
  check("…carrying maxSessions 4 and activeSessions 4", fifth.error?.maxSessions === 4 && fifth.error?.activeSessions === 4);
  check("…and the spec's wording", /Maximum concurrent session limit reached/.test(fifth.error?.message ?? ""));
  await sleep(150);
  check("no existing session was ended to make room", s.every((x) => x.host.readyState === WebSocket.OPEN && x.agent.readyState === WebSocket.OPEN));
  fifth.agent.close();

  let live = await liveCount();
  check("GET /api/agent/sessions/live reports 4 / 4", live.active === 4 && live.maxSessions === 4 && live.items.length === 4);
  check("…with no pairing code or resume token in it", !JSON.stringify(live).match(/"code"|resumeToken/));

  /* ------------------------------------------------------------ B isolation */
  console.log("\n[B] Nothing crosses sessions");
  for (const [i, x] of s.entries()) {
    send(x.agent, { t: "agent.input", kind: "mouse", x: 100 + i, y: 200 + i, action: "move", button: null });
    send(x.agent, { t: "agent.input", kind: "key", code: `Digit${i + 1}`, action: "down" });
  }
  await sleep(300);
  const inputsOk = s.every((x, i) => {
    const got = x.host.received.filter((m) => m.t === "agent.input");
    return got.length === 2 && got[0].x === 100 + i && got[1].code === `Digit${i + 1}`;
  });
  check("each host receives exactly its own technician's mouse and keys", inputsOk);

  for (const [i, x] of s.entries()) x.host.send(FULL(0x10 + i), { binary: true });
  await sleep(300);
  check("each technician receives only its own host's screen",
    s.every((x, i) => x.agent.frames.length === 1 && x.agent.frames[0][1] === 0x10 + i));

  for (const [i, x] of s.entries()) send(x.agent, { t: "agent.chat", kind: "text", text: `hello ${i}`, clientId: `c-${i}` });
  await sleep(500);
  check("each customer receives only its own session's chat",
    s.every((x, i) => {
      const got = x.host.received.filter((m) => m.t === "chat.message");
      return got.length === 1 && got[0].text === `hello ${i}` && got[0].id.startsWith(x.sessionId);
    }));
  const chatRows = await sql("SELECT session_id, body FROM chat_messages WHERE session_id = ANY($1::uuid[])", [s.map((x) => x.sessionId)]);
  check("stored chat rows carry their own session id",
    chatRows.length === 4 && chatRows.every((r) => r.body === `hello ${s.findIndex((x) => x.sessionId === r.session_id)}`));

  send(s[0].agent, { t: "agent.hold", held: true });
  await sleep(150);
  send(s[1].agent, { t: "agent.input", kind: "mouse", x: 5, y: 5, action: "move", button: null });
  await sleep(200);
  check("holding session 1 does not hold session 2", s[1].host.received.filter((m) => m.t === "agent.input").length === 3);
  send(s[0].agent, { t: "agent.hold", held: false });

  /* ------------------------------------------------------------- C race */
  console.log("\n[C] Race: two creates for the last slot at the same moment");
  send(s[3].agent, { t: "agent.end" });
  await waitFor(s[3].host, () => s[3].host.closed !== null, 2000);
  live = await liveCount();
  check("ending one session frees exactly one slot (3 / 4)", live.active === 3);
  check("…and the other three stay connected", s.slice(0, 3).every((x) => x.host.readyState === WebSocket.OPEN));

  const [r1, r2] = await Promise.all([open("race1", { headers: { cookie: agentCookie } }), open("race2", { headers: { cookie: agentCookie } })]);
  send(r1, { t: "agent.create" });
  send(r2, { t: "agent.create" });
  const [a1, a2] = await Promise.all([
    waitFor(r1, (m) => m.t === "session.created" || m.t === "error", 4000),
    waitFor(r2, (m) => m.t === "session.created" || m.t === "error", 4000),
  ]);
  const outcomes = [a1?.t === "session.created" ? "created" : a1?.code, a2?.t === "session.created" ? "created" : a2?.code].sort();
  check("exactly one becomes session #4; the other gets session_limit", outcomes[0] === "created" && outcomes[1] === "session_limit",
    JSON.stringify(outcomes));
  live = await liveCount();
  check("never more than 4 live", live.active === 4);
  // agent.end, not close(): a closed technician socket rightly keeps its slot
  // for the reconnect grace (section D).
  send(r1, { t: "agent.end" }); send(r2, { t: "agent.end" });
  await sleep(300);

  // A burst from a clean slate: six at once, exactly four win.
  for (const x of s.slice(0, 3)) send(x.agent, { t: "agent.end" });
  await sleep(500);
  check("after ending everything the technician holds 0", (await liveCount()).active === 0);
  const burst = await Promise.all([...Array(6)].map((_, i) => open(`burst${i}`, { headers: { cookie: agentCookie } })));
  for (const b of burst) send(b, { t: "agent.create" });
  const burstRes = await Promise.all(burst.map((b) => waitFor(b, (m) => m.t === "session.created" || m.t === "error", 4000)));
  const won = burstRes.filter((m) => m?.t === "session.created").length;
  const lost = burstRes.filter((m) => m?.code === "session_limit").length;
  check("six simultaneous creates: exactly four succeed, two are refused", won === 4 && lost === 2, `${won}/${lost}`);
  for (const b of burst) send(b, { t: "agent.end" });
  await sleep(500);

  /* ----------------------------------------------------------- D resume */
  console.log("\n[D] Technician reconnect: grace, ownership, token, catch-up");
  const r = await active(agentCookie, { machine: "PC-R", label: "r" });
  const other = await active(agentCookie, { machine: "PC-O", label: "o" });
  tapFrames(other.agent);
  r.host.send(FULL(0x51), { binary: true });
  r.host.send(RECT(0x52), { binary: true });
  await sleep(200);
  r.agent.terminate();  // abrupt: no agent.end, no close frame
  await sleep(300);
  check("the customer's side stays connected after the technician drops", r.host.readyState === WebSocket.OPEN && r.host.closed === null);
  live = await liveCount();
  const rLive = live.items.find((i) => i.id === r.sessionId);
  check("the session still holds its slot, marked reconnecting", live.active === 2 && rLive?.reconnecting === true);

  r.host.send(RECT(0x53), { binary: true });
  send(r.host, { t: "host.chat", text: "are you still there?", clientId: "h-1" });
  other.host.send(FULL(0x60), { binary: true });
  await sleep(400);
  check("an unrelated session keeps streaming meanwhile", other.agent.frames.some((f) => f[1] === 0x60));

  const badToken = await resume(r.sessionId, "not-the-token");
  check("resume with a wrong token is refused", badToken.first?.code === "resume_failed");
  const noToken = await resume(r.sessionId, undefined);
  check("resume with no token is refused", noToken.first?.code === "resume_failed");

  const intruderCookie = await ensureActiveUser(adminCookie, {
    objectId: "dddddddd-0000-4000-8000-00000000a902", name: "Other Tech", roles: ["Agent"], agentCode: "T-902",
  });
  const intruder = await resume(r.sessionId, r.created.resumeToken, intruderCookie, "intruder");
  check("another technician with the RIGHT token is still refused (ownership)", intruder.first?.code === "resume_failed");
  const intruderLive = await client("agent", intruderCookie).get("/sessions/live");
  check("…and cannot even see the session in their own live list", intruderLive.data.items.length === 0);

  const anon = await open("anon");
  send(anon, { t: "agent.resume", sessionId: r.sessionId, resumeToken: r.created.resumeToken });
  const anonAns = await waitFor(anon, (m) => m.t === "error", 2000);
  check("an anonymous (applet-shaped) socket cannot resume", anonAns?.code === "unauthorized");

  const good = await resume(r.sessionId, r.created.resumeToken);
  check("the owner with the right token resumes", good.first?.t === "session.resumed", JSON.stringify(good.first));
  check("…into the same, still active session", good.first?.sessionId === r.sessionId && good.first?.state === "active");
  check("…with the customer's machine restored", good.first?.host?.machine === "PC-R");
  check("…and a rotated token", typeof good.first?.resumeToken === "string" && good.first.resumeToken !== r.created.resumeToken);
  await sleep(300);
  const tags = good.ws.frames.map((f) => f[f.length - 1] === 0xd8 ? f[1] : f[f.length - 1]);
  check("the picture is replayed: keyframe then every rect since, in order",
    JSON.stringify(tags) === JSON.stringify([0x51, 0x52, 0x53]), JSON.stringify(tags));
  const hist = await waitFor(good.ws, (m) => m.t === "chat.history", 2000);
  check("chat sent while the technician was away is replayed", hist?.messages?.some((m) => m.text === "are you still there?" && m.senderRole === "host"));
  send(good.ws, { t: "agent.input", kind: "key", code: "KeyR", action: "down" });
  await sleep(200);
  check("input after resume reaches the right machine", r.host.received.some((m) => m.t === "agent.input" && m.code === "KeyR"));
  check("…and not the other one", !other.host.received.some((m) => m.t === "agent.input" && m.code === "KeyR"));
  const stale = await resume(r.sessionId, r.created.resumeToken, agentCookie, "stale");
  check("the old token no longer works", stale.first?.code === "resume_failed");
  await settle();
  const row = (await sql("SELECT reconnect_count, last_disconnect_reason FROM sessions WHERE id = $1", [r.sessionId]))[0];
  check("reconnect_count and the drop reason are recorded", row?.reconnect_count === 1 && row?.last_disconnect_reason === "connection_lost", JSON.stringify(row));
  const ev = (await sql("SELECT type FROM session_events WHERE session_id = $1 ORDER BY seq", [r.sessionId])).map((e) => e.type);
  check("the timeline has reconnecting then reconnected", ev.indexOf("agent.reconnecting") > 0 && ev.indexOf("agent.reconnected") > ev.indexOf("agent.reconnecting"));
  const otherEv = (await sql("SELECT type FROM session_events WHERE session_id = $1", [other.sessionId])).map((e) => e.type);
  check("…and none of it lands on the other session's timeline", !otherEv.some((t) => t.startsWith("agent.reconnect")));
  const auditRows = await sql("SELECT 1 FROM audit_log WHERE detail::text LIKE $1", [`%${r.created.resumeToken.slice(0, 16)}%`]);
  check("the resume token is in no audit row", auditRows.length === 0);

  /* ------------------------------------------------------------ E takeover */
  console.log("\n[E] A second window takes the session over cleanly");
  const take = await resume(r.sessionId, good.first.resumeToken, agentCookie, "take");
  check("resume while the old socket is still open succeeds", take.first?.t === "session.resumed");
  await sleep(300);
  check("the old socket is told and closed (4409)", good.ws.closed?.code === 4409);
  live = await liveCount();
  check("…without starting a reconnect grace", live.items.find((i) => i.id === r.sessionId)?.reconnecting === false);

  /* ------------------------------------------------------------ F preview */
  console.log("\n[F] Background sessions receive keyframes only; switching back catches up");
  const pv = take.ws;
  pv.frames = [];
  send(pv, { t: "agent.view", priority: "preview" });
  await sleep(100);
  r.host.send(RECT(0x71), { binary: true });
  r.host.send(FULL(0x72), { binary: true });
  r.host.send(RECT(0x73), { binary: true });
  r.host.send(RECT(0x74), { binary: true });
  await sleep(300);
  check("in preview only the keyframe is relayed", pv.frames.length === 1 && pv.frames[0][0] === 0x01 && pv.frames[0][1] === 0x72);
  check("agent.view never reaches the customer's machine", !r.host.received.some((m) => m.t === "agent.view"));
  send(pv, { t: "agent.view", priority: "full" });
  await sleep(300);
  const after = pv.frames.slice(1).map((f) => f[0] === 0x01 ? f[1] : f[f.length - 1]);
  check("switching to full replays keyframe + rects since", JSON.stringify(after) === JSON.stringify([0x72, 0x73, 0x74]), JSON.stringify(after));
  r.host.send(RECT(0x75), { binary: true });
  await sleep(200);
  check("…then live rects flow again", pv.frames.at(-1)?.[9] === 0x75);

  /* --------------------------------------------------- G admin visibility */
  console.log("\n[G] Admin portal: per-technician concurrency");
  const techs = await admin.get("/technicians/live");
  const mine = techs.data?.technicians?.find((t) => t.id && t.sessions?.some((x) => x.id === r.sessionId));
  check("the admin sees the technician at 2 / 4", mine?.active === 2 && mine?.maxSessions === 4, JSON.stringify(mine && { a: mine.active, m: mine.maxSessions }));
  check("…with each session's device, state and chat count", mine?.sessions.some((x) => x.customer?.machine === "PC-R" && x.chatCount >= 1 && x.state === "active"));
  check("…and no chat content", !JSON.stringify(techs.data).includes("are you still there?"));
  const users = await admin.get("/users");
  const agentUser = users.data.items.find((u) => u.objectId === IDS.agent);
  const tooMany = await admin.patch(`/users/${agentUser.id}`, { limits: { maxConcurrentSessions: 5 } });
  check("an account limit above the ceiling of 4 is refused", tooMany.status === 400 && tooMany.data.max === 4);
  check("the default account limit is 4", agentUser.limits.maxConcurrentSessions === 4 && agentUser.effectiveMaxSessions === 4);

  /* ------------------------------------------------ H revoked while away */
  console.log("\n[H] Suspending a technician ends sessions waiting in reconnect grace");
  const intruderApi = client("agent", intruderCookie);
  const iMe = await intruderApi.get("/me");
  const iSess = await active(intruderCookie, { machine: "PC-I", label: "i" });
  iSess.agent.terminate();
  await sleep(300);
  await admin.post(`/users/${iMe.data.user.id}/suspend`, { reason: "test" });
  await sleep(500);
  check("the customer's side is closed at once, not after the grace", iSess.host.closed !== null);
  await settle();
  const iRow = (await sql("SELECT status, end_reason FROM sessions WHERE id = $1", [iSess.sessionId]))[0];
  check("…recorded as agent_access_revoked", iRow?.status === "ended" && iRow?.end_reason === "agent_access_revoked", JSON.stringify(iRow));

  report("multi-session");
}

if (mode === "expiry") {
  console.log("\n=== Multi-session: reconnect grace expiry ===\n");
  const x = await active(agentCookie, { machine: "PC-X", label: "x" });
  const y = await active(agentCookie, { machine: "PC-Y", label: "y" });
  x.agent.terminate();
  await sleep(300);
  check("inside the grace the slot is still held", (await liveCount()).active === 2);
  await sleep(2000);
  check("after the grace the customer's side is closed", x.host.closed !== null);
  check("the other session is untouched", y.host.readyState === WebSocket.OPEN && y.agent.readyState === WebSocket.OPEN);
  check("the slot is released", (await liveCount()).active === 1);
  await settle();
  const row = (await sql("SELECT status, end_reason FROM sessions WHERE id = $1", [x.sessionId]))[0];
  check("the record ends as agent_disconnected", row?.status === "ended" && row?.end_reason === "agent_disconnected");
  const ev = (await sql("SELECT type FROM session_events WHERE session_id = $1 ORDER BY seq", [x.sessionId])).map((e) => e.type);
  check("timeline: reconnecting → reconnect_expired → ended",
    ev.includes("agent.reconnecting") && ev.indexOf("agent.reconnect_expired") > ev.indexOf("agent.reconnecting") && ev.at(-1) === "session.ended",
    JSON.stringify(ev));
  const late = await resume(x.sessionId, x.created.resumeToken);
  check("a resume after the grace is refused", late.first?.code === "resume_failed");
  report("multi-session expiry");
}
