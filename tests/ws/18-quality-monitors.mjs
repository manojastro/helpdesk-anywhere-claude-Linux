/**
 * Platform 2.0, Phase 6 at the relay: stream quality profiles and the monitor
 * layout (`shared/protocol.md` "Phase 6").
 *
 *   - `agent.quality` only reaches an applet that declared "quality"; it is
 *     validated, rebuilt (nothing but the profile is forwarded) and allowed
 *     while the session is held;
 *   - `host.quality` reaches the console with the fps the RELAY assigns to the
 *     profile, and is put on the timeline once per actual change;
 *   - `host.monitors` is rebuilt field by field and dropped unless every
 *     rectangle lies inside the virtual screen;
 *   - both are replayed on `session.resumed` (technician reconnect / transfer).
 */
import { sql } from "../lib/db.mjs";
import { check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";

const cookie = process.env.HDA_AGENT_COOKIE;
console.log("\n=== Platform 2.0 Phase 6: stream quality and monitors ===\n");

async function session(caps, machine) {
  const agent = await open("agent", { headers: { cookie } });
  send(agent, { t: "agent.create" });
  const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
  const host = await open("host");
  send(host, { t: "host.join", code: created.code, machine, user: "customer", os: "Windows 11", protocolVersion: 2, capabilities: caps });
  await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  return { agent, host, created };
}
const since = (ws, n) => ws.received.slice(n);

/* --- 1. an older applet ------------------------------------------------------- */
const old = await session(["files", "clipboard"], "OLD-PC");
send(old.agent, { t: "agent.quality", profile: "low", rid: "o1" });
const oldErr = await waitFor(old.agent, (m) => m.t === "error" && m.rid === "o1", 3000);
check("an applet without \"quality\": refused not_supported, with the request's rid", oldErr?.code === "not_supported", JSON.stringify(oldErr));
await sleep(200);
check("…and nothing reached the applet", !old.host.received.some((m) => m.t === "agent.quality"));
send(old.agent, { t: "agent.end" });

/* --- 2. quality ----------------------------------------------------------------- */
const s = await session(["quality", "monitors", "resume"], "QUAL-PC");
send(s.agent, { t: "agent.quality", profile: "ultra", rid: "q0" });
check("an unknown profile is refused as a protocol error",
  (await waitFor(s.agent, (m) => m.t === "error" && m.rid === "q0", 3000))?.code === "protocol");
send(s.agent, { t: "agent.quality", profile: { x: 1 }, rid: "q0b" });
check("a non-string profile is refused too", (await waitFor(s.agent, (m) => m.t === "error" && m.rid === "q0b", 3000))?.code === "protocol");
await sleep(200);
check("…and neither reached the applet", !s.host.received.some((m) => m.t === "agent.quality"));

send(s.agent, { t: "agent.quality", profile: "low", rid: "q1", extra: "x".repeat(50) });
const fwd = await waitFor(s.host, (m) => m.t === "agent.quality", 3000);
check("a valid profile reaches the applet", fwd?.profile === "low");
check("…rebuilt by the relay: only t and profile", JSON.stringify(Object.keys(fwd ?? {}).sort()) === JSON.stringify(["profile", "t"]), JSON.stringify(fwd));

let mark = s.agent.received.length;
send(s.host, { t: "host.quality", profile: "low", fps: 999, junk: true });
await sleep(300);
const ack = since(s.agent, mark).find((m) => m.t === "host.quality");
check("host.quality reaches the console with the relay's fps for the profile (2, not 999)", ack?.profile === "low" && ack?.fps === 2, JSON.stringify(ack));
check("…and nothing the applet added", ack && !("junk" in ack));

mark = s.agent.received.length;
send(s.host, { t: "host.quality", profile: "turbo", fps: 60 });
await sleep(300);
check("an unknown profile from the applet is dropped", !since(s.agent, mark).some((m) => m.t === "host.quality"));

// Hold does not block a frame-rate change.
send(s.agent, { t: "agent.hold", held: true });
await waitFor(s.host, (m) => m.t === "agent.hold", 3000);
const before = s.host.received.filter((m) => m.t === "agent.quality").length;
send(s.agent, { t: "agent.quality", profile: "balanced", rid: "q2" });
await sleep(400);
check("agent.quality is allowed while held", s.host.received.filter((m) => m.t === "agent.quality").length === before + 1);
check("…without a session_held refusal", !s.agent.received.some((m) => m.t === "error" && m.rid === "q2"));
send(s.host, { t: "host.quality", profile: "balanced", fps: 5 });
send(s.host, { t: "host.quality", profile: "balanced", fps: 5 });  // no change: not a second event
send(s.agent, { t: "agent.hold", held: false });
await sleep(400);

/* --- 3. monitors ------------------------------------------------------------------ */
const layout = { t: "host.monitors", width: 3840, height: 1080, monitors: [
  { index: 7, primary: true, x: 0, y: 0, width: 1920, height: 1080, name: "\\\\.\\DISPLAY1" },
  { index: 9, primary: false, x: 1920, y: 0, width: 1920, height: 1080 },
] };
mark = s.agent.received.length;
send(s.host, layout);
await sleep(300);
const mon = since(s.agent, mark).find((m) => m.t === "host.monitors");
check("host.monitors reaches the console", mon?.monitors?.length === 2 && mon.width === 3840 && mon.height === 1080, JSON.stringify(mon));
check("…rebuilt: indexes renumbered from 1, unknown fields dropped",
  mon?.monitors[0].index === 1 && mon.monitors[1].index === 2 && !("name" in mon.monitors[0]) && mon.monitors[0].primary === true);

for (const [label, bad] of [
  ["a rectangle past the right edge", { ...layout, monitors: [{ x: 3000, y: 0, width: 1920, height: 1080 }] }],
  ["a negative origin", { ...layout, monitors: [{ x: -1920, y: 0, width: 1920, height: 1080 }] }],
  ["a fractional size", { ...layout, monitors: [{ x: 0, y: 0, width: 1920.5, height: 1080 }] }],
  ["no monitors", { ...layout, monitors: [] }],
  ["seventeen monitors", { ...layout, monitors: Array.from({ length: 17 }, () => ({ x: 0, y: 0, width: 10, height: 10 })) }],
  ["an absurd virtual screen", { ...layout, width: 100000 }],
]) {
  mark = s.agent.received.length;
  send(s.host, bad);
  await sleep(150);
  check(`a layout with ${label} is dropped`, !since(s.agent, mark).some((m) => m.t === "host.monitors"));
}

/* --- 4. replay on resume -------------------------------------------------------- */
s.agent.close();
await sleep(300);
const again = await open("agent-resume", { headers: { cookie } });
send(again, { t: "agent.resume", sessionId: s.created.sessionId, resumeToken: s.created.resumeToken });
const resumed = await waitFor(again, (m) => m.t === "session.resumed" || m.t === "error", 4000);
check("a reconnecting technician resumes", resumed?.t === "session.resumed", JSON.stringify(resumed)?.slice(0, 200));
check("…and gets the confirmed quality back", resumed?.quality?.profile === "balanced" && resumed.quality.fps === 5, JSON.stringify(resumed?.quality));
check("…and the last valid monitor layout (not a dropped one)", resumed?.monitors?.monitors?.length === 2 && resumed.monitors.width === 3840, JSON.stringify(resumed?.monitors));

/* --- 5. records -------------------------------------------------------------------- */
await sleep(500);
const ev = await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'stream.quality' ORDER BY seq", [s.created.sessionId]);
check("the timeline records each actual change once (low, balanced)",
  ev.map((r) => r.detail.profile).join(",") === "low,balanced", JSON.stringify(ev.map((r) => r.detail)));

send(again, { t: "agent.end" });
await sleep(200);
report("ws/18 quality and monitors");
