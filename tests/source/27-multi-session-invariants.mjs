/**
 * Multi-session invariants a behavioural test can miss until the day it matters.
 *
 *   1. The limit check and the reservation in agent.create run in ONE synchronous
 *      turn. An `await` slipped in between is invisible in every sequential test
 *      and lets two concurrent creates both become session #4.
 *   2. The console has no module-level socket: every wire send goes through a
 *      RemoteSession, so no code path can reach "whichever socket is current".
 *   3. An admin password is never written to web storage (the resume tokens that
 *      are, are the only thing that is).
 *   4. Multi-session changed nothing under windows/. The baseline is the commit
 *      the feature branched from (22ce263), not the golden tag: windows/ had
 *      already moved on from golden (Feature Batches 1–2) before this feature.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isApprovedDelta } from "../lib/approved-windows-deltas.mjs";
import { REPO, check, report } from "../lib/harness.mjs";

/** The commit multi-session support branched from (feature/admin-portal). */
const MULTI_SESSION_BASE = "22ce263";
/**
 * Last commit of the multi-session release. The "changed nothing under windows/"
 * check covers that release's own commits; later reviewed releases (Platform 2.0
 * Phase 2b) carry their own guard in source/42.
 */
const MULTI_SESSION_END = "2e69ad8";

const signaling = readFileSync(`${REPO}/server/src/signaling.ts`, "utf8");
const portal = readFileSync(`${REPO}/server/public/portal.js`, "utf8");

console.log("\n=== Multi-session invariants ===\n");

const create = signaling.slice(signaling.indexOf("async function handleAgentCreate"), signaling.indexOf("export function effectiveSessionLimit"));
const from = create.indexOf("effectiveSessionLimit(p)");
const to = create.indexOf("sessions.create(");
check("agent.create checks the limit before it reserves the slot", from > 0 && to > from);
check("…with no await between the check and the reservation (race-safe)", from > 0 && to > from && !/\bawait\b/.test(create.slice(from, to)));

check("the console has no module-level `let ws`", !/^let ws\b/m.test(portal));
check("every agent.input goes out through a session", !/[^.]\bws\.send\(JSON\.stringify\(\{ t: "agent\.input"/.test(portal));
check("input listeners are bound per session canvas, not on document",
  /function wireCanvasInput\(s\)/.test(portal) && !/document\.addEventListener\("(keydown|keyup|mousedown)",[^)]*sendInput/.test(portal));
check("a key-up is forwarded only for a key that went down on that session", /if \(!s\.heldKeys\.delete\(ev\.code\)\) return;/.test(portal));
check("switching sessions clears typed admin credentials",
  /function select\(s[^]*?clearCredentialFields\(\)/.test(portal));

const storageWrites = [...portal.matchAll(/(?:sessionStorage|localStorage)\.setItem\(([^)]*)\)/g)].map((m) => m[1]);
check("web storage is written only for quick replies and resume tokens",
  storageWrites.length === 2 && storageWrites.every((a) => /QUICK_REPLY_STORAGE_KEY|STORAGE_KEY/.test(a)), JSON.stringify(storageWrites));
check("no password field is ever read into a stored structure",
  !/elevPassword[^;]*setItem|setItem[^;]*elevPassword|password[^;\n]*sessionStorage/.test(portal));

let windowsDiff = "";
try {
  windowsDiff = execFileSync("git", ["-C", REPO, "diff", "--name-only", MULTI_SESSION_BASE, MULTI_SESSION_END, "--", "windows/"], { encoding: "utf8" })
    .split("\n").filter(Boolean)
    // Reviewed later changes (security audit) pass only with their exact pinned blobs.
    .filter((f) => !isApprovedDelta(REPO, MULTI_SESSION_BASE, f))
    .join("\n");
} catch (e) {
  windowsDiff = `git failed: ${e.message}`;
}
check("multi-session changed nothing under windows/ (no applet change; approved deltas pinned)", windowsDiff.trim() === "", windowsDiff.trim());

report("multi-session invariants");
