/**
 * Identity, access workflow and authorisation boundaries (admin-portal release).
 *
 *   - first-admin bootstrap only for the configured object ID + Admin role
 *   - Entra role required; no-role identities are recorded and shown, not admitted
 *   - one configured tenant only
 *   - pending → activate (agent ID, team) → sign in
 *   - two applications: an Agent cannot use the admin portal; cookies and APIs
 *     do not cross between the portals
 *   - CSRF and Origin on state changes
 *   - role scoping: Auditor read-only; Supervisor sees its team only
 *   - per-user limits enforced on the WebSocket (scripts, elevation, concurrency)
 *   - suspension revokes sign-in AND live sockets at once
 *   - tenant scoping of every read
 */
import { randomUUID } from "node:crypto";

import { ADMIN_BASE, BASE, IDS, client, devLogin, ensureActiveUser } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { check, report, send, sleep, waitFor, open, WebSocket } from "../lib/harness.mjs";
import { active, create, settle } from "../lib/session.mjs";

const adminCookie = process.env.HDA_ADMIN_COOKIE;
const admin = client("admin", adminCookie);

console.log("\n=== Access workflow and authorisation boundaries ===\n");

/* ------------------------------------------------------------ bootstrap */
console.log("[A] First-admin bootstrap");
const me = await admin.get("/me");
check("the configured object ID + Admin role was bootstrapped to an active admin",
  me.status === 200 && me.data.user.roles.includes("Admin") && me.data.permissions.includes("users.manage"));
const second = await devLogin("admin", { objectId: "cccccccc-0000-4000-8000-00000000ad02", name: "Second Admin", roles: ["Admin"] });
check("another Admin-role identity NOT in BOOTSTRAP_ADMIN_OIDS stays pending", second.status === 403 && second.body.error === "pending",
  JSON.stringify(second.body));
const bootAudit = await sql("SELECT count(*)::int AS n FROM audit_log WHERE action = 'access.bootstrap_admin'");
check("the bootstrap is in the audit trail exactly once", bootAudit[0].n === 1);

/* ------------------------------------------------------- Entra role required */
console.log("\n[B] An Entra role is required");
const noRole = await devLogin("agent", { objectId: "dddddddd-0000-4000-8000-000000000001", name: "No Role", roles: [] });
check("sign-in without an app role is refused entra_role_required", noRole.status === 403 && noRole.body.error === "entra_role_required");
const unknownRole = await devLogin("agent", { objectId: "dddddddd-0000-4000-8000-000000000002", name: "Made Up", roles: ["SuperUser", "admin"] });
check("role names this app does not define do not count", unknownRole.body.error === "entra_role_required");
const listed = (await admin.get("/users?status=pending")).data.items;
const noRoleUser = listed.find((u) => u.displayName === "No Role");
check("…but the identity is recorded so an admin can see the request", !!noRoleUser);
check("…flagged as needing assignment in the Entra admin center", noRoleUser?.entraAssignment === "required");
const cantActivate = await admin.post(`/users/${noRoleUser?.id}/activate`, { agentCode: "NR-1" });
check("…and the portal refuses to activate it (it cannot grant Entra roles)", cantActivate.status === 409 && cantActivate.data.error === "entra_role_required");

console.log("\n[C] One configured tenant");
const foreign = await devLogin("agent", { objectId: "eeeeeeee-0000-4000-8000-000000000001", name: "Other Tenant", roles: ["Agent"], tenantId: "99999999-9999-4999-8999-999999999999" });
check("an identity from another tenant is refused", foreign.status === 403 && foreign.body.error === "wrong_tenant");
const foreignRows = await sql("SELECT count(*)::int AS n FROM users WHERE entra_object_id = 'eeeeeeee-0000-4000-8000-000000000001'");
check("…and no user row is created for it", foreignRows[0].n === 0);

