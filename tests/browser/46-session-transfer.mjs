/**
 * Platform 2.0 Phase 5 — a session transfer between two real consoles (two
 * separately signed-in browser contexts) through the real relay; the customer
 * approves the handover from an applet-shaped host.
 */
import { ensureActiveUser } from "../lib/auth.mjs";
import { launch, setSessionCookie } from "../lib/browser.mjs";
import { BASE, URL_WS, WebSocket, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
console.log("\n=== Session transfer between two consoles ===\n");

const cookieB = await ensureActiveUser(process.env.HDA_ADMIN_COOKIE, { objectId: "b2b2b2b2-0000-4000-8000-0000000000b2", name: "Bea Receiver", roles: ["Agent"], agentCode: "BEA-2" });
const browser = await launch();
async function consoleFor(cookie) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await setSessionCookie(page, BASE, cookie);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.hdaConsole?.me && window.hdaSessions, { timeout: 5000 });
  return page;
}
const A = await consoleFor(process.env.HDA_AGENT_COOKIE);
const B = await consoleFor(cookieB);
await sleep(600);   // both lobbies open

// A's customer.
await A.click("#start-session");
await A.waitForFunction(() => window.hdaSessions.list()[0]?.state === "waiting", { timeout: 5000 });
const code = await A.$eval("#code", (e) => e.textContent.trim());
const host = new WebSocket(URL_WS);
host.received = [];
host.on("message", (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d.toString());
  host.received.push(m);
  // The customer approves the handover.
  if (m.t === "host.transferRequest") setTimeout(() => host.send(JSON.stringify({ t: "host.transferConsent", transferId: m.transferId, accepted: true })), 300);
});
await new Promise((r) => host.once("open", r));
host.send(JSON.stringify({ t: "host.join", code, machine: "JOHN-PC", user: "john", os: "Windows 11", protocolVersion: 2, capabilities: ["transfer", "resume"] }));
await sleep(250);
host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await A.waitForFunction(() => window.hdaSessions.list()[0]?.state === "connected", { timeout: 5000 });

check("A: Transfer is enabled on a connected, transferable session", !(await A.$eval("#transfer-session", (b) => b.disabled)));
await A.click("#transfer-session");
await A.waitForFunction(() => document.querySelectorAll("#transfer-list .transfer-row").length > 0, { timeout: 4000 }).catch(() => {});
const listed = await A.$$eval("#transfer-list .transfer-row", (rows) => rows.map((r) => r.textContent));
check("A: the dialog lists Bea, with her free slots", listed.length === 1 && /Bea Receiver/.test(listed[0]) && /0 \/ 4 sessions/.test(listed[0]), JSON.stringify(listed));
await A.click("#transfer-list input[type=radio]");
await A.type("#transfer-note", "Outlook keeps crashing");
await A.click("#transfer-send");
await A.waitForFunction(() => /waiting for Bea Receiver to accept/.test(document.getElementById("status").textContent), { timeout: 3000 }).catch(() => {});
check("A: status says it is waiting for Bea", /waiting for Bea Receiver to accept/.test(await A.$eval("#status", (e) => e.textContent)));

await B.waitForFunction(() => document.getElementById("incoming-modal").open, { timeout: 4000 }).catch(() => {});
const incoming = await B.evaluate(() => ({ open: document.getElementById("incoming-modal").open, text: document.getElementById("incoming-modal").textContent }));
check("B: an incoming transfer dialog shows the session, A, the customer and the note",
  incoming.open && /JOHN-PC/.test(incoming.text) && /Outlook keeps crashing/.test(incoming.text) && /HDA-/.test(incoming.text), incoming.text.slice(0, 200));
await B.click("#incoming-accept");

await B.waitForFunction(() => window.hdaSessions.list().some((s) => s.label === "JOHN-PC" && s.state === "connected"), { timeout: 8000 }).catch(() => {});
check("B: after the customer approves, the session opens in B's console, connected", await B.evaluate(() => window.hdaSessions.list().some((s) => s.label === "JOHN-PC" && s.state === "connected")));
await A.waitForFunction(() => window.hdaSessions.list().length === 0, { timeout: 5000 }).catch(() => {});
check("A: the session left A's console", await A.evaluate(() => window.hdaSessions.list().length === 0));
check("A: and A was told it was transferred to Bea", /Transferred to Bea Receiver/.test(await A.$eval("#status", (e) => e.textContent)));
await sleep(1500);
check("A: A's console did not try to resume it", await A.evaluate(() => window.hdaSessions.list().length === 0));

host.received.length = 0;
await B.click("#remote");
await B.keyboard.press("KeyZ");
await sleep(300);
check("B: B's keyboard now reaches the customer's machine", host.received.some((m) => m.t === "agent.input" && m.code === "KeyZ"));
check("no page errors (A, B)", A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(" | "));

await B.evaluate(() => document.getElementById("disconnect-all").click());
await B.click("#disconnect-all-confirm");
await sleep(300);
host.close();
await browser.close();
console.log(`\n--- browser/46 session transfer: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
