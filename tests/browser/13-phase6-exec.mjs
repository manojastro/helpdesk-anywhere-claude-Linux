/**
 * Phase 6 acceptance (Linux half): the console's script pane, the streaming
 * protocol, and the server-side guardrails.
 *
 * Running an actual PowerShell script needs Windows. Everything else does not:
 * the agent.exec frame, incremental rendering of partial chunks, the final exit
 * code, the run history, and — the guardrail that matters — that the full script
 * text is audited BEFORE execution and that streaming does not spam the audit log.
 */
import { readFileSync, readdirSync } from "node:fs";
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep, AUDIT_DIR } from "../lib/harness.mjs";

const WS = URL_WS;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const auditLines = () => readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(`${AUDIT_DIR}/${f}`, "utf8").trim().split("\n"))
  .filter(Boolean).map((l) => JSON.parse(l));

const browser = await launch();

console.log("\n=== Phase 6 — script execution: console, streaming, guardrails ===\n");

const page = await openConsole(browser, BASE, { viewport: { width: 1400, height: 1200 } });
const errors = page.errors;
const code = await startSession(page);

const host = new WebSocket(WS);
const received = [];
host.on("message", (d, b) => { if (!b) received.push(JSON.parse(d.toString())); });
await new Promise((res) => host.once("open", res));
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-TEST", user: "alice", os: "Windows" }));
await sleep(200);

const scriptingDisabledBefore = await page.$eval("#scripting", (f) => f.disabled);
check("the script pane is disabled before consent", scriptingDisabledBefore === true);

host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected");
const scriptingEnabled = await page.$eval("#scripting", (f) => !f.disabled);
check("the script pane enables once the user has consented", scriptingEnabled);

/* --- 1. Run sends a well-formed agent.exec ---------------------------------- */
const SCRIPT = "Get-Process | Select -First 5";
received.length = 0;
await page.type("#script", SCRIPT);
await page.click("#run-script");
await sleep(300);
const exec = received.find((m) => m.t === "agent.exec");
check("Run sends agent.exec with the script, shell and asSystem flag",
  exec && exec.script === SCRIPT && exec.shell === "powershell" && exec.asSystem === false && !!exec.id,
  exec ? `id=${exec.id} shell=${exec.shell}` : "no frame");

const runDisabled = await page.$eval("#run-script", (b) => b.disabled);
check("Run is disabled while an execution is in flight", runDisabled === true);

/* --- 2. the full script text is audited BEFORE the process could start ------ */
const requested = auditLines().filter((l) => l.event === "exec.requested");
const mine = requested.find((l) => l.id === exec.id);
check("exec.requested carries the FULL script text (constraint #5)",
  mine && mine.script === SCRIPT, mine ? JSON.stringify(mine?.script) : "not audited");
check("…and was written before any result came back",
  auditLines().filter((l) => l.event === "exec.result" && l.id === exec.id).length === 0);

/* --- 3. partial chunks render incrementally --------------------------------- */
host.send(JSON.stringify({ t: "host.execResult", id: exec.id, exitCode: -1, stdout: "first chunk\n", stderr: "", partial: true }));
await sleep(250);
let output = await page.$eval("#script-output", (e) => e.textContent);
check("a partial chunk appears immediately", output.includes("first chunk"), JSON.stringify(output.slice(-40)));

host.send(JSON.stringify({ t: "host.execResult", id: exec.id, exitCode: -1, stdout: "second chunk\n", stderr: "", partial: true }));
await sleep(250);
output = await page.$eval("#script-output", (e) => e.textContent);
check("chunks append rather than replace",
  output.includes("first chunk") && output.includes("second chunk"));
check("a partial does NOT close out the run",
  (await page.$eval("#run-script", (b) => b.disabled)) === true);

/* --- 4. only the FINAL result is audited ------------------------------------ */
// Scoped to THIS run: the audit log is append-only and persists across runs.
const resultsBefore = auditLines().filter((l) => l.event === "exec.result" && l.id === exec.id).length;
check("partial chunks are not audited (no one record per 250ms of output)",
  resultsBefore === 0, `${resultsBefore} exec.result records`);

host.send(JSON.stringify({ t: "host.execResult", id: exec.id, exitCode: 0, stdout: "done\n", stderr: "" }));
await sleep(350);
output = await page.$eval("#script-output", (e) => e.textContent);
check("the final result shows the exit code", output.includes("[exit code 0]"), JSON.stringify(output.slice(-30)));
check("Run re-enables after the final result",
  (await page.$eval("#run-script", (b) => b.disabled)) === false);
const results = auditLines().filter((l) => l.event === "exec.result" && l.id === exec.id);
check("exactly one exec.result is audited for the run", results.length === 1, `${results.length} records`);
check("…with the real exit code", results[0]?.exitCode === 0, JSON.stringify(results[0]));

/* --- 5. run history --------------------------------------------------------- */
const history = await page.$eval("#script-history", (o) => o.children.length);
const historyText = await page.$eval("#script-history", (o) => o.textContent);
check("the run is recorded in the per-session history",
  history === 1 && historyText.includes("Get-Process"), `${history} entries`);

/* --- 6. script text is never parsed as markup ------------------------------- */
await page.$eval("#script", (t) => { t.value = ""; });
const XSS = "<img src=x onerror=alert(1)>Write-Host 'hi'";
await page.type("#script", XSS);
received.length = 0;
await page.click("#run-script");
await sleep(300);
const exec2 = received.find((m) => m.t === "agent.exec");
const injected = await page.evaluate(() => document.querySelectorAll("#script-history img").length);
check("a script containing HTML is not parsed as markup in the history",
  injected === 0 && (await Promise.resolve(exec2))?.script === XSS, `${injected} injected elements`);
host.send(JSON.stringify({ t: "host.execResult", id: exec2.id, exitCode: 1, stdout: "", stderr: "boom\n" }));
await sleep(300);
const out2 = await page.$eval("#script-output", (e) => e.textContent);
check("stderr is shown and a non-zero exit code is reported",
  out2.includes("boom") && out2.includes("[exit code 1]"), JSON.stringify(out2.slice(-40)));

/* --- 7. asSystem travels as requested --------------------------------------- */
await page.$eval("#script", (t) => { t.value = ""; });
await page.click("#as-system");
await page.type("#script", "whoami");
received.length = 0;
await page.click("#run-script");
await sleep(300);
const exec3 = received.find((m) => m.t === "agent.exec");
check("the Run as SYSTEM checkbox sets asSystem:true", exec3?.asSystem === true, JSON.stringify(exec3?.asSystem));
const sysAudit = auditLines().find((l) => l.event === "exec.requested" && l.id === exec3.id);
check("…and the elevation intent is audited too", sysAudit?.asSystem === true);
host.send(JSON.stringify({ t: "host.execResult", id: exec3.id, exitCode: -1, stdout: "", stderr: "Run as SYSTEM requires elevation, which is not available yet (Phase 5)." }));
await sleep(300);

/* --- 8. session end clears the pane ----------------------------------------- */
await page.click("#end-session");
await sleep(400);
const afterEnd = await page.evaluate(() => ({
  disabled: document.getElementById("scripting").disabled,
  output: document.getElementById("script-output").textContent,
  history: document.getElementById("script-history").children.length,
}));
check("session end disables the pane and clears output and history",
  afterEnd.disabled === true && afterEnd.output === "" && afterEnd.history === 0,
  JSON.stringify(afterEnd));
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

try { host.close(); } catch {}
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