/* ------------------------------------------------------ pending → activation */
console.log("\n[D] Pending → activation");
const bobOid = "bbbbbbbb-0000-4000-8000-0000000000b0";
const bobPending = await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] });
check("a new Entra-assigned technician is refused as pending", bobPending.status === 403 && bobPending.body.error === "pending");
check("…and gets no cookie", bobPending.cookie === "");
const bobId = bobPending.body.userId;

const noCsrf = await admin.post(`/users/${bobId}/activate`, { agentCode: "AG-100" }, { noCsrf: true });
check("activation without the CSRF token is refused", noCsrf.status === 403 && noCsrf.data.error === "csrf");
const badOrigin = await admin.post(`/users/${bobId}/activate`, { agentCode: "AG-100" }, { headers: { Origin: "https://evil.example" } });
check("activation from a foreign Origin is refused", badOrigin.status === 403 && badOrigin.data.error === "bad_origin");
const badCode = await admin.post(`/users/${bobId}/activate`, { agentCode: "no spaces allowed" });
check("an invalid agent ID is refused", badCode.status === 400);

const teamA = (await admin.post("/teams", { name: "Team A" })).data;
const teamB = (await admin.post("/teams", { name: "Team B" })).data;
check("admins can create teams", !!teamA?.id && !!teamB?.id);
const act = await admin.post(`/users/${bobId}/activate`, { agentCode: "AG-100", teamId: teamA.id });
check("an admin activates with agent ID and team", act.status === 200 && act.data.user.status === "active" && act.data.user.agentCode === "AG-100");
const dupe = await devLogin("agent", { objectId: "bbbbbbbb-0000-4000-8000-0000000000b1", name: "Dup", roles: ["Agent"] });
const dupAct = await admin.post(`/users/${dupe.body.userId}/activate`, { agentCode: "AG-100" });
check("an agent ID cannot be given to two people", dupAct.status === 409 && dupAct.data.error === "agent_code_taken");
const activation = await sql("SELECT actor_user_id, detail FROM audit_log WHERE action = 'access.activated' AND target_id = $1", [bobId]);
check("the activation is audited with who granted it", activation.length === 1 && activation[0].actor_user_id === me.data.user.id);

const bob = await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] });
check("once active, the technician signs in to the console", bob.status === 200 && bob.cookie.startsWith("hda_agent="));
const bobApi = client("agent", bob.cookie);
const bobMe = await bobApi.get("/me");
check("…and the console sees the verified identity, agent ID and team", bobMe.data?.user.displayName === "Bob Tech"
  && bobMe.data.user.agentCode === "AG-100" && bobMe.data.user.team === "Team A");

