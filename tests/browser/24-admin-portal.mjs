/**
 * The definition-of-done flow, through BOTH real user interfaces:
 *
 *   admin signs in (admin portal) → technician signs in and is Pending →
 *   admin activates them in the UI → technician runs a session in the console
 *   (customer joins and consents, both chat, notes saved) → session ends →
 *   timeline and transcript in the admin portal's history → admin exports and
 *   downloads the PDF → an Agent-only identity cannot use the admin portal.
 *
 * Plus: the chat-is-saved notice, verified identity in the console header, a
 * markup payload in chat rendered as text in the admin transcript, and the admin
 * portal at phone width.
 */
import { launch } from "../lib/browser.mjs";
import { ADMIN_BASE, BASE } from "../lib/auth.mjs";
import { sql } from "../lib/db.mjs";
import { WebSocket, URL_WS, check, report, sleep } from "../lib/harness.mjs";

const browser = await launch();
const errors = [];
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Expected: a signed-out probe answering 401/403, and Chrome's own favicon request.
    if (/status of 40[13]/.test(m.text()) || (m.location()?.url ?? "").includes("favicon")) return;
    errors.push(`${label}: ${m.text()} [${m.location()?.url ?? ""}]`);
  });
  page.on("dialog", (d) => { errors.push(`${label}: unexpected dialog ${d.message()}`); void d.dismiss(); });
};
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const clickText = (page, sel, label) => page.evaluate((sel, label) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === label);
  if (el) el.click();
  return !!el;
}, sel, label);

async function devFormLogin(page, base, { oid, name, roles }) {
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#dev-form:not([hidden])");
  await page.type("#dev-oid", oid);
  await page.type("#dev-name", name);
  await page.$$eval("#dev-form input[type=checkbox]", (els, roles) => els.forEach((c) => { c.checked = roles.includes(c.value); }), roles);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => null),
    page.click("#dev-form button[type=submit]"),
  ]);
}

console.log("\n=== Admin portal + console: end-to-end ===\n");

/* ------------------------------------------------------------ admin signs in */
const adminCtx = await browser.createBrowserContext();
const admin = await adminCtx.newPage();
await admin.setViewport({ width: 1400, height: 900 });
watch(admin, "admin");
await admin.goto(`${ADMIN_BASE}/`, { waitUntil: "networkidle0" });
check("a signed-out visit to the admin portal lands on ITS sign-in page", admin.url().startsWith(`${ADMIN_BASE}/login`)
  && (await admin.title()).includes("Admin"));
await devFormLogin(admin, ADMIN_BASE, { oid: process.env.HDA_TEST_BOOTSTRAP_OID, name: "Suite Admin", roles: ["Admin"] });
await admin.waitForSelector(".tile");
check("the admin signs in and sees the overview", admin.url() === `${ADMIN_BASE}/` && (await text(admin, "#page-title")) === "Overview");
check("…with metric definitions next to the numbers", (await admin.$$eval(".tile .def", (d) => d.map((x) => x.textContent).join(" "))).includes("heartbeat"));
check("…and a development-sign-in badge (never shown under Entra)", !(await admin.$eval("#dev-badge", (e) => e.hidden)));

/* ------------------------------------------------ technician signs in → pending */
const techCtx = await browser.createBrowserContext();
const tech = await techCtx.newPage();
await tech.setViewport({ width: 1400, height: 900 });
watch(tech, "console");
const techOid = "13572468-0000-4000-8000-0000000000e1";
await devFormLogin(tech, BASE, { oid: techOid, name: "Priya Technician", roles: ["Agent"] });
await tech.waitForSelector("#message:not([hidden])");
check("a new technician is told their access is pending", (await text(tech, "#message")).includes("waiting for an administrator"));
check("…and stays on the sign-in page", tech.url().startsWith(`${BASE}/login`));

/* ------------------------------------------------------ admin activates in UI */
await admin.goto(`${ADMIN_BASE}/#/agents?status=pending`, { waitUntil: "networkidle0" });
await admin.waitForFunction(() => document.body.textContent.includes("Priya Technician"));
check("the pending request appears under Agents & access", true);
check("the page explains that Entra assignment happens in the Entra admin center",
  (await text(admin, ".callout")).includes("Entra admin center"));
