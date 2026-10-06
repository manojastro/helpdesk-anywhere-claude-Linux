/**
 * Platform 2.0, Phase 2 — support tools in the real console, through the real
 * relay, with TWO sessions open to prove per-session isolation.
 *
 *   - saved scripts: listed by category, loading fills editor/shell/privilege,
 *     the run carries libraryRef and the record names it; status line with exit
 *     code and duration; a script name with markup renders as text
 *   - Activity tab: the server timeline of the SELECTED session only
 *   - screenshot: a PNG download of the selected session, a record on that
 *     session only, nothing uploaded
 *   - chat system lines appear in the right session's chat only, and are never
 *     sent to the customer
 *   - six inspector tabs fit without overflow
 */
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { client } from "../lib/auth.mjs";
import { launch, openConsole } from "../lib/browser.mjs";
import { sql } from "../lib/db.mjs";
import { BASE, URL_WS, WebSocket, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

console.log("\n=== Platform 2.0 — Phase 2 support tools ===\n");

// An organisation script whose NAME is markup: it must arrive as text.
const admin = client("admin", process.env.HDA_ADMIN_COOKIE);
const evil = await admin.post("/scripts", {
  name: "<img src=x onerror=window.__xss=1>Evil name", description: "<b>bold?</b>", category: "Disk Space",
  shell: "cmd", runAs: "user", body: "echo hi",
});
check("setup: an organisation script exists", evil.status === 201, JSON.stringify(evil.data));

const browser = await launch();
const page = await openConsole(browser, BASE, { viewport: { width: 1440, height: 900 } });
const downloads = mkdtempSync(path.join(tmpdir(), "hda-shots-"));
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
await page.waitForFunction(() => window.hdaConsole?.me && window.hdaSessions, { timeout: 5000 });

/** A host that answers every exec with a fixed result. */
async function openHost(machine) {
  const host = new WebSocket(URL_WS);
  host.received = [];
  host.on("message", (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    host.received.push(m);
    if (m.t === "agent.exec") {
      setTimeout(() => host.send(JSON.stringify({ t: "host.execResult", id: m.id, stdout: `ran on ${machine}\n`, stderr: "", exitCode: 0, partial: false })), 300);
    }
  });
  await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
  return host;
}

async function connect(i, machine) {
  await page.click("#start-session");
  await page.waitForFunction((n) => window.hdaSessions.list().filter((s) => s.state === "waiting").length >= 1
    && window.hdaSessions.list().length === n, { timeout: 5000 }, i);
  const code = await page.$eval("#code", (e) => e.textContent.trim());
  const host = await openHost(machine);
  host.send(JSON.stringify({ t: "host.join", code, machine, user: `user-${i}`, os: "Windows 11" }));
  await sleep(250);
  host.send(JSON.stringify({ t: "host.consent", accepted: true }));
  await page.waitForFunction((m) => window.hdaSessions.list().some((s) => s.label === m && s.state === "connected"), { timeout: 5000 }, machine);
  const jpeg = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 180;
    c.getContext("2d").fillRect(0, 0, 320, 180);
    return c.toDataURL("image/jpeg").split(",")[1];
  });
  host.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(jpeg, "base64")]), { binary: true });
  return host;
}

const hostA = await connect(1, "PC-ALPHA");
const hostB = await connect(2, "PC-BRAVO");
const selectByLabel = (label) => page.evaluate((l) => {
  const tab = [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === l);
  tab?.click();
}, label);
const ids = await page.evaluate(() => Object.fromEntries(window.hdaSessions.list().map((s) => [s.label, s.sessionId])));

/* --- 1. tabs fit -------------------------------------------------------------------------- */
console.log("[43] inspector tabs");
const tabsFit = await page.$eval(".panel-tabs", (t) => t.scrollWidth <= t.clientWidth + 1);
check("six inspector tabs fit without overflow at 1440px", tabsFit);
check("tabs are Tools, Scripts, Chat, Notes, Activity, System",
  (await page.$$eval(".panel-tab", (ts) => ts.map((t) => t.textContent.replace(/\d+$/, "").trim()).join("|"))) === "Tools|Scripts|Chat|Notes|Activity|System");