/* --------------------------------------------------------- two applications */
console.log("\n[E] Two applications: no crossing between the portals");
const bobOnAdmin = await devLogin("admin", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] });
check("an Agent-only identity cannot sign in to the admin portal", bobOnAdmin.status === 403 && bobOnAdmin.body.error === "portal_not_permitted");
const bobCookieOnAdmin = await fetch(`${ADMIN_BASE}/api/admin/me`, { headers: { cookie: bob.cookie } });
check("the console cookie is not accepted by the admin portal", bobCookieOnAdmin.status === 401);
const bobCookieAdminPage = await fetch(`${ADMIN_BASE}/`, { headers: { cookie: bob.cookie }, redirect: "manual" });
check("…whose pages send it to the admin sign-in instead", bobCookieAdminPage.status === 302);
const renamed = bob.cookie.replace(/^hda_agent=/, "hda_admin=");
const replay = await fetch(`${ADMIN_BASE}/api/admin/me`, { headers: { cookie: renamed } });
check("…even when the console session token is replayed under the admin cookie name", replay.status === 401);
const adminOnAgent = await fetch(`${BASE}/api/agent/me`, { headers: { cookie: adminCookie } });
check("the admin cookie is not accepted by the console API", adminOnAgent.status === 401);
check("the admin API does not exist on the console application", (await fetch(`${BASE}/api/admin/me`, { headers: { cookie: adminCookie } })).status === 404);
check("the console API does not exist on the admin application", (await fetch(`${ADMIN_BASE}/api/agent/me`, { headers: { cookie: bob.cookie } })).status === 404);
const adminWs = await new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(ADMIN_BASE).port}/ws`, { headers: { cookie: adminCookie } });
  ws.once("open", () => { ws.close(); res("open"); });
  ws.once("unexpected-response", (_q, r) => res(`http ${r.statusCode}`));
  ws.once("error", (e) => res(`error ${e.message}`));
});
check("the admin application has no relay WebSocket", adminWs !== "open", adminWs);

/* ------------------------------------------------------------------- roles */
console.log("\n[F] Auditor is read-only");
const audCookie = await ensureActiveUser(adminCookie, { objectId: "ffffffff-0000-4000-8000-0000000000a1", name: "Ann Auditor", roles: ["Auditor"], agentCode: "AUD-1" }, "admin");
const aud = client("admin", audCookie);
check("an Auditor can read people and the audit trail", (await aud.get("/users")).status === 200 && (await aud.get("/audit")).status === 200);
check("…but cannot change access", (await aud.post(`/users/${bobId}/suspend`, { reason: "x" })).status === 403);
check("…or create teams", (await aud.post("/teams", { name: "Nope" })).status === 403);
const audConsole = await devLogin("agent", { objectId: "ffffffff-0000-4000-8000-0000000000a1", name: "Ann Auditor", roles: ["Auditor"] });
check("…and cannot use the technician console", audConsole.body.error === "portal_not_permitted");

console.log("\n[G] Supervisor sees its own team only");
const supCookie = await ensureActiveUser(adminCookie, { objectId: "99990000-0000-4000-8000-0000000000c1", name: "Sue Supervisor", roles: ["Supervisor"], agentCode: "SUP-1", teamId: teamA.id }, "admin");
const sup = client("admin", supCookie);
const carolCookie = await ensureActiveUser(adminCookie, { objectId: "99990000-0000-4000-8000-0000000000c2", name: "Carol TeamB", roles: ["Agent"], agentCode: "AG-200", teamId: teamB.id });

const sA = await active(bob.cookie, { machine: "PC-TEAM-A", label: "A" });
send(sA.agent, { t: "agent.chat", kind: "text", text: "team A private chat", clientId: "a1" });
await waitFor(sA.host, (m) => m.t === "chat.message");
send(sA.agent, { t: "agent.end" });
const sB = await active(carolCookie, { machine: "PC-TEAM-B", label: "B" });
send(sB.agent, { t: "agent.chat", kind: "text", text: "team B private chat", clientId: "b1" });
await waitFor(sB.host, (m) => m.t === "chat.message");
send(sB.agent, { t: "agent.end" });
await settle();

const supList = (await sup.get("/sessions?pageSize=100")).data.items.map((s) => s.id);
check("the supervisor's history includes its team's session", supList.includes(sA.sessionId));
check("…and excludes the other team's", !supList.includes(sB.sessionId));
check("the other team's session detail is a 404", (await sup.get(`/sessions/${sB.sessionId}`)).status === 404);
check("…and so is its transcript", (await sup.get(`/sessions/${sB.sessionId}/transcript`)).status === 404);
check("…and its notes", (await sup.get(`/sessions/${sB.sessionId}/notes`)).status === 404);
const supPdf = await sup.post("/reports", { kind: "session_pdf", sessionId: sB.sessionId });
check("…and a report on it is refused", supPdf.status === 404);
const supUsers = (await sup.get("/users")).data.items.map((u) => u.displayName);
check("the supervisor sees its team's people only", supUsers.includes("Bob Tech") && !supUsers.includes("Carol TeamB"));
check("…and cannot manage access", (await sup.post(`/users/${bobId}/suspend`, {})).status === 403);
const adminList = (await admin.get("/sessions?pageSize=100")).data.items.map((s) => s.id);
check("an admin sees both teams", adminList.includes(sA.sessionId) && adminList.includes(sB.sessionId));

const carolApi = client("agent", carolCookie);
check("a technician cannot read another technician's notes", (await carolApi.get(`/sessions/${sA.sessionId}/notes`)).status === 404);
check("…or write them", (await carolApi.post(`/sessions/${sA.sessionId}/notes`, { body: "hijack" })).status === 404);

/* ------------------------------------------------------------------ limits */
console.log("\n[H] Per-user limits are enforced by the relay, not the UI");
await admin.patch(`/users/${bobId}`, { limits: { allowScripts: false, allowElevation: false, maxConcurrentSessions: 1 } });
const bobCookie2 = (await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] })).cookie;
const lim = await active(bobCookie2, { label: "lim" });
send(lim.agent, { t: "agent.exec", id: "blocked-1", shell: "powershell", script: "whoami", asSystem: false });
const execErr = await waitFor(lim.agent, (m) => m.t === "error" && m.code === "not_permitted");
check("a script from an account without script permission is refused", !!execErr);
await sleep(200);
check("…and never reaches the customer's machine", !lim.host.received.some((m) => m.t === "agent.exec"));
send(lim.agent, { t: "agent.requestElevation", mode: "interactive" });
check("elevation is refused the same way", !!(await waitFor(lim.agent, (m) => m.t === "error" && m.code === "not_permitted" && m !== execErr)));
check("…and never forwarded", !lim.host.received.some((m) => m.t === "agent.requestElevation"));
const extra = await create(bobCookie2, "extra");
check("a second concurrent session beyond the limit is refused", extra.error?.code === "session_limit", JSON.stringify(extra.error));
extra.agent.close();
await settle();
const refusedEv = await sql("SELECT type FROM session_events WHERE session_id = $1 AND type IN ('script.refused','elevation.refused')", [lim.sessionId]);
check("refusals are on the session timeline", refusedEv.length === 2);

/* ---------------------------------------------------------------- suspension */
console.log("\n[I] Suspension takes effect immediately");
check("an admin cannot suspend themself", (await admin.post(`/users/${me.data.user.id}/suspend`, {})).data.error === "cannot_suspend_self");
const susp = await admin.post(`/users/${bobId}/suspend`, { reason: "left the company" });
check("an admin suspends a technician", susp.status === 200 && susp.data.user.status === "suspended");
const revoked = await waitFor(lim.agent, (m) => m.t === "error" && m.code === "access_revoked", 3000);
check("the technician's live socket is told access was revoked", !!revoked);
await sleep(300);
check("…and closed", lim.agent.readyState === WebSocket.CLOSED);
check("…and the customer's session ends too", lim.host.readyState === WebSocket.CLOSED);
await settle();
const endRow = await sql("SELECT status, end_reason FROM sessions WHERE id = $1", [lim.sessionId]);
check("the record says why it ended", endRow[0]?.status === "ended" && endRow[0]?.end_reason === "agent_access_revoked", JSON.stringify(endRow[0]));
check("the existing console cookie stops working at once", (await fetch(`${BASE}/api/agent/me`, { headers: { cookie: bobCookie2 } })).status === 401);
const bobAgain = await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] });
check("signing in again is refused as suspended", bobAgain.body.error === "suspended");
const suspAudit = await sql("SELECT actor_user_id, detail FROM audit_log WHERE action = 'access.suspended' AND target_id = $1", [bobId]);
check("the suspension is audited with who and why", suspAudit.length === 1 && suspAudit[0].detail.reason === "left the company");
const re = await admin.post(`/users/${bobId}/reactivate`, {});
check("reactivation restores sign-in", re.status === 200 && (await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: ["Agent"] })).status === 200);
const lostRole = await devLogin("agent", { objectId: bobOid, name: "Bob Tech", roles: [] });
check("removing the Entra role blocks the next sign-in even for an active user", lostRole.body.error === "entra_role_required");

/* ------------------------------------------------------------ tenant scoping */
console.log("\n[J] Records of another organisation are invisible");
const otherOrg = randomUUID(), otherUser = randomUUID(), otherSession = randomUUID();
await sql("INSERT INTO organizations (id, entra_tenant_id, name) VALUES ($1, $2, 'Other Org')", [otherOrg, `tenant-${otherOrg}`]);
await sql(`INSERT INTO users (id, org_id, entra_tenant_id, entra_object_id, display_name, status, entra_roles)
           VALUES ($1, $2, $3, 'other-oid', 'Other Tech', 'active', '{Agent}')`, [otherUser, otherOrg, `tenant-${otherOrg}`]);
await sql(`INSERT INTO sessions (id, org_id, agent_user_id, agent_display_name, status, customer_machine)
           VALUES ($1, $2, $3, 'Other Tech', 'ended', 'OTHER-ORG-PC')`, [otherSession, otherOrg, otherUser]);
await sql(`INSERT INTO audit_log (org_id, action, actor_label) VALUES ($1, 'auth.login', 'Other Tech')`, [otherOrg]);
const all = (await admin.get("/sessions?pageSize=100")).data.items;
check("another organisation's session is not listed, even for an Admin", !all.some((s) => s.id === otherSession));
check("…not searchable by its device", (await admin.get("/sessions?device=OTHER-ORG")).data.total === 0);
check("…not readable by id", (await admin.get(`/sessions/${otherSession}`)).status === 404);
check("…not reportable", (await admin.post("/reports", { kind: "session_pdf", sessionId: otherSession })).status === 404);
check("its people are not listed", !(await admin.get("/users")).data.items.some((u) => u.id === otherUser));
check("its audit rows are not shown", !(await admin.get("/audit?pageSize=200")).data.items.some((a) => a.actor_label === "Other Tech"));
check("its user cannot be managed", (await admin.post(`/users/${otherUser}/suspend`, {})).status === 404);

/* ------------------------------------------------------------ open redirect */
console.log("\n[L] returnTo cannot leave the site");
for (const evil of ["//evil.example", "/\\evil.example", "/%5Cevil.example", "https://evil.example", "/\t/evil.example"]) {
  const r = await fetch(`${BASE}/auth/login?returnTo=${encodeURIComponent(evil)}`, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  const back = new URL(loc, BASE).searchParams.get("returnTo");
  check(`returnTo=${JSON.stringify(evil)} is replaced with "/"`, back === "/", loc);
}
const good = new URL((await fetch(`${BASE}/auth/login?returnTo=%2Fportal.html`, { redirect: "manual" })).headers.get("location") ?? "", BASE);
check("…while a plain same-site path is kept", good.searchParams.get("returnTo") === "/portal.html");
{
  const { launch } = await import("../lib/browser.mjs");
  const b = await launch();
  const pg = await b.newPage();
  await pg.goto(`${BASE}/login?returnTo=${encodeURIComponent("/\\evil.example")}`, { waitUntil: "networkidle0" });
  const followed = await pg.evaluate(async () => {
    // Drive the dev form the way a victim would, then see where it navigates.
    document.getElementById("dev-oid").value = "bbbbbbbb-0000-4000-8000-00000000a901";
    document.getElementById("dev-name").value = "Suite Technician";
    document.querySelector("#dev-form button[type=submit]").click();
    await new Promise((r) => setTimeout(r, 800));
    return location.host;
  }).catch(() => null);
  const host = followed ?? new URL(pg.url()).host;
  check("the login page does not follow a backslash returnTo off-site", host === new URL(BASE).host, String(host));
  await b.close();
}

/* ----------------------------------------------------------------- sign-out */
console.log("\n[K] Sign-out");
const tmp = await devLogin("admin", { objectId: IDS.admin, name: "Suite Admin", roles: ["Admin"] });
const tmpApi = client("admin", tmp.cookie);
check("sign-out without CSRF is refused", (await tmpApi.post("/auth/logout", {}, { noCsrf: true })).status === 403);
const out = await tmpApi.raw("POST", "/auth/logout", {});
check("sign-out with CSRF succeeds", out.status === 204);
check("…and the session is gone server-side", (await fetch(`${ADMIN_BASE}/api/admin/me`, { headers: { cookie: tmp.cookie } })).status === 401);

report("access and authorisation");
