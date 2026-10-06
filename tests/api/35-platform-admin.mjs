/**
 * Platform 2.0 Phase 4 + observability: richer history and reports, dashboard
 * counts, technician management, SuperAdmin, request ids, access log, /metrics.
 * Server started with METRICS_TOKEN=test-metrics-token-12345 (tests/run-all.sh).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ADMIN_BASE, BASE, client, devLogin, ensureActiveUser } from "../lib/auth.mjs";
import { SERVER_LOG, check, open, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { attachFeatures } from "../lib/mock-features.mjs";
import { pdfContent } from "../lib/pdftext.mjs";
import { settle } from "../lib/session.mjs";

const adminCookie = process.env.HDA_ADMIN_COOKIE;
const agentCookie = process.env.HDA_AGENT_COOKIE;
const admin = client("admin", adminCookie);
const METRICS = "test-metrics-token-12345";

console.log("\n=== Platform 2.0 — admin, reports, observability ===\n");

/* --- a session with a script, a file and a transfer ---------------------------------- */
const cookieB = await ensureActiveUser(adminCookie, { objectId: "c3c3c3c3-0000-4000-8000-0000000000b3", name: "Bob Handover", roles: ["Agent"], agentCode: "BOB-3" });
const lobbyB = await open("lobbyB", { headers: { cookie: cookieB } });
send(lobbyB, { t: "agent.listen" });
await waitFor(lobbyB, (m) => m.t === "lobby.ready");
const agent = await open("agent", { headers: { cookie: agentCookie } });
send(agent, { t: "agent.create" });
const created = await waitFor(agent, (m) => m.t === "session.created", 4000);
const host = await open("host");
send(host, { t: "host.join", code: created.code, machine: "REPORT-PC", user: "rita", os: "Windows 11", protocolVersion: 2, capabilities: ["files", "transfer", "resume"] });
await waitFor(host, (m) => m.t === "host.connectRequest");
send(host, { t: "host.consent", accepted: true });
await waitFor(agent, (m) => m.t === "consent.result");
attachFeatures(host, mkdtempSync(path.join(tmpdir(), "hda-rep-")));
send(agent, { t: "agent.exec", id: "s1", shell: "cmd", script: "ipconfig /all", asSystem: false, libraryRef: { id: "builtin:ip-configuration", version: 1 } });
const tid = randomUUID();
send(agent, { t: "agent.file.put", tid, name: "driver-pack.zip", size: 5, dir: "" });
await waitFor(agent, (m) => m.t === "host.file.ready");
send(agent, { t: "agent.file.chunk", tid, seq: 1, data: Buffer.from("hello").toString("base64") });
await waitFor(agent, (m) => m.t === "host.file.ack");
send(agent, { t: "agent.file.end", tid });
await waitFor(agent, (m) => m.t === "host.file.done");
const users = (await admin.get("/users")).data.items;
send(agent, { t: "agent.transfer.offer", toUserId: users.find((u) => u.agentCode === "BOB-3").id });
const offer = await waitFor(lobbyB, (m) => m.t === "transfer.offer");
send(lobbyB, { t: "agent.transfer.accept", transferId: offer.transferId });
const ask = await waitFor(host, (m) => m.t === "host.transferRequest");
send(host, { t: "host.transferConsent", transferId: ask.transferId, accepted: true });
const ready = await waitFor(lobbyB, (m) => m.t === "transfer.ready");
const b = await open("B", { headers: { cookie: cookieB } });
send(b, { t: "agent.resume", sessionId: created.sessionId, resumeToken: ready.resumeToken });
await waitFor(b, (m) => m.t === "session.resumed");
send(b, { t: "agent.end" });
await settle(800);

/* --- history and detail --------------------------------------------------------------- */
console.log("[P1] history and session detail");
const list = await admin.get(`/sessions?q=REPORT-PC`);
const row = list.data.items[0];
check("history rows carry phase, scripts, files, transferred-from and reconnects",
  row?.phase === "ENDED" && row.scriptsExecuted === 1 && row.filesTransferred === 1 && row.transferredFrom && row.agent.name === "Bob Handover", JSON.stringify(row).slice(0, 300));
