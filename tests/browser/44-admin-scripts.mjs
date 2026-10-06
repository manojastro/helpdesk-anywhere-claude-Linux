/**
 * Platform 2.0, Phase 2 — the admin portal's Script library page, as an Admin
 * and as an Auditor: list, create (new script appears for technicians), edit
 * makes a new version, archive hides it; markup in names stays text; the
 * Auditor sees the library read-only.
 */
import { ADMIN_BASE, client, ensureActiveUser } from "../lib/auth.mjs";
import { launch, setSessionCookie } from "../lib/browser.mjs";
import { sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
console.log("\n=== Admin portal — Script library ===\n");

const adminCookie = process.env.HDA_ADMIN_COOKIE;
const agentApi = client("agent", process.env.HDA_AGENT_COOKIE);
const browser = await launch();

async function openAdmin(cookie) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await setSessionCookie(page, ADMIN_BASE, cookie);
  await page.goto(`${ADMIN_BASE}/#/scripts`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("page-title").textContent === "Script library", { timeout: 5000 });
  return page;
}

const page = await openAdmin(adminCookie);
check("the nav has Script library", await page.$$eval("#nav a", (as) => as.some((a) => a.textContent === "Script library" && !a.hidden)));
const rows = () => page.$$eval("#view tbody tr", (trs) => trs.map((t) => t.textContent));
check("built-ins are listed", (await rows()).some((r) => /Disk space/.test(r) && /Built-in/.test(r)));

await page.click("#view .btn-primary");
await page.waitForSelector("dialog[open]");
const fields = await page.$$("dialog[open] input");
await fields[0].type("<b>Bold</b> check");
await fields[1].type("Checks the time");
const textarea = await page.$("dialog[open] textarea");
await textarea.type("time /t");
const [, shellSel] = await page.$$("dialog[open] select");
await shellSel.select("cmd");
await page.evaluate(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Create").click());
await page.waitForFunction(() => !document.querySelector("dialog[open]"), { timeout: 4000 });
await sleep(400);
check("a new script is created and listed", (await rows()).some((r) => /<b>Bold<\/b> check/.test(r) && /v1/.test(r)));
check("markup in the name is shown literally, not rendered", await page.evaluate(() => !document.querySelector("#view tbody b")));
const lib = await agentApi.get("/scripts");
const created = lib.data.items.find((s) => s.name === "<b>Bold</b> check");
check("technicians see it in the console library", !!created && created.shell === "cmd" && created.body === "time /t");

await page.evaluate(() => [...document.querySelectorAll("#view tbody tr")].find((t) => /Bold<\/b> check/.test(t.textContent)).click());
await page.waitForSelector("dialog[open]");
await page.$eval("dialog[open] textarea", (t) => { t.value = "time /t\ndate /t"; });
await page.evaluate(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Save new version").click());
await page.waitForFunction(() => !document.querySelector("dialog[open]"), { timeout: 4000 });
await sleep(400);
check("saving makes v2", (await rows()).some((r) => /Bold<\/b> check/.test(r) && /v2/.test(r)));

await page.evaluate(() => [...document.querySelectorAll("#view tbody tr")].find((t) => /Bold<\/b> check/.test(t.textContent)).click());
await page.waitForSelector("dialog[open]");
await page.evaluate(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Archive").click());
await page.waitForFunction(() => !document.querySelector("dialog[open]"), { timeout: 4000 });
await sleep(400);
check("archive marks it archived in the list", (await rows()).some((r) => /Bold<\/b> check/.test(r) && /archived/.test(r)));
check("…and it is gone from the technicians' library", !(await agentApi.get("/scripts")).data.items.some((s) => s.id === created?.id));
check("no page errors (admin)", page.errors.length === 0, page.errors.join(" | "));

const audCookie = await ensureActiveUser(adminCookie, { objectId: "cdcdcdcd-0000-4000-8000-0000000000c1", name: "Ida Auditor", roles: ["Auditor"], agentCode: "AUD-9" }, "admin");
const aud = await openAdmin(audCookie);
check("an Auditor sees the library", (await aud.$$eval("#view tbody tr", (t) => t.length)) >= 10);
check("…without a New script button", !(await aud.$("#view .btn-primary")));
await aud.evaluate(() => document.querySelector("#view tbody tr").click());
await aud.waitForSelector("dialog[open]");
check("…and the script dialog is read-only for them", await aud.evaluate(() =>
  [...document.querySelectorAll("dialog[open] input, dialog[open] textarea, dialog[open] select")].every((e) => e.disabled)
  && ![...document.querySelectorAll("dialog[open] button")].some((b) => /Save|Archive|Create/.test(b.textContent))));
check("no page errors (auditor)", aud.errors.length === 0, aud.errors.join(" | "));

await browser.close();
console.log(`\n--- browser/44 admin scripts: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
