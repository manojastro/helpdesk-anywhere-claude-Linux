/**
 * Security & reliability audit 2026-10-05 — runtime regression tests over the
 * real relay (docs/audit/SECURITY_AND_RELIABILITY_AUDIT.md).
 *
 *   F-03  removing "can use console" ends the user's live sessions at once
 *   F-04  signing out ends the sessions opened with that sign-in, not others
 *   F-05  unknown / malformed agent messages never reach the customer
 *   F-06  oversized host.join fields are truncated
 *   F-07  a flooding customer cannot exhaust the technician's chat allowance
 *   F-08  anonymous sockets per IP are capped
 *   F-09  a stalled technician socket does not make the relay queue every frame
 *   F-02  credential elevation over a plain ws:// customer leg is refused
 *
 * Needs generous per-IP join/create limits (every host socket here is
 * 127.0.0.1): see tests/run-all.sh.
 */
import { IDS, client, devLogin, ensureActiveUser } from "../lib/auth.mjs";
import { check, open, report, send, sleep, waitFor, WebSocket } from "../lib/harness.mjs";
import { active } from "../lib/session.mjs";

const agentCookie = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const admin = client("admin", adminCookie);

const closedWithin = async (ws, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ws.readyState === WebSocket.CLOSED) return true;
    await sleep(25);
  }
  return false;
};

console.log("\n=== Audit 2026-10-05: relay regression tests ===\n");

/* ------------------------------------------------------------------- F-05 */
console.log("[F-05] only known agent messages are forwarded");
{
  const s = await active(agentCookie, { label: "f05" });
  send(s.agent, { t: "agent.bogus", payload: "x" });
  send(s.agent, { t: "agent.input", kind: "nonsense", x: 1, y: 1, action: "move" });
  send(s.agent, { t: "agent.input", kind: "mouse", x: 5, y: 6, action: "move", button: null });
  await sleep(300);
  const got = s.host.received.filter((m) => typeof m.t === "string" && m.t.startsWith("agent."));
  check("an unknown agent.* type is not forwarded", !got.some((m) => m.t === "agent.bogus"));
  check("…an agent.input with an unknown kind is not forwarded", !got.some((m) => m.kind === "nonsense"));
  check("…well-formed input still is", got.some((m) => m.t === "agent.input" && m.kind === "mouse" && m.x === 5));
  check("…and the technician is told it was refused",
    s.agent.received.filter((m) => m.t === "error" && m.code === "protocol").length >= 2);

  send(s.agent, { t: "agent.hold", held: true });
  await waitFor(s.host, (m) => m.t === "agent.hold" && m.held === true);
  send(s.agent, { t: "agent.bogus", payload: "while held" });
  await sleep(250);
  check("an unknown agent.* type is not forwarded while HELD either",
    !s.host.received.some((m) => m.t === "agent.bogus"));
  check("the session survived all of it", s.host.readyState === WebSocket.OPEN && s.agent.readyState === WebSocket.OPEN);
  send(s.agent, { t: "agent.end" });
  await closedWithin(s.host);
}

/* ------------------------------------------------------------------- F-06 */
console.log("\n[F-06] host.join fields are bounded");
{
  const huge = "M".repeat(50_000);
  const s = await active(agentCookie, { label: "f06", machine: huge, user: "u\u0000\u0007ser", os: "W".repeat(1000) });
  const joined = await waitFor(s.agent, (m) => m.t === "peer.joined" && m.role === "host");
  check("the machine name reaches the technician truncated to 200", joined?.info?.machine?.length === 200, String(joined?.info?.machine?.length));
  check("…the OS too", joined?.info?.os?.length === 200);
  check("…control characters are stripped", joined?.info?.user === "user", JSON.stringify(joined?.info?.user));
  send(s.agent, { t: "agent.end" });
  await closedWithin(s.host);
}

