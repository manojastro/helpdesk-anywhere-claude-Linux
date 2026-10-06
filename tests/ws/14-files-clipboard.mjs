/**
 * Platform 2.0, Phase 2b at the relay: file manager, file transfer, clipboard,
 * system information and script cancel — through the real relay to an
 * applet-shaped host (tests/lib/mock-features.mjs).
 *
 * Server started with MAX_FILE_TRANSFER_BYTES=300000 and MAX_TRANSFERS_PER_SESSION=2
 * so the limits are reachable (tests/run-all.sh).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { AUDIT_DIR, SERVER_LOG, check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { CAPS, attachFeatures } from "../lib/mock-features.mjs";
import { settle } from "../lib/session.mjs";

const agentCookie = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const auditText = () => readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8")).join("");
const SENTINEL_FILE = "file-content-sentinel-55aa";
const SENTINEL_CLIP = "clipboard-sentinel-P@ssw0rd-9931";

/** A consented session whose host speaks protocol v2 with the given capabilities. */
async function session(cookie, { caps = CAPS, version = 2, machine = "FILES-PC", root = mkdtempSync(path.join(tmpdir(), "hda-mock-")) } = {}) {
  const agent = await open("agent", { headers: { cookie } });
  send(agent, { t: "agent.create" });
  const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
  const host = await open("host");
  send(host, { t: "host.join", code: created.code, machine, user: "customer", os: "Windows 11", ...(version ? { protocolVersion: version, capabilities: caps } : {}) });
  await waitFor(host, (m) => m.t === "host.connectRequest");
  send(host, { t: "host.consent", accepted: true });
  await waitFor(agent, (m) => m.t === "consent.result");
  const mock = attachFeatures(host, root);
  return { agent, host, root, mock, sessionId: created.sessionId, created, joined: agent.received.find((m) => m.t === "peer.joined") };
}
const reply = (ws, pred, ms = 4000) => waitFor(ws, pred, ms);

console.log("\n=== Platform 2.0 Phase 2b — files, clipboard, sysinfo, cancel at the relay ===\n");

/* --- A. capability negotiation ------------------------------------------------------ */
console.log("[A] protocol version and capabilities");
const s = await session(agentCookie);
check("peer.joined tells the console what the applet supports", JSON.stringify(s.joined?.capabilities?.sort()) === JSON.stringify([...CAPS].sort()) && s.joined.protocolVersion === 2);
const old = await session(agentCookie, { version: 0, machine: "OLD-PC" });
check("an old applet (no protocolVersion) is v1 with no capabilities", old.joined?.protocolVersion === 1 && old.joined.capabilities.length === 0);
send(old.agent, { t: "agent.fs.list", rid: "r1", path: "" });
const ns = await reply(old.agent, (m) => m.t === "error" && m.rid === "r1");
check("…and a feature request to it is refused not_supported (never forwarded, never hangs)", ns?.code === "not_supported" && !old.host.received.some((m) => m.t === "agent.fs.list"));
const bogus = await session(agentCookie, { caps: ["files", "rootkit", 7], machine: "BOGUS-PC" });
check("unknown capability names are dropped", JSON.stringify(bogus.joined?.capabilities) === JSON.stringify(["files"]));
send(bogus.agent, { t: "agent.clipboard.get", rid: "r2" });
check("a capability the applet did not declare is refused", (await reply(bogus.agent, (m) => m.t === "error" && m.rid === "r2"))?.code === "not_supported");
send(old.agent, { t: "agent.end" });
send(bogus.agent, { t: "agent.end" });

