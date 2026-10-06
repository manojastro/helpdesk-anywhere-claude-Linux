/**
 * Technician Platform 2.0, Phase 1 — invariants a behavioural test can miss.
 *
 *   1. Phase 1 changed nothing under windows/ (baseline: the checkpoint tag the
 *      2.0 work started from). Every console feature here is server/console only.
 *   2. The lifecycle phase changes in exactly one place (`setPhase` in
 *      signaling.ts, through `transition`/`resume` in lifecycle.ts). A second
 *      writer would bypass validation and the record.
 *   3. No client message can set a phase: no handler reads a phase from a message.
 *   4. Health and phase messages go to the technician only — never to the
 *      customer's applet.
 *   5. The dashboard API is pinned to the signed-in technician: its WHERE uses
 *      the principal, never a query-string user.
 *   6. The relay state machine the consent gate depends on is untouched by the
 *      lifecycle: `session.state` is still assigned only where it always was.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isApprovedDelta } from "../lib/approved-windows-deltas.mjs";
import { REPO, check, report } from "../lib/harness.mjs";

const BASE = "pre-technician-platform-v2-2026-10-06";
const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
const signaling = read("server/src/signaling.ts");
const sessionsTs = read("server/src/sessions.ts");
const agentApi = read("server/src/routes/agentApi.ts");
const dashboardJs = read("server/public/dashboard.js");

console.log("\n=== Platform 2.0 Phase 1 invariants ===\n");

let windowsDiff = "";
try {
  windowsDiff = execFileSync("git", ["-C", REPO, "diff", "--name-only", BASE, "--", "windows/"], { encoding: "utf8" })
    .split("\n").filter(Boolean).filter((f) => !isApprovedDelta(REPO, BASE, f)).join("\n");
} catch (e) {
  windowsDiff = `git failed: ${e.message}`;
}
check("Phase 1 changed nothing under windows/", windowsDiff.trim() === "", windowsDiff.trim());

const allServer = ["signaling.ts", "sessions.ts", "records.ts", "routes/agentApi.ts", "routes/adminApi.ts", "index.ts"]
  .map((f) => [f, read(`server/src/${f}`)]);
const phaseWriters = allServer.filter(([, src]) => /lifecycle\.phase\s*=[^=]|lifecycle\s*=\s*\{|\.phase\s*=\s*"[A-Z_]+"/.test(src)).map(([f]) => f);
check("nothing outside lifecycle.ts assigns a phase directly", phaseWriters.length === 0, phaseWriters.join(", "));
const transitionCalls = allServer.flatMap(([f, src]) => [...src.matchAll(/\btransition\(/g)].map(() => f));
check("transition() is called only from setPhase", transitionCalls.length === 1 && transitionCalls[0] === "signaling.ts" &&
  /function setPhase[^]*?const r = transition\(session\.lifecycle, to\)/.test(signaling), JSON.stringify(transitionCalls));
check("setPhase records every accepted change", /function setPhase[^]*?recordPhase\(session, r\.from, r\.to/.test(signaling));
check("setPhase refuses and audits an invalid change",
  /function setPhase[^]*?if \(!r\.ok\)[^]*?session\.invalid_transition[^]*?return false;/.test(signaling));

check("no handler reads a phase out of a client message", !/msg\.phase|msg\[["']phase["']\]/.test(signaling));
check("there is no agent.* or host.* message that names a phase", !/"(agent|host)\.phase"/.test(signaling + read("server/src/protocol.ts")));

const toHost = [...signaling.matchAll(/send\(([^,]*hostWs[^,]*),\s*\{\s*t:\s*"([^"]+)"/g)].map((m) => m[2]);
check("session.phase / session.health are never sent to the applet",
  !toHost.includes("session.phase") && !toHost.includes("session.health"), JSON.stringify(toHost));
check("session.health is sent on the technician socket", /send\(s\.agentWs, \{ t: "session\.health"/.test(signaling));

const dash = agentApi.slice(agentApi.indexOf('router.get("/dashboard"'), agentApi.indexOf("/** The session must be one this technician ran"));
check("dashboard: the WHERE is pinned to the signed-in technician",
  /const params: unknown\[\] = \[p\.orgId, p\.userId\]/.test(dash) && /"s\.org_id = \$1", "s\.agent_user_id = \$2"/.test(dash));
check("dashboard: no user/agent id is taken from the query string", !/req\.query\[["'](user|agent|agentId|userId|technician)/.test(dash));
check("dashboard: search text is LIKE-escaped", /likeEscape\(q\)/.test(dash));
check("dashboard: live counts are filtered to this technician",
  /liveSessions\(\)\.filter\(\(s\) => s\.orgId === p\.orgId && s\.agentUserId === p\.userId\)/.test(dash));

check("dashboard.js renders server strings as text, never markup", !/innerHTML/.test(dashboardJs));
check("dashboard.js never touches a session socket", !/\.send\(|WebSocket/.test(dashboardJs));

const stateAssignments = (signaling + sessionsTs).match(/\.state = "(waiting_for_host|waiting_for_consent|active|ended)"/g) ?? [];
check("relay state is still assigned in exactly the four places it always was",
  stateAssignments.length === 4 && /session\.state = "active";\s*\n\s*session\.consentedAt = Date\.now\(\);/.test(signaling),
  JSON.stringify(stateAssignments));

report("source/42 platform invariants");