/* ------------------------------------------------------------------- F-07 */
console.log("\n[F-07] chat rate limit is per side");
{
  const s = await active(agentCookie, { label: "f07" });
  for (let i = 0; i < 40; i++) send(s.host, { t: "host.chat", text: `flood ${i}`, clientId: `h${i}` });
  await waitFor(s.host, (m) => m.t === "error" && m.code === "chat_rate_limited", 3000);
  check("the customer's flood is limited", s.host.received.some((m) => m.t === "error" && m.code === "chat_rate_limited"));
  send(s.agent, { t: "agent.chat", kind: "text", text: "still here", clientId: "a1" });
  const echo = await waitFor(s.agent, (m) => (m.t === "chat.message" && m.clientId === "a1") || (m.t === "error" && m.clientId === "a1"), 3000);
  check("…but the technician can still send", echo?.t === "chat.message", JSON.stringify(echo));
  send(s.agent, { t: "agent.end" });
  await closedWithin(s.host);
}

/* ------------------------------------------------------------------- F-02 */
console.log("\n[F-02] credential elevation over a plain customer leg");
{
  const s = await active(agentCookie, { label: "f02" });
  send(s.agent, { t: "agent.requestElevation", mode: "credential", domain: ".", username: "admin", password: "Audit-Pw-5517" });
  const err = await waitFor(s.agent, (m) => m.t === "error" && m.code === "insecure_transport", 2000);
  await sleep(150);
  check("refused with insecure_transport", err !== null);
  check("…and nothing reached the customer", !s.host.received.some((m) => m.t === "agent.requestElevation"));
  send(s.agent, { t: "agent.end" });
  await closedWithin(s.host);
}

/* ------------------------------------------------------------------- F-09 */
console.log("\n[F-09] video backpressure");
{
  const s = await active(agentCookie, { label: "f09" });
  let received = 0;
  let keyframes = 0;
  s.agent.on("message", (d, bin) => {
    if (!bin) return;
    received++;
    if (d[0] === 0x01) keyframes++;
  });
  const chunk = (tag) => {
    const b = Buffer.alloc(512 * 1024, 0x55);
    b[0] = tag;
    return b;
  };
  s.host.send(chunk(0x01));
  await sleep(200);
  // Stop reading on the technician side: the relay's send buffer fills.
  s.agent._socket.pause();
  const SENT = 80;  // 40 MB of rects
  for (let i = 0; i < SENT; i++) {
    s.host.send(chunk(0x02));
    if (i % 8 === 7) await sleep(30);
  }
  await sleep(800);
  s.agent._socket.resume();
  await sleep(1500);
  // One more rect after the drain: it must arrive preceded by a keyframe replay.
  const before = keyframes;
  s.host.send(chunk(0x02));
  await sleep(800);
  check("the relay skipped frames instead of queueing all of them", received < SENT + 1, `${received} of ${SENT + 1} delivered`);
  check("…the session is still up", s.agent.readyState === WebSocket.OPEN && s.host.readyState === WebSocket.OPEN);
  check("…and the picture is rebuilt with a keyframe replay once it drains", keyframes > before || keyframes >= 2, `keyframes ${before}→${keyframes}`);
  send(s.agent, { t: "agent.end" });
  await closedWithin(s.host);
}

/* ------------------------------------------------------------------- F-04 */
console.log("\n[F-04] sign-out ends that sign-in's sessions");
{
  // A second, independent sign-in for the same technician.
  const second = await devLogin("agent", { objectId: IDS.agent, name: "Test Agent", roles: ["Agent"] });
  check("a second sign-in for the technician", second.status === 200, JSON.stringify(second.body));
  const doomed = await active(second.cookie, { label: "f04a" });
  const survivor = await active(agentCookie, { label: "f04b" });
  const out = await client("agent", second.cookie).post("/auth/logout", {});
  check("POST /auth/logout succeeds", out.status === 204, String(out.status));
  check("the session opened with that sign-in ends at once", await closedWithin(doomed.agent));
  check("…the customer's side is closed too", await closedWithin(doomed.host));
  check("…the technician was told why", doomed.agent.received.some((m) => m.t === "error" && m.code === "access_revoked"));
  check("a session opened with a DIFFERENT sign-in is untouched",
    survivor.agent.readyState === WebSocket.OPEN && survivor.host.readyState === WebSocket.OPEN);
  send(survivor.agent, { t: "agent.end" });
  await closedWithin(survivor.host);
}

