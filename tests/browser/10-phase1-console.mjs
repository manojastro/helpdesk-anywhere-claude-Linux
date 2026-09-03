/**
 * Phase 1 acceptance — the browser half, verbatim from PLAN.md:
 *
 *   "With `npm run dev`, open two browser tabs. Tab 1 creates a session and shows
 *    a code. A mock host (scripts/mock-host.js) joins with that code, receives
 *    connectRequest, replies consent:true; Tab 1 flips to 'Connected'."
 */
import { spawn } from "node:child_process";
import { launch, openConsole } from "../lib/browser.mjs";
import { REPO, BASE, URL_WS, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function textOf(page, sel) {
  return page.$eval(sel, (e) => e.textContent.trim());
}
async function waitForText(page, sel, want, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = await textOf(page, sel).catch(() => "");
    if (t === want) return true;
    await sleep(100);
  }
  return false;
}

const browser = await launch();

console.log("\n=== Phase 1 acceptance — browser (two tabs) ===\n");

// ------------------------------------------------------------------- Tab 1
console.log("[14] Tab 1: agent console creates a session and shows a code");
const tab1 = await openConsole(browser, `${BASE}/`);
const consoleErrors = tab1.errors;
check("portal.html loads", (await tab1.title()).includes("Agent Console"), await tab1.title());
check("status starts Idle", (await textOf(tab1, "#status")) === "Idle");

await tab1.evaluate(() => document.getElementById("start-session").click());
const gotCode = await new Promise(async (res) => {
  for (let i = 0; i < 50; i++) {
    const c = await textOf(tab1, "#code").catch(() => "------");
    if (/^\d{6}$/.test(c)) return res(c);
    await sleep(100);
  }
  res(null);
});
check("Tab 1 shows a 6-digit code", /^\d{6}$/.test(gotCode ?? ""), `code=${gotCode}`);

const status1 = await textOf(tab1, "#status");
check("Tab 1 status is 'Waiting for user…'", status1 === "Waiting for user…", status1);

const joinUrl = await textOf(tab1, "#join-url");
check("Tab 1 shows a path-style join URL", joinUrl === `${BASE}/j/${gotCode}`, joinUrl);

// ------------------------------------------------------------------- Tab 2
console.log("\n[15] Tab 2: the end-user join page at /j/<code>");
const tab2 = await browser.newPage();
await tab2.goto(`${BASE}/j/${gotCode}`, { waitUntil: "domcontentloaded" });
check("join.html loads at the path-style URL",
  (await tab2.title()).includes("Join your support session"), await tab2.title());
check("join page shows the same code", (await textOf(tab2, "#code")) === gotCode,
  await textOf(tab2, "#code"));
check("join page repeats the code in the instructions",
  (await textOf(tab2, "#code-inline")) === gotCode);
const dl = await tab2.$eval("#download", (a) => a.getAttribute("href"));
check("join page offers the applet download", dl === "/download/HelpdeskAnywhere.exe", dl);
const steps = await tab2.$$eval("ol li", (ls) => ls.length);
check("join page has numbered instructions", steps === 4, `${steps} steps`);

// ------------------------------------------------- mock host joins & consents
console.log("\n[16] scripts/mock-host.js joins, gets connectRequest, consents true");
const mock = spawn("node", ["scripts/mock-host.js", gotCode, "--url", URL_WS, "--stay"],
  { cwd: REPO });
let mockOut = "";
mock.stdout.on("data", (d) => { mockOut += d.toString(); });
mock.stderr.on("data", (d) => { mockOut += d.toString(); });
// Latch the exit immediately: by the time block [17] looks, the process may
// already be gone, and 'exit' does not re-fire for a listener attached later.
let mockExit;
const mockExited = new Promise((res) => { mockExit = res; });
mock.on("exit", (c) => mockExit(c));

const sawConsent = await waitForText(tab1, "#status", "Awaiting consent…", 5000);
// The mock replies immediately, so 'Awaiting consent…' may already have advanced.
const flipped = await waitForText(tab1, "#status", "Connected", 8000);

console.log("  --- mock-host.js output ---");
for (const line of mockOut.trim().split("\n")) console.log(`    ${line}`);

check("mock host received host.connectRequest", mockOut.includes("host.connectRequest"),
  mockOut.includes("agentName") ? "with agentName" : "");
check("mock host replied host.consent accepted:true",
  mockOut.includes('"t":"host.consent"') && mockOut.includes('"accepted":true'));
check("Tab 1 passed through 'Awaiting consent…' or advanced past it", sawConsent || flipped);
check("Tab 1 flips to 'Connected'", flipped, await textOf(tab1, "#status"));
check("Tab 1 shows the host machine details",
  (await textOf(tab1, "#host-info")).includes("MOCK-PC"), await textOf(tab1, "#host-info"));
check("End session button is enabled once connected",
  await tab1.$eval("#end-session", (b) => !b.disabled));

// Screenshots are evidence, not an assertion - Page.captureScreenshot is flaky on
// this headless build, so never let it block the acceptance result.
const withTimeout = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(r, ms))]);
if (process.env.SHOT_DIR) {
  try {
    await withTimeout(tab1.screenshot({ path: `${process.env.SHOT_DIR}/tab1-connected.png` }), 15000);
    await withTimeout(tab2.screenshot({ path: `${process.env.SHOT_DIR}/tab2-joinpage.png`, fullPage: true }), 15000);
  } catch (e) {
    console.log(`  (screenshot skipped: ${e.message})`);
  }
}

// ------------------------------------------------------------ end session
console.log("\n[17] End session from Tab 1 tears the mock host down");
await tab1.evaluate(() => document.getElementById("end-session").click());
const ended = await waitForText(tab1, "#status", "Session ended", 5000);
check("Tab 1 status becomes 'Session ended'", ended, await textOf(tab1, "#status"));

const exitCode = await Promise.race([
  mockExited,
  new Promise((res) => setTimeout(() => res("timeout"), 5000)),
]);
check("mock host process exited when the session ended", exitCode === 0, `exit=${exitCode}`);
check("mock host saw the socket close", mockOut.includes('"closed"'));

check("no uncaught JS errors in the console page", consoleErrors.length === 0,
  consoleErrors.join(" | "));

await browser.close();
console.log(`\n--- browser block: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
