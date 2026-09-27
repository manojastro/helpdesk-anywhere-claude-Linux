/**
 * Report exports: session PDF and summary CSV — permitted content only, never a
 * pairing code or secret, download only by the requester within the TTL, and
 * every request, download and refusal audited.
 */
import { inflateSync } from "node:zlib";

import { ADMIN_BASE, BASE, client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { active, settle } from "../lib/session.mjs";

const adminCookie = process.env.HDA_ADMIN_COOKIE;
const agentCookie = process.env.HDA_AGENT_COOKIE;
const admin = client("admin", adminCookie);

/** The text a pdfkit document draws: inflate each stream and decode its TJ/Tj strings. */
function pdfText(buf) {
  const src = buf.toString("latin1");
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end === -1) break;
    let body = Buffer.from(src.slice(start, end).replace(/\r?\n$/, ""), "latin1");
    try { body = inflateSync(body); } catch { /* not compressed */ }
    const ops = body.toString("latin1");
    for (const t of ops.matchAll(/\[(.*?)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/gs)) {
      const hexes = t[1] !== undefined ? [...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]) : [t[2]];
      out.push(hexes.map((h) => Buffer.from(h, "hex").toString("latin1")).join(""));
    }
    re.lastIndex = end;
  }
  return out.join("\n");
}

async function waitReady(api, id) {
  for (let i = 0; i < 40; i++) {
    const r = await api.get(`/reports/${id}`);
    if (r.data?.status && r.data.status !== "pending") return r.data;
    await sleep(150);
  }
  return null;
}

console.log("\n=== Reports: PDF, CSV, download authorisation, audit ===\n");

// A session with chat and notes, and a device name that is a spreadsheet formula.
const s = await active(agentCookie, { machine: "=HYPERLINK(\"http://evil.example\",\"x\")", user: "erin", label: "rep" });
send(s.agent, { t: "agent.chat", kind: "text", text: "Rebooting your router now", clientId: "r1" });
await waitFor(s.host, (m) => m.t === "chat.message");
send(s.host, { t: "host.chat", text: "Okay, thanks", clientId: "r2" });
await waitFor(s.agent, (m) => m.t === "chat.message" && m.senderRole === "host");
await client("agent", agentCookie).post(`/sessions/${s.sessionId}/notes`, { body: "Private note: router firmware 1.2.3" });
send(s.agent, { t: "agent.requestElevation", mode: "credential", domain: ".", username: "admin", password: "Sup3r-S3cret-PW!" });
send(s.agent, { t: "agent.end" });
await settle(600);

/* ------------------------------------------------------------------- PDF */
console.log("[R1] Session PDF");
const req = await admin.post("/reports", { kind: "session_pdf", sessionId: s.sessionId });
check("an admin requests a session PDF (202, pending)", req.status === 202 && req.data.status === "pending");
const ready = await waitReady(admin, req.data.id);
check("…which becomes ready", ready?.status === "ready", JSON.stringify(ready));
const dl = await admin.raw("GET", `/reports/${req.data.id}/download`);
const pdf = Buffer.from(await dl.arrayBuffer());
check("the requester downloads it", dl.status === 200 && pdf.subarray(0, 5).toString() === "%PDF-");
check("…as an attachment that is never cached", /attachment/.test(dl.headers.get("content-disposition") ?? "") && dl.headers.get("cache-control") === "no-store");
const text = pdfText(pdf);
check("the PDF contains the session id, technician and device", text.includes(s.sessionId) && text.includes("Suite Technician") && text.includes("erin"));
check("…the timeline", text.includes("Consent accepted") && text.includes("Session ended"));
check("…the chat transcript", text.includes("Rebooting your router now") && text.includes("Okay, thanks"));
check("…and the notes", text.includes("router firmware 1.2.3"));
check("…but NOT the pairing code", !text.includes(s.code));
check("…and NOT the elevation password or account", !text.includes("Sup3r-S3cret-PW!") && !text.includes("username"));

const noNotes = await admin.post("/reports", { kind: "session_pdf", sessionId: s.sessionId, includeNotes: false, includeChat: false });
await waitReady(admin, noNotes.data.id);
const text2 = pdfText(Buffer.from(await (await admin.raw("GET", `/reports/${noNotes.data.id}/download`)).arrayBuffer()));
check("chat and notes are left out when not requested", !text2.includes("router firmware") && !text2.includes("Rebooting") && text2.includes("Not included in this report"));