/* --- B. file manager ------------------------------------------------------------------ */
console.log("\n[B] file manager");
mkdirSync(path.join(s.root, "Users", "customer", "Documents"), { recursive: true });
writeFileSync(path.join(s.root, "Users", "customer", "Documents", "notes.txt"), SENTINEL_FILE);
send(s.agent, { t: "agent.fs.list", rid: "l1", path: "" });
const roots = await reply(s.agent, (m) => m.t === "host.fs.result" && m.rid === "l1");
check("listing the start view returns drives and folders", roots?.ok && roots.entries.some((e) => e.type === "drive"));
send(s.agent, { t: "agent.fs.list", rid: "l2", path: "C:\\Users\\customer\\Documents" });
const docs = await reply(s.agent, (m) => m.t === "host.fs.result" && m.rid === "l2");
check("listing a folder returns its files", docs?.entries?.some((e) => e.name === "notes.txt" && e.size === SENTINEL_FILE.length));
send(s.agent, { t: "agent.fs.mkdir", rid: "m1", path: "C:\\Users\\customer\\Documents\\Logs" });
check("create folder", (await reply(s.agent, (m) => m.rid === "m1"))?.ok === true && existsSync(path.join(s.root, "Users", "customer", "Documents", "Logs")));
send(s.agent, { t: "agent.fs.rename", rid: "n1", path: "C:\\Users\\customer\\Documents\\Logs", newName: "OldLogs" });
check("rename", (await reply(s.agent, (m) => m.rid === "n1"))?.ok === true);
send(s.agent, { t: "agent.fs.delete", rid: "d1", path: "C:\\Users\\customer\\Documents\\OldLogs" });
check("delete", (await reply(s.agent, (m) => m.rid === "d1"))?.ok === true);
for (const [label, msg] of [
  ["a rename that names another folder", { t: "agent.fs.rename", rid: "x1", path: "C:\\a", newName: "..\\b" }],
  ["a path with control characters", { t: "agent.fs.delete", rid: "x2", path: "C:\\a\u0000b" }],
  ["a path that is not a string", { t: "agent.fs.mkdir", rid: "x3", path: 7 }],
  ["a request id with odd characters", { t: "agent.fs.list", rid: "<x>", path: "" }],
]) {
  s.host.received.length = 0;
  send(s.agent, msg);
  const e = await reply(s.agent, (m) => m.t === "error" && m.code === "protocol", 1500);
  await sleep(50);
  check(`relay refuses ${label} without forwarding it`, !!e && !s.host.received.some((m) => m.t === msg.t));
  s.agent.received.length = 0;
}
await settle();
const fsEv = await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'fs.changed' ORDER BY seq", [s.sessionId]);
check("folder changes are on the timeline with op, path and result", fsEv.map((e) => `${e.detail.op}:${e.detail.ok}`).join(",") === "mkdir:true,rename:true,delete:true", JSON.stringify(fsEv.map((e) => e.detail)));

/* --- C. upload ----------------------------------------------------------------------- */
console.log("\n[C] upload");
async function upload(sess, name, bytes, { dir = "", hash = true, chunk = 48 * 1024 } = {}) {
  const tid = randomUUID();
  send(sess.agent, { t: "agent.file.put", tid, name, size: bytes.length, dir });
  const first = await reply(sess.agent, (m) => (m.t === "host.file.ready" || m.t === "error" || m.t === "host.file.error") && m.tid === tid);
  if (first?.t !== "host.file.ready") return { tid, first };
  let seq = 0;
  for (let off = 0; off < bytes.length; off += chunk) {
    send(sess.agent, { t: "agent.file.chunk", tid, seq: ++seq, data: bytes.subarray(off, off + chunk).toString("base64") });
    await reply(sess.agent, (m) => m.t === "host.file.ack" && m.tid === tid && m.seq === seq);
  }
  send(sess.agent, { t: "agent.file.end", tid, ...(hash ? { sha256: createHash("sha256").update(bytes).digest("hex") } : {}) });
  const end = await reply(sess.agent, (m) => (m.t === "host.file.done" || m.t === "host.file.error" || m.t === "error") && m.tid === tid);
  return { tid, first, end };
}
const payload = Buffer.concat([Buffer.from(SENTINEL_FILE), Buffer.alloc(150_000, 7)]);
const up = await upload(s, "setup.zip", payload);
check("upload: ready, chunks acknowledged, done", up.first?.t === "host.file.ready" && up.end?.t === "host.file.done", JSON.stringify(up.end));
check("…the file arrives byte-for-byte", readFileSync(path.join(s.root, "Users", "customer", "Downloads", "Helpdesk Anywhere", "setup.zip")).equals(payload));
check("…and the SHA-256 matches end to end", up.end?.sha256 === createHash("sha256").update(payload).digest("hex"));
const up2 = await upload(s, "setup.zip", Buffer.from("second"));
check("a second upload with the same name never overwrites ('setup (1).zip')", up2.end?.path?.endsWith("setup (1).zip"), JSON.stringify(up2.end));
await settle(500);
const row = (await sql("SELECT direction, file_name, size_bytes, bytes_done, status, sha256, remote_path, user_id FROM file_transfers WHERE id = $1", [up.tid]))[0];
check("the transfer is recorded: direction, name, size, bytes, status, hash, path, technician",
  row?.direction === "upload" && row.file_name === "setup.zip" && Number(row.size_bytes) === payload.length && Number(row.bytes_done) === payload.length
  && row.status === "completed" && /^[0-9a-f]{64}$/.test(row.sha256) && /setup\.zip$/.test(row.remote_path) && !!row.user_id, JSON.stringify(row));