/* ------------------------------------------------------------------- F-03 */
console.log("\n[F-03] removing console access ends live sessions");
{
  const oid = "cccccccc-0000-4000-8000-0000000a0d03";
  const cookie = await ensureActiveUser(adminCookie, { objectId: oid, name: "Audit Tech", roles: ["Agent"], agentCode: "AUD-03" });
  const me = await client("agent", cookie).get("/me");
  const userId = me.data?.user?.id;
  const s = await active(cookie, { label: "f03" });
  const patch = await admin.patch(`/users/${userId}`, { limits: { canUseConsole: false } });
  check("the admin clears 'can use console'", patch.status === 200, JSON.stringify(patch.data));
  check("the technician's socket is closed at once", await closedWithin(s.agent));
  check("…and the customer's", await closedWithin(s.host));
  check("…with access_revoked", s.agent.received.some((m) => m.t === "error" && m.code === "access_revoked"));
  const again = await open("f03-again", { headers: { cookie } });
  send(again, { t: "agent.create" });
  const r = await waitFor(again, (m) => m.t === "session.created" || m.t === "error", 3000);
  check("a new socket cannot create a session either", r?.t !== "session.created", JSON.stringify(r));
  again.close();
  await admin.patch(`/users/${userId}`, { limits: { canUseConsole: true } });
}

/* ------------------------------------------------------------------- F-08 */
console.log("\n[F-08] anonymous sockets per IP are capped");
{
  await sleep(300);
  const held = [];
  let refused = null;
  for (let i = 0; i < 25; i++) {
    try {
      held.push(await open(`anon${i}`));
    } catch (e) {
      refused = e;
      break;
    }
  }
  check("sockets up to the cap are accepted", held.length === 20, `${held.length} accepted`);
  check("…the next is refused with 429", refused !== null && /429/.test(String(refused?.message)), String(refused?.message));
  let tech = null;
  try { tech = await open("tech", { headers: { cookie: agentCookie } }); } catch { /* checked below */ }
  check("a signed-in technician socket is not counted against the anonymous cap", tech?.readyState === WebSocket.OPEN);
  tech?.close();
  for (const ws of held) ws.close();
  await sleep(300);
  let reopened = null;
  try { reopened = await open("anon-after"); } catch { /* checked below */ }
  check("closing them frees the slots", reopened !== null);
  reopened?.close();
}

/* ------------------------------------------------------------------- F-10 */
console.log("\n[F-10] a supervisor with no team sees only themselves");
{
  // A team-less technician who must NOT appear in the supervisor's list.
  const looseCookie = await ensureActiveUser(adminCookie, { objectId: "cccccccc-0000-4000-8000-0000000a0d10", name: "Loose Tech", roles: ["Agent"], agentCode: "AUD-10" });
  const beat = await client("agent", looseCookie).post("/presence", {});
  check("the team-less technician is online (heartbeat)", beat.status === 204, String(beat.status));
  const supCookie = await ensureActiveUser(adminCookie,
    { objectId: "cccccccc-0000-4000-8000-0000000a0d11", name: "Teamless Sup", roles: ["Supervisor"], agentCode: "AUD-11" }, "admin");
  const users = await client("admin", supCookie).get("/users");
  const names = (users.data?.items ?? []).map((u) => u.displayName);
  check("GET /users answers", users.status === 200, String(users.status));
  check("…listing only the supervisor", names.length === 1 && names[0] === "Teamless Sup", JSON.stringify(names));
  const dash = await client("admin", supCookie).get("/dashboard");
  check("the dashboard's online list leaks no other team-less user",
    !(dash.data?.onlineAgents ?? []).some((a) => a.name !== "Teamless Sup"), JSON.stringify(dash.data?.onlineAgents));
}

report("audit fixes");