check("history can be filtered by result (phase)", (await admin.get(`/sessions?phase=DECLINED&q=REPORT-PC`)).data.items.length === 0
  && (await admin.get(`/sessions?phase=ENDED&q=REPORT-PC`)).data.items.length === 1);
check("a junk phase filter is ignored, not an error", (await admin.get(`/sessions?phase=1;DROP`)).status === 200);
const detail = (await admin.get(`/sessions/${created.sessionId}`)).data;
check("detail lists the file transfer (name, size, status, by)", detail.fileTransfers?.[0]?.name === "driver-pack.zip" && detail.fileTransfers[0].size === 5 && detail.fileTransfers[0].status === "completed" && detail.fileTransfers[0].by);
check("detail lists the session transfer", detail.transfers?.[0]?.status === "completed" && detail.transfers[0].toName === "Bob Handover");

/* --- dashboard ------------------------------------------------------------------------- */
console.log("\n[P2] dashboard");
const dash = (await admin.get("/dashboard")).data;
check("dashboard reports failed, reconnecting, transfers and files", ["failedToday", "reconnectingNow", "transfersToday", "filesToday"].every((k) => typeof dash[k] === "number")
  && dash.transfersToday >= 1 && dash.filesToday >= 1, JSON.stringify({ f: dash.failedToday, r: dash.reconnectingNow, t: dash.transfersToday, fi: dash.filesToday }));

/* --- technician management ----------------------------------------------------------- */
console.log("\n[P3] technician management");
check("people show live session count and the effective limit", users.every((u) => typeof u.liveSessions === "number" && typeof u.effectiveMaxSessions === "number"));
check("history filters by technician", (await admin.get(`/sessions?agentId=${users.find((u) => u.agentCode === "BOB-3").id}`)).data.items.some((s) => s.id === created.sessionId));

/* --- reports ------------------------------------------------------------------------- */
console.log("\n[P4] reports");
const req = await admin.post("/reports", { kind: "session_pdf", sessionId: created.sessionId });
let st = null;
for (let i = 0; i < 40 && st?.status !== "ready"; i++) { st = (await admin.get(`/reports/${req.data.id}`)).data; await sleep(150); }
const pdf = Buffer.from(await (await admin.raw("GET", `/reports/${req.data.id}/download`)).arrayBuffer());
const text = pdfContent(pdf).text;
check("the PDF has Actions, Scripts executed, Files transferred and Session transfers sections",
  ["Actions performed", "Scripts executed", "Files transferred", "Session transfers", "Connection"].every((h) => text.includes(h)));
check("…naming the saved script, the file and the handover", text.includes("IP configuration (saved v1)") && text.includes("driver-pack.zip") && text.includes("Bob Handover"));
check("…and never the file's contents or the script body", !text.includes("hello") && !text.includes("ipconfig /all"));
const csvReq = await admin.post("/reports", { kind: "summary_csv", filters: { q: "REPORT-PC" } });
let cst = null;
for (let i = 0; i < 40 && cst?.status !== "ready"; i++) { cst = (await admin.get(`/reports/${csvReq.data.id}`)).data; await sleep(150); }
const csv = (await (await admin.raw("GET", `/reports/${csvReq.data.id}/download`)).text()).replace(/^﻿/, "").split("\r\n");
check("CSV adds phase, files, scripts, transferred_from and both reconnect counts", csv[0].endsWith("phase,files_transferred,scripts_executed,transferred_from,technician_reconnects,customer_reconnects") && /,ENDED,1,1,/.test(csv[1]), csv[1]);

/* --- SuperAdmin ----------------------------------------------------------------------- */
console.log("\n[P5] SuperAdmin");
const otherAdminCookie = await ensureActiveUser(adminCookie, { objectId: "c3c3c3c3-0000-4000-8000-0000000000a2", name: "Ada Admin", roles: ["Admin"], agentCode: "ADA-2" }, "admin");
const people = () => admin.get("/users?status=active").then((r) => r.data.items);
let ada = (await people()).find((u) => u.agentCode === "ADA-2");
check("without a SuperAdmin, an Admin may still manage another Admin (unchanged)",
  (await admin.patch(`/users/${ada.id}`, { limits: { ...ada.limits, canExport: false } })).status === 200);
