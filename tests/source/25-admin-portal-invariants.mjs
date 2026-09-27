/**
 * Source invariants for the admin-portal release — properties no runtime test
 * here can observe cheaply, asserted over the source:
 *
 *   1. The privileged Windows components are byte-identical to the golden,
 *      real-Windows-verified checkpoint (CLAUDE.md "CRITICAL REGRESSION WARNING").
 *   2. The relay forwards a credential-bearing elevation frame BEFORE any
 *      database work, and never awaits the database while holding it.
 *   3. No schema column exists for a pairing code, password, token or cookie.
 *   4. The two applications are separate: the admin portal's frontend never
 *      talks to the relay or the console API, and vice versa.
 *   5. The Docker image cannot run development sign-in.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { REPO, check, report } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");

console.log("\n=== Admin-portal source invariants ===\n");

/* 1 ------------------------------------------------------------------------ */
console.log("[25.1] privileged Windows components match the golden checkpoint");
const GOLDEN = "hda-windows-privileged-control-working-2026-09-06";
const PROTECTED = [
  "windows/DesktopHelper", "windows/SecureDesktopService", "windows/Applet/SessionLaunch",
];
const PROTECTED_NAMES = /(DesktopHelper|DesktopWatcher|SessionWatcher|SecureDesktopService|SecureDesktopBridge|SessionLaunch|StreamSource|DesktopGuard|InputInjector|PipeChannel|Link)\b/;
let gitOk = true;
try { execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${GOLDEN}^{commit}`], { stdio: "ignore" }); } catch { gitOk = false; }
if (!gitOk) {
  console.log("  SKIP  golden tag not present in this clone");
} else {
  const changed = execFileSync("git", ["-C", REPO, "diff", "--name-only", GOLDEN, "--", "windows/"], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const touched = changed.filter((f) => PROTECTED.some((d) => f.startsWith(d)) || PROTECTED_NAMES.test(f.split("/").pop() ?? ""));
  check("no privileged-control file differs from the golden tag", touched.length === 0, touched.join(", ") || `${changed.length} non-privileged windows file(s) differ`);
  check("the only applet UI change of this release is the ChatForm notice",
    !changed.some((f) => /AppletContext|ConsentForm|IndicatorForm\.cs$/.test(f) && !isPreexisting(f)));
}
function isPreexisting(f) {
  // IndicatorForm/Protocol.cs changed in Feature Batches 1–2, before this release.
  try {
    execFileSync("git", ["-C", REPO, "diff", "--quiet", "pre-admin-portal-2026-09-27", "--", f]);
    return true;
  } catch { return false; }
}

/* 2 ------------------------------------------------------------------------ */
console.log("\n[25.2] credential frames are forwarded, never held for the database");
const sig = read("server/src/signaling.ts");
const relay = sig.slice(sig.indexOf("function relayElevation("), sig.indexOf("/* --------------------------------------------------------------------- host → agent */"));
check("relayElevation is synchronous (no async/await while holding the frame)", !/\basync\b|\bawait\b/.test(relay));
const fwd = relay.lastIndexOf("forward(session.hostWs, data, false)");
const rec = relay.lastIndexOf('recordEvent(session, "elevation.requested"');
check("the frame is forwarded before the timeline write is even queued", fwd !== -1 && rec !== -1 && fwd < rec);
check("the timeline gets the mode only — not the account name", !/recordEvent\([^)]*username/.test(relay));
const records = read("server/src/records.ts");
check("records.ts never touches a password field", !/password/i.test(records.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));

/* 3 ------------------------------------------------------------------------ */
console.log("\n[25.3] the schema has nowhere to put a secret");
const ddl = readdirSync(`${REPO}/server/migrations`).map((f) => read(`server/migrations/${f}`)).join("\n")
  .replace(/--.*$/gm, "");
for (const col of ["code", "pairing_code", "password", "access_token", "id_token", "refresh_token", "cookie", "token"]) {
  check(`no column named ${col}`, !new RegExp(`^\\s+${col}\\s+\\w`, "m").test(ddl));
}
check("browser sessions are stored as a hash", /id_hash\s+bytea PRIMARY KEY/.test(ddl));

/* 4 ------------------------------------------------------------------------ */
console.log("\n[25.4] two separate applications");
const adminJs = readdirSync(`${REPO}/admin-portal/public`).filter((f) => f.endsWith(".js")).map((f) => read(`admin-portal/public/${f}`)).join("\n");
const consoleJs = ["portal.js", "identity.js", "login.js", "join.js"].map((f) => read(`server/public/${f}`)).join("\n");
check("the admin portal never opens the relay WebSocket", !/new WebSocket|\/ws\b/.test(adminJs));
check("the admin portal never calls the console API", !/\/api\/agent\//.test(adminJs));
check("the console never calls the admin API", !/\/api\/admin\//.test(consoleJs));
const index = read("server/src/index.ts");
check("the relay is attached to the agent server only", /attachSignaling\(agentServer\)/.test(index) && !/attachSignaling\(adminServer\)/.test(index));
check("the admin API is mounted on the admin app only", /adminApp\.use\("\/api\/admin"/.test(index) && !/agentApp\.use\("\/api\/admin"/.test(index));
check("the console API is mounted on the agent app only", /agentApp\.use\("\/api\/agent"/.test(index) && !/adminApp\.use\("\/api\/agent"/.test(index));
check("each app resolves only its own portal's cookie", /agentApp\.use\(attachPrincipal\("agent"\)\)/.test(index) && /adminApp\.use\(attachPrincipal\("admin"\)\)/.test(index));

/* 5 ------------------------------------------------------------------------ */
console.log("\n[25.5] the production image cannot run development sign-in");
const dockerfile = read("server/Dockerfile");
check("the runtime image sets NODE_ENV=production", /FROM node:22-alpine AS runtime[\s\S]*ENV NODE_ENV=production/.test(dockerfile));
const compose = read("docker-compose.yml");
check("docker-compose pins AUTH_MODE to entra", /AUTH_MODE: entra\b/.test(compose) && !/AUTH_MODE: \$\{/.test(compose));
check("the startup check refuses dev mode under production", /c\.nodeEnv === "production"/.test(read("server/src/startupChecks.ts")));
check("no .env file is tracked", !existsSync(`${REPO}/.env`) || execFileSync("git", ["-C", REPO, "ls-files", ".env"], { encoding: "utf8" }).trim() === "");

report("admin-portal source invariants");
