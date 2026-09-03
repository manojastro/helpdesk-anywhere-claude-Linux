/** PLAN 1.6 audit log + CLAUDE.md #6 credential handling. */
import { readFileSync, readdirSync } from "node:fs";
import { open, send, waitFor, check, report, sleep, AUDIT_DIR, SERVER_LOG } from "../lib/harness.mjs";


const SECRET = "Tr0ub4dor-Sentinel-Passw0rd!";

console.log("\n=== Phase 1 acceptance — audit log & credential handling ===\n");
console.log("[12] Session lifecycle is audited");

const agent = await open();
send(agent, { t: "agent.create" });
const s = await waitFor(agent, (m) => m.t === "session.created");
const code = s.code;

const host = await open();
send(host, { t: "host.join", code, machine: "AUDIT-PC", user: "alice", os: "Windows 11" });
await waitFor(host, (m) => m.t === "host.connectRequest");
send(host, { t: "host.consent", accepted: true });
await waitFor(agent, (m) => m.t === "consent.result");

// Every credential-bearing message this phase can carry, over plain ws://.
send(agent, { t: "agent.requestElevation", mode: "credential",
  domain: "CORP", username: "svc-admin", password: SECRET });
const insecure = await waitFor(agent, (m) => m.t === "error" && m.code === "insecure_transport");
check("credential elevation over non-wss → insecure_transport (CLAUDE.md #6.1)", !!insecure,
  JSON.stringify(insecure));
check("credential frame never reached the host",
  !host.received.find((m) => m.t === "agent.requestElevation"));

send(agent, { t: "agent.requestElevation", mode: "interactive" });
const interactive = await waitFor(host, (m) => m.t === "agent.requestElevation");
check("interactive elevation relays to the host", !!interactive, JSON.stringify(interactive));

send(agent, { t: "agent.exec", id: "job-1", shell: "powershell",
  script: "Get-Process | Select-Object -First 3", asSystem: false });
await waitFor(host, (m) => m.t === "agent.exec");
send(host, { t: "host.execResult", id: "job-1", exitCode: 0, stdout: "ok", stderr: "" });
await waitFor(agent, (m) => m.t === "host.execResult");

send(agent, { t: "agent.end" });
await sleep(500);

// ------------------------------------------------------------------- inspect
const files = readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"));
check("audit JSONL file written", files.length > 0, files.join(","));

const raw = files.map((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8")).join("");
const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const mine = lines.filter((l) => l.code === code);

console.log(`\n  audit records for session ${code}:`);
for (const l of mine) console.log(`    ${JSON.stringify(l)}`);

const has = (ev) => mine.some((l) => l.event === ev);
check("session.created audited", has("session.created"));
check("session.joined audited", has("session.joined"));
check("session.consent audited", has("session.consent"));
check("session.ended audited", has("session.ended"));
check("elevation.requested audited", has("elevation.requested"));
check("exec.requested audited with full script text",
  mine.some((l) => l.event === "exec.requested" &&
    l.script === "Get-Process | Select-Object -First 3"));
check("exec.result audited", has("exec.result"));
check("every record is append-only JSONL with a timestamp",
  mine.every((l) => typeof l.ts === "string" && typeof l.event === "string"));

console.log("\n[13] The sentinel password appears nowhere (CLAUDE.md #6.2)");
check("password absent from the audit log", !raw.includes(SECRET));

const serverLog = readFileSync(SERVER_LOG, "utf8");
check("password absent from server stdout/stderr", !serverLog.includes(SECRET));

const credRecord = mine.find((l) => l.event === "elevation.requested" && l.mode === "credential");
check("credential attempt is audited by fact/username, not password",
  !!credRecord && credRecord.username === "svc-admin" && !("password" in credRecord),
  JSON.stringify(credRecord));

await sleep(100);
report("audit block");