await ensureActiveUser(adminCookie, { objectId: "c3c3c3c3-0000-4000-8000-0000000000a1", name: "Sam Super", roles: ["SuperAdmin"], agentCode: "SAM-1" }, "admin");
const sam = client("admin", (await devLogin("admin", { objectId: "c3c3c3c3-0000-4000-8000-0000000000a1", name: "Sam Super", roles: ["SuperAdmin"] })).cookie);
ada = (await people()).find((u) => u.agentCode === "ADA-2");
const refused = await admin.patch(`/users/${ada.id}`, { limits: { ...ada.limits, canExport: true } });
check("once a SuperAdmin exists, an Admin cannot change another Admin", refused.status === 403 && refused.data.error === "superadmin_required");
check("…but still manages technicians", (await admin.patch(`/users/${users.find((u) => u.agentCode === "BOB-3").id}`, { limits: { ...users.find((u) => u.agentCode === "BOB-3").limits, canExport: false } })).status === 200);
check("a SuperAdmin can change an Admin", (await sam.patch(`/users/${ada.id}`, { limits: { ...ada.limits, canExport: true } })).status === 200);
const samMe = await sam.get("/me");
check("SuperAdmin sees the whole organisation and has admins.manage", samMe.data.permissions?.includes("admins.manage") && samMe.status === 200);
const samConsole = await devLogin("agent", { objectId: "c3c3c3c3-0000-4000-8000-0000000000a1", name: "Sam Super", roles: ["SuperAdmin"] });
check("a SuperAdmin may also use the technician console", samConsole.status === 200);
void otherAdminCookie;

/* --- observability -------------------------------------------------------------------- */
console.log("\n[P6] request ids, access log, metrics");
const r1 = await fetch(`${BASE}/api/agent/me`, { headers: { cookie: agentCookie } });
check("every API response carries an X-Request-Id", /^[0-9a-f-]{36}$/.test(r1.headers.get("x-request-id") ?? ""));
const r2 = await fetch(`${BASE}/api/agent/dashboard?q=secret-search-term`, { headers: { cookie: agentCookie, "x-request-id": "trace-abc-12345" } });
check("a well-formed incoming request id is echoed", r2.headers.get("x-request-id") === "trace-abc-12345");
const r3 = await fetch(`${BASE}/api/agent/me`, { headers: { cookie: agentCookie, "x-request-id": "bad id <script>" } });
check("a malformed one is replaced", r3.headers.get("x-request-id") !== "bad id <script>");
await sleep(200);
const logLine = readFileSync(SERVER_LOG, "utf8").split("\n").find((l) => l.includes('"request_id":"trace-abc-12345"'));
const parsed = logLine ? JSON.parse(logLine) : null;
check("the access log has a JSON line with the request id, path, status, ms and technician",
  parsed?.msg === "http" && parsed.path === "/api/agent/dashboard" && parsed.status === 200 && typeof parsed.ms === "number" && parsed.technician_id);
check("…and never the query string", !readFileSync(SERVER_LOG, "utf8").includes("secret-search-term"));
check("/metrics without the token is a 404", (await fetch(`${ADMIN_BASE}/metrics`)).status === 404);
check("/metrics with a wrong token is a 404", (await fetch(`${ADMIN_BASE}/metrics`, { headers: { authorization: "Bearer nope" } })).status === 404);
check("/metrics is not on the console listener", !(await (await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${METRICS}` } })).text()).includes("hda_sessions"));
const m = await fetch(`${ADMIN_BASE}/metrics`, { headers: { authorization: `Bearer ${METRICS}` } });
const body = await m.text();
check("with the token: Prometheus text with sessions, connections and counters",
  m.status === 200 && /# TYPE hda_sessions gauge/.test(body) && /hda_ws_connections\{kind="lobby"\} 1/.test(body)
  && /hda_sessions_created_total 1/.test(body) && /hda_session_transfers_total\{status="completed"\} 1/.test(body)
  && /hda_file_transfers_total\{direction="upload",status="completed"\} 1/.test(body), body.slice(0, 400));
check("metrics carry no names, devices or ids", !/REPORT-PC|Bob|rita|[0-9a-f]{8}-[0-9a-f]{4}-/.test(body));

report("api/35 platform admin & observability");