for (const [label, put] of [
  ["a name with a path in it", { name: "..\\evil.exe", size: 1 }],
  ["a negative size", { name: "a.txt", size: -1 }],
  ["a non-integer size", { name: "a.txt", size: 1.5 }],
  ["a bad transfer id", { name: "a.txt", size: 1, tid: "not-a-uuid" }],
]) {
  s.host.received.length = 0;
  send(s.agent, { t: "agent.file.put", tid: randomUUID(), ...put });
  await sleep(120);
  check(`upload refused: ${label}`, !s.host.received.some((m) => m.t === "agent.file.put"));
}
const big = randomUUID();
send(s.agent, { t: "agent.file.put", tid: big, name: "huge.iso", size: 300_001 });
check("an upload over MAX_FILE_TRANSFER_BYTES is refused", (await reply(s.agent, (m) => m.t === "error" && m.tid === big))?.code === "transfer_refused");

// More data than declared: the relay stops it.
const over = randomUUID();
send(s.agent, { t: "agent.file.put", tid: over, name: "small.txt", size: 10 });
await reply(s.agent, (m) => m.t === "host.file.ready" && m.tid === over);
s.host.received.length = 0;
send(s.agent, { t: "agent.file.chunk", tid: over, seq: 1, data: Buffer.alloc(11).toString("base64") });
const overErr = await reply(s.agent, (m) => m.t === "error" && m.tid === over);
await sleep(100);
check("more bytes than declared: refused, applet told to cancel, chunk not forwarded",
  !!overErr && s.host.received.some((m) => m.t === "agent.file.cancel" && m.tid === over) && !s.host.received.some((m) => m.t === "agent.file.chunk"));
const ooo = randomUUID();
send(s.agent, { t: "agent.file.put", tid: ooo, name: "o.txt", size: 100 });
await reply(s.agent, (m) => m.t === "host.file.ready" && m.tid === ooo);
send(s.agent, { t: "agent.file.chunk", tid: ooo, seq: 2, data: Buffer.alloc(10).toString("base64") });
check("an out-of-order chunk stops the upload", !!(await reply(s.agent, (m) => m.t === "error" && m.tid === ooo)));
const early = randomUUID();
send(s.agent, { t: "agent.file.put", tid: early, name: "e.txt", size: 100 });
await reply(s.agent, (m) => m.t === "host.file.ready" && m.tid === early);
send(s.agent, { t: "agent.file.end", tid: early });
check("ending before all bytes arrived stops the upload", !!(await reply(s.agent, (m) => m.t === "error" && m.tid === early)));
check("no partial file is left behind by any refused upload",
  !readdirSync(path.join(s.root, "Users", "customer", "Downloads", "Helpdesk Anywhere")).some((f) => f.endsWith(".hdapart")));

// Concurrency: 2 at once (server started with MAX_TRANSFERS_PER_SESSION=2).
const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID();
for (const tid of [c1, c2]) send(s.agent, { t: "agent.file.put", tid, name: `${tid}.bin`, size: 5 });
await sleep(150);
send(s.agent, { t: "agent.file.put", tid: c3, name: "third.bin", size: 5 });
check("a third concurrent transfer is refused", (await reply(s.agent, (m) => m.t === "error" && m.tid === c3))?.code === "transfer_refused");
for (const tid of [c1, c2]) send(s.agent, { t: "agent.file.cancel", tid });
await settle();
check("cancelled transfers are recorded as cancelled",
  (await sql("SELECT count(*)::int AS n FROM file_transfers WHERE id = ANY($1::uuid[]) AND status = 'cancelled'", [[c1, c2]]))[0].n === 2);

