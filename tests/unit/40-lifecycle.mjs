/**
 * Session lifecycle state machine (Platform 2.0, `server/src/lifecycle.ts`) —
 * pure unit tests against the compiled module, no server.
 */
import { REPO, check, report } from "../lib/harness.mjs";

const lc = await import(`${REPO}/server/dist/lifecycle.js`);
const { PHASES, TRANSITIONS, TERMINAL_PHASES, newLifecycle, transition, resume, isAllowed, terminalPhaseFor } = lc;

console.log("\n=== Session lifecycle — table, validation, reconnect ===\n");

/* --- the table itself ---------------------------------------------------------- */
console.log("[L1] table");
check("every phase has a row", PHASES.every((p) => Array.isArray(TRANSITIONS[p])));
check("every target is a known phase", PHASES.every((p) => TRANSITIONS[p].every((t) => PHASES.includes(t))));
check("terminal phases have no exits", [...TERMINAL_PHASES].every((p) => TRANSITIONS[p].length === 0));
check("no phase lists itself", PHASES.every((p) => !TRANSITIONS[p].includes(p)));
check("every non-terminal phase can end", PHASES.filter((p) => !TERMINAL_PHASES.has(p)).every((p) => isAllowed(p, "ENDED")));

/** Phases reachable from CREATED via the table. */
const reach = new Set(["CREATED"]);
for (let changed = true; changed;) {
  changed = false;
  for (const p of [...reach]) for (const t of TRANSITIONS[p]) if (!reach.has(t)) { reach.add(t); changed = true; }
}
check("every phase is reachable from CREATED", PHASES.every((p) => reach.has(p)), [...reach].join(","));

/* --- the happy path --------------------------------------------------------------- */
console.log("\n[L2] happy path");
const a = newLifecycle(1000);
check("a new session is CREATED", a.phase === "CREATED" && a.phaseSince === 1000);
const path = ["WAITING", "CONSENT_PENDING", "CONNECTED", "CONTROLLING", "ON_HOLD", "CONNECTED", "CONTROLLING", "ENDED"];
let t = 1000;
const results = path.map((to) => transition(a, to, ++t));
check("CREATED→WAITING→CONSENT_PENDING→CONNECTED→CONTROLLING→ON_HOLD→CONNECTED→CONTROLLING→ENDED all valid",
  results.every((r) => r.ok && !r.deferred), JSON.stringify(results.filter((r) => !r.ok)));
check("each change stamps its time", a.phaseSince === t);
check("ENDED is final", !transition(a, "CONNECTED").ok && !transition(a, "WAITING").ok && a.phase === "ENDED");

/* --- invalid transitions are refused, phase unchanged ------------------------------ */
console.log("\n[L3] invalid transitions");
const invalid = [
  ["CREATED", "CONNECTED"], ["WAITING", "CONNECTED"], ["WAITING", "CONTROLLING"], ["CONSENT_PENDING", "CONTROLLING"],
  ["CONSENT_PENDING", "ON_HOLD"], ["CONNECTED", "DECLINED"], ["CONNECTED", "EXPIRED"], ["ON_HOLD", "CONTROLLING"],
  ["CONTROLLING", "WAITING"], ["CONNECTED", "CONSENT_PENDING"],
];
for (const [from, to] of invalid) {
  const x = { phase: from, phaseSince: 5, resumePhase: null };
  const r = transition(x, to, 9);
  check(`${from} → ${to} refused and nothing changes`, !r.ok && r.reason === "invalid" && x.phase === from && x.phaseSince === 5);
}
const same = { phase: "CONNECTED", phaseSince: 5, resumePhase: null };
const sr = transition(same, "CONNECTED", 9);
check("a transition to the current phase is a no-op, not an error", !sr.ok && sr.reason === "same" && same.phaseSince === 5);

/* --- reconnecting --------------------------------------------------------------------- */
console.log("\n[L4] technician reconnect");
const b = { phase: "CONTROLLING", phaseSince: 1, resumePhase: null };
check("CONTROLLING → RECONNECTING", transition(b, "RECONNECTING", 2).ok && b.phase === "RECONNECTING");
check("…remembers CONNECTED (not CONTROLLING) to return to", b.resumePhase === "CONNECTED");
const back = resume(b, 3);
check("resume returns to CONNECTED", back.ok && b.phase === "CONNECTED" && b.resumePhase === null && b.phaseSince === 3);

const c = { phase: "CONSENT_PENDING", phaseSince: 1, resumePhase: null };
transition(c, "RECONNECTING", 2);
const consentWhileAway = transition(c, "CONNECTED", 3);
check("customer consenting while the technician is away is deferred", consentWhileAway.ok && consentWhileAway.deferred);
check("…the visible phase stays RECONNECTING, the remembered one moves", c.phase === "RECONNECTING" && c.resumePhase === "CONNECTED");
check("…and its time is the reconnect's, not the deferred change's", c.phaseSince === 2);
check("a deferred change is validated too (CONNECTED → CONSENT_PENDING refused)",
  !transition(c, "CONSENT_PENDING", 4).ok && c.resumePhase === "CONNECTED");
check("CONTROLLING cannot happen while no technician is attached", !transition(c, "CONTROLLING", 4).ok);
check("resume lands on the deferred phase", resume(c, 5).ok && c.phase === "CONNECTED");

const d = { phase: "ON_HOLD", phaseSince: 1, resumePhase: null };
transition(d, "RECONNECTING", 2);
check("a held session resumes still ON_HOLD", resume(d, 3).ok && d.phase === "ON_HOLD");

const e = { phase: "WAITING", phaseSince: 1, resumePhase: null };
transition(e, "RECONNECTING", 2);
check("a code can expire while the technician is reconnecting", transition(e, "EXPIRED", 3).ok && e.phase === "EXPIRED");
const f = { phase: "CONSENT_PENDING", phaseSince: 1, resumePhase: null };
transition(f, "RECONNECTING", 2);
check("the customer can decline while the technician is reconnecting", transition(f, "DECLINED", 3).ok && f.phase === "DECLINED");
check("resume() outside RECONNECTING does nothing", !resume({ phase: "CONNECTED", phaseSince: 1, resumePhase: null }).ok);

/* --- end reasons ----------------------------------------------------------------------- */
console.log("\n[L5] end reasons → terminal phase");
check("customer_declined → DECLINED", terminalPhaseFor("customer_declined") === "DECLINED");
check("code_expired → EXPIRED", terminalPhaseFor("code_expired") === "EXPIRED");
check("storage_unavailable → FAILED", terminalPhaseFor("storage_unavailable") === "FAILED");
check("everything else → ENDED",
  ["agent_ended", "customer_ended", "agent_disconnected", "terminated_by_admin", "server_shutdown"].every((r) => terminalPhaseFor(r) === "ENDED"));

report("lifecycle unit");