/* --- 2. saved scripts on session A ------------------------------------------------------------- */
console.log("\n[43] saved scripts");
await selectByLabel("PC-ALPHA");
await page.click("#tab-scripts");
const groups = await page.$$eval("#script-library optgroup", (gs) => gs.map((g) => g.label));
check("the library is grouped by category", groups.includes("System Information") && groups.includes("Log Collection") && groups.length === 6, JSON.stringify(groups));
const evilOption = await page.evaluate(() => [...document.querySelectorAll("#script-library option")].find((o) => o.textContent.includes("Evil name")));
check("a script name with markup is shown as text and runs nothing", await page.evaluate(() => window.__xss === undefined)
  && (await page.evaluate(() => [...document.querySelectorAll("#script-library option")].some((o) => o.textContent.startsWith("<img")))));
void evilOption;

await page.select("#script-library", "builtin:restart-spooler@1");
const loaded = await page.evaluate(() => ({
  body: document.getElementById("script").value, shell: document.getElementById("shell").value,
  system: document.getElementById("as-system").checked, info: document.getElementById("script-library-info").textContent,
}));
check("loading a saved script fills the editor, shell and privilege", /Restart-Service -Name Spooler/.test(loaded.body) && loaded.shell === "powershell" && loaded.system === true);
check("…and says it needs an elevated session", /SYSTEM — needs an elevated session/.test(loaded.info), loaded.info);

await page.select("#script-library", "builtin:disk-space@1");
hostA.received.length = 0;
await page.click("#run-script");
const execA = await (async () => { for (let i = 0; i < 50; i++) { const m = hostA.received.find((x) => x.t === "agent.exec"); if (m) return m; await sleep(40); } return null; })();
check("the run reaches session A's machine with its libraryRef", execA?.libraryRef?.id === "builtin:disk-space" && execA.libraryRef.version === 1 && execA.asSystem === false);
check("…and nothing reached session B's machine", !hostB.received.some((m) => m.t === "agent.exec"));
check("the status line says it is running", /^Running…/.test(await page.$eval("#script-status", (e) => e.textContent)));
await page.waitForFunction(() => /^Finished · exit code 0 · /.test(document.getElementById("script-status").textContent), { timeout: 4000 }).catch(() => {});
check("…then Finished with the exit code and duration", /^Finished · exit code 0 · \d+\.\d s$/.test(await page.$eval("#script-status", (e) => e.textContent)),
  await page.$eval("#script-status", (e) => e.textContent));
check("the output header names the saved script", /Disk space \(saved v1\)/.test(await page.$eval("#script-output", (e) => e.textContent)));

// Edit after loading: no longer the saved script.
await page.$eval("#script", (e) => { e.value += "\n# tweak"; });
hostA.received.length = 0;
await page.waitForFunction(() => !document.getElementById("run-script").disabled, { timeout: 3000 });
await page.click("#run-script");
const execEdited = await (async () => { for (let i = 0; i < 50; i++) { const m = hostA.received.find((x) => x.t === "agent.exec"); if (m) return m; await sleep(40); } return null; })();
check("an edited saved script is sent without libraryRef", execEdited && !("libraryRef" in execEdited));
await sleep(600);

/* --- 3. per-session isolation of library pick and status --------------------------------------- */
console.log("\n[43] isolation");
await selectByLabel("PC-BRAVO");
await sleep(150);
const b = await page.evaluate(() => ({
  lib: document.getElementById("script-library").value, info: document.getElementById("script-library-info").hidden,
  status: document.getElementById("script-status").textContent, script: document.getElementById("script").value,
}));
check("session B has its own (empty) library pick, status and editor", b.lib === "" && b.info === true && b.status === "" && b.script === "", JSON.stringify(b));
await selectByLabel("PC-ALPHA");
await sleep(150);
check("switching back to A restores A's status", /^Finished · exit code 0/.test(await page.$eval("#script-status", (e) => e.textContent)));