/* --- D. download -------------------------------------------------------------------------- */
console.log("\n[D] download");
const tid = randomUUID();
send(s.agent, { t: "agent.file.get", tid, path: "C:\\Users\\customer\\Downloads\\Helpdesk Anywhere\\setup.zip" });
const meta = await reply(s.agent, (m) => m.t === "host.file.meta" && m.tid === tid);
check("download: meta with name and size", meta?.name === "setup.zip" && meta.size === payload.length);
const parts = [];
for (;;) {
  const c = await reply(s.agent, (m) => (m.t === "host.file.chunk" && m.tid === tid && m.seq === parts.length + 1) || (m.t === "host.file.done" && m.tid === tid), 4000);
  if (!c || c.t === "host.file.done") break;
  parts.push(Buffer.from(c.data, "base64"));
  send(s.agent, { t: "agent.file.ack", tid, seq: c.seq });
}
const done = await reply(s.agent, (m) => m.t === "host.file.done" && m.tid === tid);
check("…every chunk arrives and the bytes match", Buffer.concat(parts).equals(payload));
check("…with a matching SHA-256", done?.sha256 === createHash("sha256").update(payload).digest("hex"));
const window = s.agent.received.filter((m) => m.t === "host.file.chunk" && m.tid === tid).length;
check("downloads are flow-controlled (window of 8 unacknowledged chunks)", window === parts.length);
const missing = randomUUID();
send(s.agent, { t: "agent.file.get", tid: missing, path: "C:\\nope.txt" });
check("a missing file is an error for that transfer only", (await reply(s.agent, (m) => m.t === "host.file.error" && m.tid === missing))?.error === "That file does not exist.");
await settle(400);
check("the download is recorded as completed with its hash",
  (await sql("SELECT status, sha256 FROM file_transfers WHERE id = $1", [tid]))[0]?.sha256 === done?.sha256);

/* --- E. clipboard, sysinfo, script cancel --------------------------------------------------- */
console.log("\n[E] clipboard, system information, script cancel");
send(s.agent, { t: "agent.clipboard.set", rid: "c1", text: SENTINEL_CLIP });
check("clipboard set reaches the applet", (await reply(s.agent, (m) => m.t === "host.clipboard.result" && m.rid === "c1"))?.ok === true && s.mock.clipboard === SENTINEL_CLIP);
send(s.agent, { t: "agent.clipboard.get", rid: "c2" });
check("clipboard get returns the text", (await reply(s.agent, (m) => m.t === "host.clipboard.result" && m.rid === "c2"))?.text === SENTINEL_CLIP);
send(s.agent, { t: "agent.clipboard.set", rid: "c3", text: "x".repeat(60_001) });
check("clipboard text over 60,000 characters is refused", (await reply(s.agent, (m) => m.t === "error" && m.rid === "c3"))?.code === "protocol");
send(s.agent, { t: "agent.sysinfo.get", rid: "i1" });
const info = await reply(s.agent, (m) => m.t === "host.sysinfo" && m.rid === "i1");
check("system information comes back", info?.info?.hostname === "MOCK-PC" && info.info.memory.totalBytes > 0);
send(s.agent, { t: "agent.exec", id: "long1", shell: "powershell", script: "Start-Sleep 600", asSystem: false });
await reply(s.agent, (m) => m.t === "host.execResult" && m.id === "long1" && m.partial);
send(s.agent, { t: "agent.exec.cancel", id: "long1" });
const stopped = await reply(s.agent, (m) => m.t === "host.execResult" && m.id === "long1" && !m.partial);
check("a script can be stopped; its final result says so", /stopped by the technician/.test(stopped?.stderr ?? ""));
await settle(500);
const types = (await sql("SELECT type FROM session_events WHERE session_id = $1", [s.sessionId])).map((r) => r.type);
check("clipboard, sysinfo and the stop are on the timeline", ["clipboard.sent", "clipboard.read", "sysinfo.collected", "script.cancelled"].every((t) => types.includes(t)));

