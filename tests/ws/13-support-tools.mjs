/**
 * Platform 2.0, Phase 2 (server half): the saved script library, provenance of
 * library runs at the relay, the technician's activity timeline, and the
 * screenshot record.
 *
 *   - built-ins listed to every technician; organisation scripts managed by
 *     Admin only (Supervisor/Auditor read, Agent has no admin access at all)
 *   - every save is a new version; archive hides without deleting
 *   - the relay records "ran <name> vN" ONLY for an exact text+shell+privilege
 *     match; anything else is an ordinary script with `libraryMismatch`, and is
 *     still subject to the same rules (allowScripts, hold, audit-before-run)
 *   - activity: own sessions only, readable titles, no lifecycle bookkeeping
 *   - screenshot: a record, never an image; own sessions only
 */
import { readFileSync, readdirSync } from "node:fs";

import { client, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { AUDIT_DIR, check, report, send, sleep, waitFor } from "../lib/harness.mjs";
import { active, settle } from "../lib/session.mjs";

const agentCookie = process.env.HDA_AGENT_COOKIE;
const adminCookie = process.env.HDA_ADMIN_COOKIE;
const agentApi = client("agent", agentCookie);
const adminApi = client("admin", adminCookie);
const auditLines = () => readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8").trim().split("\n")).filter(Boolean).map((l) => JSON.parse(l));

console.log("\n=== Platform 2.0 Phase 2 — script library, activity, screenshot ===\n");

/* --- A. the library as a technician sees it ---------------------------------------- */
console.log("[A] library");
let lib = await agentApi.get("/scripts");
check("GET /api/agent/scripts answers", lib.status === 200, String(lib.status));
const builtins = lib.data.items.filter((s) => s.builtin);
check("ten built-ins across the six categories", builtins.length === 10 &&
  new Set(builtins.map((s) => s.category)).size === 6, String(builtins.length));
check("each has id, version, name, description, shell, runAs and body",
  builtins.every((s) => s.id.startsWith("builtin:") && s.version === 1 && s.name && s.description && ["powershell", "cmd"].includes(s.shell) && ["user", "system"].includes(s.runAs) && s.body.length > 0));
check("the technician is told whether they may run scripts", lib.data.canRun === true);

/* --- B. management: admin only, versioned ------------------------------------------- */
console.log("\n[B] management");
const supCookie = await ensureActiveUser(adminCookie, { objectId: "abababab-0000-4000-8000-0000000000b1", name: "Sue Supervisor", roles: ["Supervisor"], agentCode: "SUP-1" }, "admin");
const audCookie = await ensureActiveUser(adminCookie, { objectId: "abababab-0000-4000-8000-0000000000b2", name: "Al Auditor", roles: ["Auditor"], agentCode: "AUD-2" }, "admin");
const sup = client("admin", supCookie);
const aud = client("admin", audCookie);
const NEW = { name: "Show hostname", description: "Prints the computer name.", category: "System Information", shell: "cmd", runAs: "user", body: "echo body-sentinel-7781" };

check("Auditor can read the library", (await aud.get("/scripts")).status === 200);
check("Supervisor can read the library", (await sup.get("/scripts")).status === 200);
check("Supervisor cannot create a script", (await sup.post("/scripts", NEW)).status === 403);
check("Auditor cannot create a script", (await aud.post("/scripts", NEW)).status === 403);
const agentAdmin = await fetch(`${process.env.ADMIN_BASE}/api/admin/scripts`, { headers: { cookie: agentCookie } });
check("a technician's console cookie gets nothing from the admin API", agentAdmin.status === 401 || agentAdmin.status === 403, String(agentAdmin.status));

for (const [field, bad] of [["name", { ...NEW, name: "" }], ["category", { ...NEW, category: "Mining" }], ["shell", { ...NEW, shell: "bash" }],
  ["runAs", { ...NEW, runAs: "root" }], ["body", { ...NEW, body: "   " }], ["body", { ...NEW, body: "x".repeat(20001) }]]) {
  const r = await adminApi.post("/scripts", bad);
  check(`invalid ${field} is refused`, r.status === 400 && r.data?.field === field, JSON.stringify(r.data));
}

const created = await adminApi.post("/scripts", NEW);
check("Admin creates a script (v1)", created.status === 201 && created.data.version === 1, JSON.stringify(created.data));
const sid = created.data.id;
const v2 = await adminApi.raw("PUT", `/api/admin/scripts/${sid}`, { ...NEW, body: "echo body-sentinel-7781\r\nver" });
check("saving again makes v2 (CRLF normalised)", v2.status === 200 && (await v2.json()).version === 2);
const versions = await adminApi.get(`/scripts/${sid}/versions`);
check("both versions are kept, each with its SHA-256", versions.data.items.length === 2 && versions.data.items[0].body === "echo body-sentinel-7781\nver" &&
  versions.data.items.every((v) => /^[0-9a-f]{64}$/.test(v.sha256)));
lib = await agentApi.get("/scripts");
const mine = lib.data.items.find((s) => s.id === sid);
check("technicians see only the current version", mine?.version === 2 && lib.data.items.filter((s) => s.id === sid).length === 1);

const trail = await sql("SELECT action, detail FROM audit_log WHERE target_id = $1 ORDER BY at", [sid]);
check("create and update are in the admin audit trail", trail.map((t) => t.action).join(",") === "script.created,script.updated");
check("…with name, version and SHA-256, never the body", trail.every((t) => t.detail.sha256 && !JSON.stringify(t.detail).includes("body-sentinel")));

/* --- C. provenance at the relay ------------------------------------------------------------ */
console.log("\n[C] library runs at the relay");
const s1 = await active(agentCookie, { machine: "LIB-PC", label: "lib" });
const runs = [];
async function run(script, shell, asSystem, libraryRef) {
  const id = `r${runs.length}`;
  s1.host.received.length = 0;
  send(s1.agent, { t: "agent.exec", id, shell, script, asSystem, ...(libraryRef ? { libraryRef } : {}) });
  const got = await waitFor(s1.host, (m) => m.t === "agent.exec" && m.id === id, 3000);
  runs.push(id);
  return got;
}
const builtin = builtins.find((s) => s.id === "builtin:disk-space");
const forwarded = await run(builtin.body, builtin.shell, false, { id: builtin.id, version: 1 });
check("a library script reaches the applet unchanged (text, shell, privilege)",
  forwarded?.script === builtin.body && forwarded.shell === "powershell" && forwarded.asSystem === false);
await run(mine.body, "cmd", false, { id: sid, version: 2 });
await run(`${builtin.body}\n# edited`, "powershell", false, { id: builtin.id, version: 1 });
await run(builtin.body, "cmd", false, { id: builtin.id, version: 1 });
await run(builtin.body, "powershell", true, { id: builtin.id, version: 1 });
await run("hostname", "cmd", false, { id: "builtin:nope", version: 1 });
const adhoc = await run("whoami", "cmd", false);
check("an ad-hoc script still runs exactly as before", adhoc?.script === "whoami");
await settle(500);

const ev = await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'script.requested' ORDER BY seq", [s1.sessionId]);
const d = ev.map((e) => e.detail);
check("exact match → recorded as the saved script (built-in)", d[0]?.libraryId === "builtin:disk-space" && d[0].libraryName === "Disk space" && d[0].libraryVersion === 1, JSON.stringify(d[0]));
check("exact match → recorded as the saved script (organisation, v2)", d[1]?.libraryId === sid && d[1].libraryVersion === 2 && d[1].libraryName === "Show hostname");
check("edited text → libraryMismatch text_differs, not the library name", d[2]?.libraryMismatch === "text_differs" && !d[2].libraryName);
check("wrong shell → shell_differs", d[3]?.libraryMismatch === "shell_differs");
check("wrong privilege → privilege_differs", d[4]?.libraryMismatch === "privilege_differs");
check("unknown id → unknown", d[5]?.libraryMismatch === "unknown");
check("ad-hoc script has no library fields", d[6] && !("libraryMismatch" in d[6]) && !("libraryId" in d[6]));
check("the script hash is still recorded for every run", d.every((x) => /^[0-9a-f]{64}$/.test(x.scriptSha256)));
const jl = auditLines().filter((l) => l.event === "exec.requested" && l.session === s1.sessionId);
check("the security log has the full text AND the library provenance", jl[0]?.script === builtin.body && jl[0].libraryName === "Disk space" && jl[2]?.libraryMismatch === "text_differs");

await adminApi.post(`/scripts/${sid}/archive`, {});
lib = await agentApi.get("/scripts");
check("archived scripts disappear from the technician's list", !lib.data.items.some((s) => s.id === sid));
check("…and an archived script cannot be edited", (await adminApi.raw("PUT", `/api/admin/scripts/${sid}`, NEW)).status === 409);
await run(mine.body, "cmd", false, { id: sid, version: 2 });
await settle(400);
const ev2 = await sql("SELECT detail FROM session_events WHERE session_id = $1 AND type = 'script.requested' ORDER BY seq DESC LIMIT 1", [s1.sessionId]);
check("running an archived script is not recorded as the library script", ev2[0]?.detail.libraryMismatch === "archived");

// The library grants nothing: a technician without allowScripts is refused as before.
const noScriptsCookie = await ensureActiveUser(adminCookie, { objectId: "abababab-0000-4000-8000-0000000000b3", name: "No Scripts", roles: ["Agent"], agentCode: "NS-1" });
const users = await adminApi.get("/users");
const nsUser = users.data.items.find((u) => u.agentCode === "NS-1");
await adminApi.patch(`/users/${nsUser.id}`, { limits: { ...nsUser.limits, allowScripts: false } });
const s2 = await active(noScriptsCookie, { machine: "NS-PC", label: "ns" });
s2.host.received.length = 0;
send(s2.agent, { t: "agent.exec", id: "z", shell: builtin.shell, script: builtin.body, asSystem: false, libraryRef: { id: builtin.id, version: 1 } });
const refused = await waitFor(s2.agent, (m) => m.t === "error", 2000);
await sleep(200);
check("a saved script is refused for a technician without the script permission", refused?.code === "not_permitted" && !s2.host.received.some((m) => m.t === "agent.exec"));

/* --- D. activity ---------------------------------------------------------------------------- */
console.log("\n[D] activity timeline");
const act = await agentApi.get(`/sessions/${s1.sessionId}/events`);
check("GET /sessions/:id/events answers for my own session", act.status === 200 && act.data.items.length > 0);
const types = act.data.items.map((e) => e.type);
check("it shows the real timeline (created, joined, consent, scripts)", ["session.created", "customer.joined", "consent.accepted", "script.requested"].every((t) => types.includes(t)));
check("lifecycle bookkeeping is left out", !types.includes("session.phase"));
check("rows carry readable titles and safe detail only", act.data.items.every((e) => typeof e.title === "string" && e.title.length > 0) &&
  act.data.items.find((e) => e.type === "script.requested")?.detail.libraryName === "Disk space" &&
  !JSON.stringify(act.data).includes(builtin.body));
const otherCookie = await ensureActiveUser(adminCookie, { objectId: "abababab-0000-4000-8000-0000000000b4", name: "Other Tech", roles: ["Agent"], agentCode: "OT-1" });
check("another technician gets 404 for my session's activity", (await client("agent", otherCookie).get(`/sessions/${s1.sessionId}/events`)).status === 404);
check("a malformed id is a 404, not an error", (await agentApi.get("/sessions/not-a-uuid/events")).status === 404);

/* --- E. screenshot record ------------------------------------------------------------------- */
console.log("\n[E] screenshot record");
const shot = await agentApi.post(`/sessions/${s1.sessionId}/screenshot`, {});
check("POST /sessions/:id/screenshot records it", shot.status === 200);
await settle(300);
const shotEv = await sql("SELECT actor_role, detail FROM session_events WHERE session_id = $1 AND type = 'screenshot.taken'", [s1.sessionId]);
check("…as a timeline event by the technician, with no image data", shotEv.length === 1 && shotEv[0].actor_role === "agent" && JSON.stringify(shotEv[0].detail) === "{}");
check("…and in the security log", auditLines().some((l) => l.event === "screenshot.taken" && l.session === s1.sessionId));
check("another technician cannot record one on my session", (await client("agent", otherCookie).post(`/sessions/${s1.sessionId}/screenshot`, {})).status === 404);
const big = await agentApi.raw("POST", `/api/agent/sessions/${s1.sessionId}/screenshot`, { image: "x".repeat(200_000) });
check("the endpoint takes no image (a large body is rejected)", big.status === 413 || big.status === 400, String(big.status));
const nothingStored = await sql("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND (column_name ILIKE '%screenshot%' OR column_name ILIKE '%image%')");
check("no table anywhere has a column for screenshot images", nothingStored[0].n === 0);

send(s1.agent, { t: "agent.end" });
send(s2.agent, { t: "agent.end" });
await settle();
report("ws/13 support tools");