await clickText(admin, "button", "Review & activate");
await admin.waitForSelector("dialog[open] #act-code");
await admin.type("#act-code", "AG-777");
await clickText(admin, "dialog[open] button", "Activate");
await admin.waitForFunction(() => document.getElementById("flash") && !document.getElementById("flash").hidden);
const priya = (await sql("SELECT status, agent_code FROM users WHERE entra_object_id = $1", [techOid]))[0];
check("activating in the UI makes the technician active with the agent ID", priya?.status === "active" && priya.agent_code === "AG-777");

/* --------------------------------------------------------- console session */
await devFormLogin(tech, BASE, { oid: techOid, name: "Priya Technician", roles: ["Agent"] });
await tech.waitForFunction(() => document.getElementById("agent-name")?.textContent === "Priya Technician", { timeout: 5000 });
check("the console header shows the verified identity", (await text(tech, "#agent-name")) === "Priya Technician"
  && (await text(tech, "#agent-meta")).includes("AG-777"));
check("the chat panel says chat is saved", (await tech.$eval("#chat-saved-notice", (e) => e.textContent)).includes("saved"));
await sleep(300);
check("the console sends a presence heartbeat",
  (await sql("SELECT last_heartbeat_at FROM users WHERE entra_object_id = $1", [techOid]))[0].last_heartbeat_at !== null);

await tech.click("#start-session");
await tech.waitForFunction(() => document.getElementById("code").textContent.trim() !== "------", { timeout: 5000 });
const code = await text(tech, "#code");
const host = new WebSocket(URL_WS);
host.received = [];
host.on("message", (d, bin) => host.received.push(bin ? { t: "<binary>" } : JSON.parse(d.toString())));
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code, machine: "PRIYA-CUSTOMER-PC", user: "sam", os: "Windows 11" }));
await sleep(300);
const connectRequest = host.received.find((m) => m.t === "host.connectRequest");
check("the customer's consent dialog names the verified technician", connectRequest?.agentName === "Priya Technician");
host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await tech.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected", { timeout: 5000 });

await tech.click("#toolbar-chat");
await tech.type("#chat-input", "Hi Sam, I can see your screen now.");
await tech.keyboard.press("Enter");
await sleep(300);
const payload = '<img src=x onerror="window.__xss=1"> please help';
host.send(JSON.stringify({ t: "host.chat", text: payload, clientId: "h-1" }));
await sleep(400);
check("technician and customer chat both ways", host.received.some((m) => m.t === "chat.message" && m.text === "Hi Sam, I can see your screen now."));

await tech.click("#toolbar-history");
await tech.type("#session-notes", "Mapped network drive; customer confirmed.");
await tech.click("#save-notes");
await tech.waitForFunction(() => document.getElementById("notes-saved-hint").textContent === "Saved", { timeout: 5000 });
check("notes are saved from the console", true);
await tech.click("#end-session");
await sleep(600);
const sid = (await sql("SELECT id FROM sessions WHERE customer_machine = 'PRIYA-CUSTOMER-PC'"))[0]?.id;
check("the session record exists under its UUID", !!sid);
check("the notes are durable", (await sql("SELECT body FROM session_notes WHERE session_id = $1", [sid]))[0]?.body === "Mapped network drive; customer confirmed.");