/* --- 4. activity ------------------------------------------------------------------------------- */
console.log("\n[43] activity");
await page.click("#tab-activity");
await page.waitForFunction(() => /Script requested/.test(document.getElementById("activity-list").textContent), { timeout: 6000 }).catch(() => {});
const actA = await page.$eval("#activity-list", (e) => e.textContent);
check("A's activity shows the saved script by name", /Script requested/.test(actA) && /Disk space \(saved v1\)/.test(actA), actA.slice(0, 300));
check("…and the customer joining", /Customer joined/.test(actA) && /PC-ALPHA/.test(actA));
await selectByLabel("PC-BRAVO");
await page.waitForFunction(() => /PC-BRAVO/.test(document.getElementById("activity-list").textContent), { timeout: 6000 }).catch(() => {});
const actB = await page.$eval("#activity-list", (e) => e.textContent);
check("B's activity is B's: its own machine, and none of A's scripts", /PC-BRAVO/.test(actB) && !/PC-ALPHA/.test(actB) && !/Script requested/.test(actB), actB.slice(0, 300));

/* --- 5. screenshot ------------------------------------------------------------------------------ */
console.log("\n[43] screenshot");
const shotBtn = await page.$eval("#toolbar-screenshot", (b) => b.disabled);
check("the screenshot button is enabled on a live session", shotBtn === false);
await page.click("#toolbar-screenshot");
let file = null;
for (let i = 0; i < 40 && !file; i++) {
  await sleep(100);
  file = readdirSync(downloads).find((f) => f.endsWith(".png"));
}
check("a PNG is saved to this computer, named after the session and machine",
  !!file && /^HDA-[0-9A-F]{8}_PC-BRAVO_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.png$/.test(file) && statSync(path.join(downloads, file)).size > 100, String(file));
await sleep(500);
const shotRows = await sql("SELECT session_id FROM session_events WHERE type = 'screenshot.taken'");
check("the screenshot is recorded on B only", shotRows.length === 1 && shotRows[0].session_id === ids["PC-BRAVO"], JSON.stringify(shotRows));

/* --- 6. chat system lines ------------------------------------------------------------------------ */
console.log("\n[43] chat system lines");
await page.click("#tab-chat");
const chatB = await page.$$eval("#chat-log .chat-system", (rows) => rows.map((r) => r.textContent));
check("B's chat shows its own system lines (connected, screenshot)",
  chatB.some((t) => /remote control started/.test(t)) && chatB.some((t) => /Screenshot captured/.test(t)), JSON.stringify(chatB));
await selectByLabel("PC-ALPHA");
await sleep(150);
const chatA = await page.$$eval("#chat-log .chat-system", (rows) => rows.map((r) => r.textContent));
check("A's chat does not show B's screenshot line", !chatA.some((t) => /Screenshot/.test(t)), JSON.stringify(chatA));
check("system lines are never sent to the customer", ![...hostA.received, ...hostB.received].some((m) => m.t === "chat.message"));

/* --- 7. system tab -------------------------------------------------------------------------------- */
await page.click("#tab-info");
const sys = await page.$eval("#system-info", (e) => e.textContent);
check("System tab shows the selected machine's facts", /Computer name\s*PC-ALPHA/.test(sys) && /Signed-in user\s*user-1/.test(sys), sys.slice(0, 200));

check("no uncaught page errors", page.errors.length === 0, page.errors.join(" | "));
await page.evaluate(() => document.getElementById("disconnect-all").click());
await page.click("#disconnect-all-confirm");
await sleep(400);
hostA.close(); hostB.close();
await browser.close();
console.log(`\n--- browser/43 support tools: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
