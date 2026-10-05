/**
 * Source invariants for the 2026-10-05 security & reliability audit
 * (docs/audit/SECURITY_AND_RELIABILITY_AUDIT.md). Each check locks in one fix
 * whose runtime behaviour this Linux suite cannot fully observe — the Windows
 * one cannot run here at all, and the TLS-leg check needs a real proxy.
 *
 * Mutation-tested: each check was confirmed to go red when its fix is reverted.
 */
import { readFileSync } from "node:fs";

import { REPO, check, report } from "../lib/harness.mjs";

const read = (p) => readFileSync(`${REPO}/${p}`, "utf8");
/** Source with // and /* *\/ comments removed, so a comment cannot satisfy a check. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const fnBody = (src, name) => {
  const start = src.search(new RegExp(`function ${name}\\s*\\(`));
  if (start === -1) return "";
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
};

console.log("\n=== Security audit 2026-10-05: source invariants ===\n");

/* F-01 ----------------------------------------------------------------------- */
console.log("[F-01] SYSTEM scripts are staged only in the protected install directory");
const link = code("windows/SecureDesktopService/ServiceLink.cs");
check("ServiceLink never stages under Path.GetTempPath()", !/GetTempPath\s*\(/.test(link));
check("…it stages under the service executable's own directory",
  /Environment\.ProcessPath/.test(link) && /Path\.Combine\(\s*Path\.GetDirectoryName\(exe\)!?\s*,\s*"scripts"\s*\)/.test(link));
check("…cmd.exe is launched by absolute path", /Path\.Combine\(\s*Environment\.SystemDirectory\s*,\s*"cmd\.exe"\s*\)/.test(link));
check("…powershell.exe is launched by absolute path",
  /Path\.Combine\(\s*Environment\.SystemDirectory\s*,\s*"WindowsPowerShell"\s*,\s*"v1\.0"\s*,\s*"powershell\.exe"\s*\)/.test(link));
check("…and no bare interpreter name is passed to ProcessStartInfo",
  !/new ProcessStartInfo\(\s*"(cmd|powershell)\.exe"/.test(link));
const payload = code("windows/Applet/Elevation/ElevationPayload.cs");
check("the install directory it relies on is still created with a protected, non-inherited DACL",
  /SetAccessRuleProtection\(\s*isProtected:\s*true/.test(payload) && /info\.Create\(security\)/.test(payload) &&
  /Directory\.Delete\(dir,\s*recursive:\s*true\)/.test(payload));

/* server --------------------------------------------------------------------- */
const sig = code("server/src/signaling.ts");

console.log("\n[F-02] credential elevation needs TLS on BOTH legs");
const elev = fnBody(sig, "relayElevation");
check("relayElevation looks up the customer's connection", /conns\.get\(session\.hostWs\)/.test(elev));
check("…and refuses unless both legs are secure",
  /bothSecure\s*=\s*conn\.secure\s*&&\s*hostConn\?\.secure\s*===\s*true/.test(elev) &&
  /if\s*\(credential\s*&&\s*!bothSecure\s*&&\s*!config\.allowInsecureDev\)/.test(elev));
check("…and the refusal still happens before the frame is forwarded",
  elev.indexOf("!bothSecure") > -1 && elev.indexOf("!bothSecure") < elev.indexOf("forward(session.hostWs"));

console.log("\n[F-03] losing console access revokes live sockets");
check("agentBlocked() checks console.use", /can\(p,\s*"console\.use"\)/.test(fnBody(sig, "agentBlocked")));
check("applyUserAccessChange() treats !canUseConsole as a revocation",
  /revoked\s*=\s*next\s*===\s*null\s*\|\|\s*next\.status\s*!==\s*"active"\s*\|\|\s*!next\.limits\.canUseConsole/.test(fnBody(sig, "applyUserAccessChange")));

console.log("\n[F-04] sign-out ends the sockets opened with that sign-in");
check("revokeAuthSession() matches on sessionHash and tears down",
  /sessionHash\s*!==\s*sessionHash/.test(fnBody(sig, "revokeAuthSession")) && /teardown\(/.test(fnBody(sig, "revokeAuthSession")));
const auth = code("server/src/routes/auth.ts");
check("POST /auth/logout calls revokeAuthSession for the console", /revokeAuthSession\(p\.sessionHash\)/.test(auth));

console.log("\n[F-05] only known agent messages reach the customer's machine");
const agentMsg = fnBody(sig, "handleAgentMessage");
const lastForward = agentMsg.lastIndexOf("forward(session.hostWs, data, false)");
check("the final raw forward is guarded by an agent.input allow-list",
  lastForward > -1 && /msg\.t\s*!==\s*"agent\.input"\s*\|\|\s*!INPUT_KINDS\.has/.test(agentMsg.slice(0, lastForward)));
check("INPUT_KINDS is exactly mouse, key, sas", /INPUT_KINDS\s*=\s*new Set<unknown>\(\["mouse",\s*"key",\s*"sas"\]\)/.test(sig));

console.log("\n[F-06] self-reported host fields are bounded");
check("host.join fields go through hostField()", /machine:\s*hostField\(msg\.machine\)/.test(sig) && /os:\s*hostField\(msg\.os\)/.test(sig));
check("hostField() truncates and strips control characters",
  /\.slice\(0,\s*MAX_HOST_FIELD_LENGTH\)/.test(fnBody(sig, "hostField")) && /MAX_HOST_FIELD_LENGTH\s*=\s*200/.test(sig));

console.log("\n[F-07] chat rate limit is per side");
check("agent chat uses its own bucket", /chatLimiter\.allow\(`\$\{session\.code\}:agent`\)/.test(sig));
check("host chat uses its own bucket", /chatLimiter\.allow\(`\$\{session\.code\}:host`\)/.test(sig));

console.log("\n[F-08] anonymous sockets are capped per IP");
check("verifyClient refuses past maxAnonymousSocketsPerIp with 429",
  /anonymousSocketsFrom\(clientIp\(req\)\)\s*>=\s*config\.maxAnonymousSocketsPerIp/.test(sig) && /done\(false,\s*429/.test(sig));
check("…and every anonymous admission goes through that check (success and identity-store failure)",
  /if\s*\(principal\s*===\s*null\)\s*admitAnonymous\(\);/.test(sig) && /else\s+admitAnonymous\(\);/.test(sig));

console.log("\n[F-09] video has backpressure");
const video = fnBody(sig, "relayVideo");
check("relayVideo skips frames over the high-water mark", /bufferedAmount\s*>\s*VIDEO_HIGH_WATER_BYTES/.test(video));
check("…and replays the catch-up buffer once it drains", /videoBehind/.test(video) && /catchUpFrames\(session\)/.test(video));
check("binary host frames go through relayVideo", /noteFrame\(session,\s*frame\);\s*relayVideo\(session,\s*frame\);/.test(sig));

report("audit invariants");