/* ----------------------------------------------------------- history/detail */
await admin.goto(`${ADMIN_BASE}/#/history?q=PRIYA`, { waitUntil: "networkidle0" });
await admin.waitForFunction(() => document.body.textContent.includes("PRIYA-CUSTOMER-PC"));
check("the ended session appears in history, searchable by device", true);
await admin.evaluate(() => [...document.querySelectorAll("tbody tr.clickable")][0].click());
await admin.waitForSelector("ol.timeline li");
const timeline = await admin.$$eval("ol.timeline li strong", (e) => e.map((x) => x.textContent));
check("the detail page shows the complete timeline", ["Session created, code issued", "Customer joined", "Consent accepted", "Notes saved", "Session ended"].every((t) => timeline.includes(t)), timeline.join(" | "));
check("…with the end reason", (await admin.evaluate(() => document.body.textContent)).includes("Ended by technician"));
await clickText(admin, "button", "View transcript");
await admin.waitForSelector(".chat .msg");
const msgs = await admin.$$eval(".chat .msg", (e) => e.map((x) => x.textContent));
check("the transcript shows both sides", msgs.some((m) => m.includes("I can see your screen")) && msgs.some((m) => m.includes("please help")));
check("a markup payload in chat is shown as text, not rendered", msgs.some((m) => m.includes("<img src=x")) && (await admin.$$(".chat img")).length === 0);
check("…and never executes", await admin.evaluate(() => window.__xss === undefined));
await clickText(admin, "button", "View notes");
await admin.waitForFunction(() => document.body.textContent.includes("Mapped network drive"));
check("the admin can read the technician's notes", true);

/* -------------------------------------------------------------- PDF export */
await clickText(admin, "button", "Download PDF report");
await admin.waitForSelector("dialog[open]");
await clickText(admin, "dialog[open] button", "Generate");
await admin.waitForFunction(() => location.hash.startsWith("#/reports"));
await admin.waitForFunction(() => [...document.querySelectorAll("a.btn")].some((a) => a.textContent === "Download"), { timeout: 10000 });
const dl = await admin.evaluate(async () => {
  const a = [...document.querySelectorAll("a.btn")].find((x) => x.textContent === "Download");
  const r = await fetch(a.href);
  const b = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, magic: String.fromCharCode(...b.slice(0, 5)), type: r.headers.get("content-type") };
});
check("the admin exports and downloads the session PDF", dl.status === 200 && dl.magic === "%PDF-" && dl.type === "application/pdf", JSON.stringify(dl));
await admin.goto(`${ADMIN_BASE}/#/audit`, { waitUntil: "networkidle0" });
await admin.waitForSelector("tbody tr");
const auditText = await admin.evaluate(() => document.querySelector("tbody").textContent);
check("the audit trail shows the activation, transcript view and report download",
  ["access.activated", "transcript.viewed", "report.downloaded"].every((a) => auditText.includes(a)));

/* ---------------------------------------------------- agent vs admin portal */
const intruderCtx = await browser.createBrowserContext();
const intruder = await intruderCtx.newPage();
watch(intruder, "intruder");
await devFormLogin(intruder, ADMIN_BASE, { oid: techOid, name: "Priya Technician", roles: ["Agent"] });
await intruder.waitForSelector("#message:not([hidden])");
check("an active Agent-only identity is refused by the admin portal", (await text(intruder, "#message")).includes("administrators, supervisors and auditors"));
await intruder.goto(`${ADMIN_BASE}/#/agents`, { waitUntil: "networkidle0" });
check("…and knowing a deep URL does not help", intruder.url().startsWith(`${ADMIN_BASE}/login`));
// From inside the console page, the admin API is another origin: the console's
// CSP (connect-src 'self') refuses the request before it leaves the browser.
const before = errors.length;
const probe = await tech.evaluate(async (u) => {
  try { return (await fetch(u, { credentials: "include" })).status; } catch { return "blocked"; }
}, `${ADMIN_BASE}/api/admin/me`);
check("the console page cannot even reach the admin API (CSP connect-src 'self')", probe === "blocked", String(probe));
errors.splice(before);  // the refusal is the expected outcome, not a page error

/* ------------------------------------------------------------- phone width */
await admin.setViewport({ width: 390, height: 844 });
await admin.goto(`${ADMIN_BASE}/#/overview`, { waitUntil: "networkidle0" });
await admin.waitForSelector(".tile");
const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("the admin portal has no horizontal page scroll at phone width", overflow <= 0, `${overflow}px`);
check("…and the menu button replaces the sidebar", await admin.$eval("#menu", (b) => getComputedStyle(b).display !== "none"));

check("no page errors in either application", errors.length === 0, errors.join(" | "));
host.close();
await browser.close();
report("admin portal end-to-end");
