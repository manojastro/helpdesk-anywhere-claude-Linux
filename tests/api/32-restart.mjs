/**
 * Crash/restart reconciliation and the retention sweep. Two phases:
 *
 *   node 32-restart.mjs before   leave sessions open, age some records, then
 *                                KILL the server (-9) while this process still
 *                                holds the sockets — so nothing, not even a
 *                                socket close, reaches the server first
 *   (tests/run-all.sh: server_start)
 *   node 32-restart.mjs after    everything reconciled, retention applied
 */
import { readFileSync, writeFileSync } from "node:fs";

import { client } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, report, send, waitFor } from "../lib/harness.mjs";
import { active, create, settle } from "../lib/session.mjs";

const STATE = process.env.HDA_RESTART_STATE ?? "/tmp/hda-test-restart.json";
const phase = process.argv[2];
const cookie = process.env.HDA_AGENT_COOKIE;
const admin = client("admin", process.env.HDA_ADMIN_COOKIE);

if (phase === "before") {
  console.log("\n=== Restart reconciliation — before the crash ===\n");
  const live = await active(cookie, { label: "live" });
  send(live.agent, { t: "agent.chat", kind: "text", text: "before the crash", clientId: "k1" });
  await waitFor(live.host, (m) => m.t === "chat.message");
  const waiting = await create(cookie, "waiting");

  // An old ended session whose transcript is past TRANSCRIPT_RETENTION_DAYS (365),
  // and a very old one past SESSION_RETENTION_DAYS (730).
  const old = await active(cookie, { label: "old" });
  send(old.agent, { t: "agent.chat", kind: "text", text: "old chat", clientId: "o1" });
  await waitFor(old.host, (m) => m.t === "chat.message");
  await client("agent", cookie).post(`/sessions/${old.sessionId}/notes`, { body: "old notes" });
  send(old.agent, { t: "agent.end" });
  const ancient = await active(cookie, { label: "ancient" });
  send(ancient.agent, { t: "agent.end" });
  await settle(600);
  await sql("UPDATE sessions SET ended_at = now() - interval '400 days' WHERE id = $1", [old.sessionId]);
  await sql("UPDATE sessions SET ended_at = now() - interval '800 days' WHERE id = $1", [ancient.sessionId]);

  // A report whose download window has passed.
  const rep = await admin.post("/reports", { kind: "summary_csv", filters: {} });
  await settle(800);
  await sql("UPDATE report_exports SET expires_at = now() - interval '1 minute' WHERE id = $1", [rep.data.id]);

  const liveRow = (await sql("SELECT status FROM sessions WHERE id = $1", [live.sessionId]))[0];
  check("a live session is 'active' in the database before the crash", liveRow?.status === "active");
  writeFileSync(STATE, JSON.stringify({
    live: live.sessionId, waiting: waiting.created.sessionId, old: old.sessionId, ancient: ancient.sessionId, report: rep.data.id,
  }));

  // Crash the server while the technician and customer sockets are still open.
  const pidFile = process.env.SERVER_PID_FILE ?? "/tmp/hda-test-server.pid";
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  process.kill(pid, "SIGKILL");
  let dead = false;
  for (let i = 0; i < 50 && !dead; i++) {
    await settle(100);
    try { process.kill(pid, 0); } catch { dead = true; }
  }
  // Proof that the session was still open at the crash is in the "after" phase:
  // its end reason must be server_restart, not agent_disconnected.
  check("the server was killed (-9) while this process still held the sockets", dead);
  report("restart — before");
}

if (phase === "after") {
  console.log("\n=== Restart reconciliation — after the crash ===\n");
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  await settle(1500);  // the retention sweep runs asynchronously at startup

  for (const [label, id] of [["active", st.live], ["waiting", st.waiting]]) {
    const r = (await sql("SELECT status, end_reason, ended_at FROM sessions WHERE id = $1", [id]))[0];
    check(`the ${label} session left open by the crash is ended as server_restart`, r?.status === "ended" && r.end_reason === "server_restart" && r.ended_at !== null, JSON.stringify(r));
    const ev = await sql("SELECT type, actor_role, seq FROM session_events WHERE session_id = $1 ORDER BY seq", [id]);
    const last = ev.at(-1);
    check(`…with a server-side session.interrupted event as its last timeline entry`, last?.type === "session.interrupted" && last.actor_role === "system");
    check(`…appended after the existing events (seq ${last?.seq})`, ev.every((e, i) => e.seq === i + 1));
  }
  check("the chat stored before the crash survived it",
    (await sql("SELECT body FROM chat_messages WHERE session_id = $1", [st.live]))[0]?.body === "before the crash");
  const live = (await admin.get(`/sessions/live`)).data.items;
  check("nothing is reported live after the restart", live.length === 0);
  const det = (await admin.get(`/sessions/${st.live}`)).data;
  check("the admin detail shows the interruption", det.session.endReason === "server_restart" && det.timeline.at(-1).type === "session.interrupted");

  console.log("\n[R] Retention");
  const old = (await sql("SELECT transcript_purged_at FROM sessions WHERE id = $1", [st.old]))[0];
  check("a transcript older than TRANSCRIPT_RETENTION_DAYS is purged", old?.transcript_purged_at !== null);
  check("…its chat and notes rows are gone",
    (await sql("SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1", [st.old]))[0].n === 0
    && (await sql("SELECT count(*)::int AS n FROM session_notes WHERE session_id = $1", [st.old]))[0].n === 0);
  check("…but the session record and its timeline remain", (await sql("SELECT count(*)::int AS n FROM session_events WHERE session_id = $1", [st.old]))[0].n > 0);
  const tr = await admin.get(`/sessions/${st.old}/transcript`);
  check("the transcript API says 'purged' rather than showing an empty conversation", tr.data.purged === true);
  check("a session older than SESSION_RETENTION_DAYS is deleted entirely",
    (await sql("SELECT count(*)::int AS n FROM sessions WHERE id = $1", [st.ancient]))[0].n === 0);
  const rep = (await sql("SELECT status, content FROM report_exports WHERE id = $1", [st.report]))[0];
  check("an expired report's file is erased", rep.status === "expired" && rep.content === null);
  check("the purge is in the audit trail (counts only)",
    (await sql("SELECT detail FROM audit_log WHERE action = 'retention.purged'")).some((r) => r.detail.transcriptsPurged >= 1 && r.detail.sessionsDeleted >= 1));
  const settings = (await admin.get("/settings")).data;
  check("the retention policy is shown in the admin settings", settings.retention.transcriptDays === 365 && settings.retention.sessionDays === 730);

  // The relay still works after a restart.
  const again = await active(cookie, { label: "again" });
  check("new sessions work normally after the restart", !!again.sessionId);
  send(again.agent, { t: "agent.end" });
  report("restart — after");
}

if (phase !== "before" && phase !== "after") {
  console.error("usage: 32-restart.mjs before|after");
  process.exit(2);
}