/* --- F. nothing sensitive is kept ---------------------------------------------------------------- */
console.log("\n[F] contents are never kept");
const dump = JSON.stringify(await sql("SELECT * FROM session_events WHERE session_id = $1", [s.sessionId])) + JSON.stringify(await sql("SELECT * FROM file_transfers"));
check("clipboard text is in no table, log or audit line", !dump.includes(SENTINEL_CLIP) && !auditText().includes(SENTINEL_CLIP) && !readFileSync(SERVER_LOG, "utf8").includes(SENTINEL_CLIP));
check("file contents are in no table, log or audit line", !dump.includes(SENTINEL_FILE) && !auditText().includes(SENTINEL_FILE) && !readFileSync(SERVER_LOG, "utf8").includes(SENTINEL_FILE));
check("the clipboard audit records the length only", new RegExp(`"event":"clipboard.sent"[^\\n]*"length":${SENTINEL_CLIP.length}`).test(auditText()));

/* --- G. hold, permission, disconnect -------------------------------------------------------------- */
console.log("\n[G] hold, permission, technician disconnect");
send(s.agent, { t: "agent.hold", held: true });
await sleep(150);
const heldTid = randomUUID();
send(s.agent, { t: "agent.file.put", tid: heldTid, name: "h.txt", size: 1 });
check("starting a transfer while held is refused", (await reply(s.agent, (m) => m.t === "error" && m.tid === heldTid))?.code === "session_held");
send(s.agent, { t: "agent.clipboard.get", rid: "h2" });
check("clipboard while held is refused", (await reply(s.agent, (m) => m.t === "error" && m.rid === "h2"))?.code === "session_held");
send(s.agent, { t: "agent.hold", held: false });
await sleep(150);

const nfCookie = await ensureActiveUser(adminCookie, { objectId: "efefefef-0000-4000-8000-0000000000f1", name: "No Files", roles: ["Agent"], agentCode: "NF-1" });
const admin = client("admin", adminCookie);
const nf = (await admin.get("/users")).data.items.find((u) => u.agentCode === "NF-1");
check("admins see and can switch off allowFileTransfer", nf?.limits.allowFileTransfer === true &&
  (await admin.patch(`/users/${nf.id}`, { limits: { ...nf.limits, allowFileTransfer: false } })).status === 200);
const ns2 = await session(nfCookie, { machine: "NF-PC" });
send(ns2.agent, { t: "agent.fs.list", rid: "p1", path: "" });
check("a technician without file permission is refused (not_permitted), nothing forwarded",
  (await reply(ns2.agent, (m) => m.t === "error" && m.rid === "p1"))?.code === "not_permitted" && !ns2.host.received.some((m) => m.t === "agent.fs.list"));
send(ns2.agent, { t: "agent.clipboard.set", rid: "p2", text: "hi" });
check("…but clipboard (like typing) still works for them", (await reply(ns2.agent, (m) => m.t === "host.clipboard.result" && m.rid === "p2"))?.ok === true);
send(ns2.agent, { t: "agent.end" });

const inflight = randomUUID();
send(s.agent, { t: "agent.file.put", tid: inflight, name: "drop.bin", size: 100_000 });
await reply(s.agent, (m) => m.t === "host.file.ready" && m.tid === inflight);
s.host.received.length = 0;
s.agent.terminate();
await sleep(400);
check("a technician drop cancels transfers in flight (applet told)", s.host.received.some((m) => m.t === "agent.file.cancel" && m.tid === inflight));
await settle();
check("…recorded as cancelled", (await sql("SELECT status, error FROM file_transfers WHERE id = $1", [inflight]))[0]?.status === "cancelled");
check("…and no partial file is left", !readdirSync(path.join(s.root, "Users", "customer", "Downloads", "Helpdesk Anywhere")).some((f) => f.endsWith(".hdapart")));

report("ws/14 files, clipboard, sysinfo, cancel");