/* --------------------------------------------------------- download control */
console.log("\n[R2] Only the requester, only within the TTL");
const other = client("admin", await ensureActiveUser(adminCookie, { objectId: "12340000-0000-4000-8000-0000000000a2", name: "Other Admin", roles: ["Admin"], agentCode: "ADM-2" }, "admin"));
const stolen = await other.raw("GET", `/reports/${req.data.id}/download`);
check("another administrator cannot download someone else's report", stolen.status === 404);
check("…nor see it in their list", !(await other.get("/reports")).data.items.some((r) => r.id === req.data.id));
check("an unauthenticated download is refused", (await fetch(`${ADMIN_BASE}/api/admin/reports/${req.data.id}/download`)).status === 401);
check("a console (agent) cookie cannot download", (await fetch(`${ADMIN_BASE}/api/admin/reports/${req.data.id}/download`, { headers: { cookie: agentCookie } })).status === 401);
check("reports are not served by the console application at all", (await fetch(`${BASE}/api/admin/reports/${req.data.id}/download`, { headers: { cookie: adminCookie } })).status === 404);
await sql("UPDATE report_exports SET expires_at = now() - interval '1 second' WHERE id = $1", [req.data.id]);
check("after the TTL even the requester gets a 404", (await admin.raw("GET", `/reports/${req.data.id}/download`)).status === 404);
check("…and the list shows it expired", (await admin.get(`/reports/${req.data.id}`)).data.status === "expired");

const audit = await sql("SELECT action, actor_user_id, detail FROM audit_log WHERE target_id = $1 ORDER BY id", [req.data.id]);
const actions = audit.map((a) => a.action);
check("the request is audited", actions.includes("report.requested"));
check("the download is audited", actions.filter((a) => a === "report.downloaded").length === 1);
check("refused downloads are audited too", actions.filter((a) => a === "report.denied").length >= 2, actions.join(","));

/* ------------------------------------------------------------------- CSV */
console.log("\n[R3] Summary CSV");
const csvReq = await admin.post("/reports", { kind: "summary_csv", filters: { status: "ended" } });
await waitReady(admin, csvReq.data.id);
const csv = await (await admin.raw("GET", `/reports/${csvReq.data.id}/download`)).text();
const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
check("the CSV has the documented header", lines[0] === "session_id,created_at,agent,agent_id,team,status,end_reason,consent,customer_machine,customer_user,customer_os,active_at,ended_at,duration_seconds,record_complete");
check("…one row per session, including this one", lines.some((l) => l.startsWith(s.sessionId)));
check("…honouring the filter (ended only)", lines.slice(1).every((l) => l.split(",")[5] === "ended"));
check("…never chat bodies, notes or codes", !csv.includes("Rebooting") && !csv.includes("firmware") && !csv.includes(s.code));
check("…and neutralises a formula in a device name", csv.includes("\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"x\"\")\"") && !/,=HYPERLINK/.test(csv));

console.log("\n[R4] Export permissions");
const me = (await admin.get("/me")).data.user;
await other.patch(`/users/${me.id}`, { limits: { canExport: false } });
const denied = await admin.post("/reports", { kind: "summary_csv", filters: {} });
check("an account whose export permission is withdrawn is refused (403)", denied.status === 403);
await other.patch(`/users/${me.id}`, { limits: { canExport: true } });
check("…and allowed again when restored", (await admin.post("/reports", { kind: "summary_csv", filters: {} })).status === 202);
check("an unknown report kind is refused", (await admin.post("/reports", { kind: "everything" })).status === 400);

console.log("\n[R5] The credential-mode elevation password is nowhere");
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const { AUDIT_DIR, SERVER_LOG } = await import("../lib/harness.mjs");
  const secret = "Sup3r-S3cret-PW!";
  const dbHits = await sql(`SELECT
      (SELECT count(*) FROM session_events WHERE detail::text LIKE $1)
    + (SELECT count(*) FROM audit_log WHERE detail::text LIKE $1)
    + (SELECT count(*) FROM chat_messages WHERE coalesce(body,'') LIKE $1)
    + (SELECT count(*) FROM sessions WHERE row_to_json(sessions)::text LIKE $1)
    + (SELECT count(*) FROM report_exports WHERE position(convert_to($2, 'LATIN1') IN coalesce(content, ''::bytea)) > 0) AS n`,
    [`%${secret}%`, secret]);
  check("not in any database table", Number(dbHits[0].n) === 0);
  const jsonl = readdirSync(AUDIT_DIR).map((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8")).join("");
  check("not in the JSONL security log (which did record the attempt)", !jsonl.includes(secret) && jsonl.includes('"mode":"credential"'));
  check("not in the server's output", !readFileSync(SERVER_LOG, "utf8").includes(secret));
}

report("reports");
