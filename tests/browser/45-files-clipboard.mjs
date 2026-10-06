/**
 * Platform 2.0, Phase 2b in the real console, through the real relay, against
 * an applet-shaped host (tests/lib/mock-features.mjs):
 *
 *   - buttons follow capabilities: an old applet greys them out with the reason
 *   - file manager: browse, upload (file picker), download, new folder, rename,
 *     delete, transfer list with progress and result
 *   - clipboard: send, get, and the fields are empty again after closing
 *   - system details collected on request and rendered as text
 *   - Stop ends a running user-level script
 *   - per-session: B's file manager never shows A's folder or transfers
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { launch, openConsole } from "../lib/browser.mjs";
import { BASE, URL_WS, WebSocket, sleep } from "../lib/harness.mjs";
import { CAPS, attachFeatures } from "../lib/mock-features.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const SHOTS = process.env.HDA_SHOTS ?? null;

console.log("\n=== Platform 2.0 Phase 2b — file manager, clipboard, system details, stop ===\n");

const browser = await launch();
const page = await openConsole(browser, BASE, { viewport: { width: 1440, height: 900 } });
const downloads = mkdtempSync(path.join(tmpdir(), "hda-dl-"));
await (await page.createCDPSession()).send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
const prompts = [];
page.on("dialog", async (d) => { prompts.push(d.message()); await d.accept(d.type() === "prompt" ? (globalThis.nextPrompt ?? "") : undefined); });
await page.waitForFunction(() => window.hdaConsole?.me && window.hdaSessions, { timeout: 5000 });

async function connect(machine, { caps = CAPS, version = 2 } = {}) {
  const n = await page.evaluate(() => window.hdaSessions.list().length);
  await page.click("#start-session");
  // The newest session must itself be waiting (it has its own code by then);
  // until then #code still holds the previous session's code.
  await page.waitForFunction((k) => {
    const list = window.hdaSessions.list();
    return list.length === k + 1 && list[k].state === "waiting" && list[k].selected && /^[0-9]{6}$/.test(document.getElementById("code").textContent.trim());
  }, { timeout: 5000 }, n);
  const code = await page.$eval("#code", (e) => e.textContent.trim());
  const host = new WebSocket(URL_WS);
  host.received = [];
  host.on("message", (d, bin) => { if (!bin) host.received.push(JSON.parse(d.toString())); });
  await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
  host.send(JSON.stringify({ t: "host.join", code, machine, user: "customer", os: "Windows 11", ...(version ? { protocolVersion: version, capabilities: caps } : {}) }));
  await sleep(250);
  host.send(JSON.stringify({ t: "host.consent", accepted: true }));
  await page.waitForFunction((m) => window.hdaSessions.list().some((s) => s.label === m && s.state === "connected"), { timeout: 5000 }, machine)
    .catch(async (e) => { console.log("host saw:", JSON.stringify(host.received), await page.evaluate(() => JSON.stringify(window.hdaSessions.list()))); throw e; });
  const root = mkdtempSync(path.join(tmpdir(), "hda-mock-"));
  mkdirSync(path.join(root, "Documents"), { recursive: true });
  writeFileSync(path.join(root, "Documents", `${machine}-report.txt`), `report from ${machine}`);
  const mock = version ? attachFeatures(host, root) : null;
  return { host, root, mock };
}
const btn = (id) => page.$eval(`#${id}`, (b) => ({ disabled: b.disabled, title: b.title }));
const selectByLabel = (label) => page.evaluate((l) => [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === l)?.click(), label);

/* --- 1. capabilities ----------------------------------------------------------------- */
console.log("[45] capabilities");
const old = await connect("OLD-PC", { version: 0 });
for (const id of ["toolbar-files", "toolbar-clipboard", "toolbar-sysinfo"]) {
  const b = await btn(id);
  check(`old applet: #${id} disabled and says why`, b.disabled && /older and does not support this/.test(b.title), b.title);
}
const a = await connect("PC-ALPHA");
for (const id of ["toolbar-files", "toolbar-clipboard", "toolbar-sysinfo"]) check(`v2 applet: #${id} enabled`, !(await btn(id)).disabled);

/* --- 2. file manager ------------------------------------------------------------------ */
console.log("\n[45] file manager");
await page.click("#toolbar-files");
await page.waitForFunction(() => document.getElementById("files-modal").open, { timeout: 3000 });
await page.waitForFunction(() => /Documents/.test(document.querySelector("#files-list tbody").textContent), { timeout: 4000 }).catch(() => {});
check("the start view lists drives and folders", /Local Disk \(C:\)/.test(await page.$eval("#files-list tbody", (t) => t.textContent)));
await page.evaluate(() => [...document.querySelectorAll(".files-name")].find((b) => b.textContent.includes("Documents")).click());
await page.waitForFunction(() => /PC-ALPHA-report\.txt/.test(document.querySelector("#files-list tbody").textContent), { timeout: 4000 }).catch(() => {});
check("opening a folder lists its files", await page.$eval("#files-path", (i) => i.value === "C:\\Documents"));
check("file names render as text (no markup from the remote side)", await page.$$eval("#files-list tbody .files-name", (bs) => bs.every((b) => b.children.length === 1)));

const upFile = path.join(mkdtempSync(path.join(tmpdir(), "hda-up-")), "patch notes.txt");
const upBytes = Buffer.alloc(130_000, 65);
writeFileSync(upFile, upBytes);
const input = await page.$("#files-input");
await input.uploadFile(upFile);
await page.waitForFunction(() => [...document.querySelectorAll(".files-transfer")].some((t) => t.dataset.status === "completed"), { timeout: 8000 }).catch(() => {});
const arrived = path.join(a.root, "Documents", "patch notes.txt");
check("upload: the file arrives in the open remote folder, intact", existsSync(arrived) && readFileSync(arrived).equals(upBytes));
const tUp = await page.$eval(".files-transfer", (t) => ({ status: t.dataset.status, text: t.textContent }));
check("the transfer list shows it completed, with where it was saved", tUp.status === "completed" && /Saved as C:\\Documents\\patch notes\.txt/.test(tUp.text), tUp.text);
await sleep(400);
check("the remote list refreshes to include it", /patch notes\.txt/.test(await page.$eval("#files-list tbody", (t) => t.textContent)));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/files.png` });

await page.evaluate(() => [...document.querySelectorAll("#files-list tbody tr")].find((r) => r.textContent.includes("PC-ALPHA-report.txt")).querySelector(".files-name").click());
let dl = null;
for (let i = 0; i < 40 && !dl; i++) { await sleep(100); dl = readdirSync(downloads).find((f) => f === "PC-ALPHA-report.txt"); }
check("download: the browser saves the remote file, intact", !!dl && readFileSync(path.join(downloads, dl), "utf8") === "report from PC-ALPHA");

globalThis.nextPrompt = "Archive";
await page.click("#files-mkdir");
await page.waitForFunction(() => /Archive/.test(document.querySelector("#files-list tbody").textContent), { timeout: 4000 }).catch(() => {});
check("new folder", existsSync(path.join(a.root, "Documents", "Archive")));
globalThis.nextPrompt = "Archive 2025";
await page.evaluate(() => [...document.querySelectorAll("#files-list tbody tr")].find((r) => r.querySelector(".files-name")?.textContent === "Archive").querySelectorAll(".files-actions .btn")[0].click());
await page.waitForFunction(() => /Archive 2025/.test(document.querySelector("#files-list tbody").textContent), { timeout: 4000 }).catch(() => {});
check("rename", existsSync(path.join(a.root, "Documents", "Archive 2025")));
await page.evaluate(() => [...document.querySelectorAll("#files-list tbody tr")].find((r) => r.querySelector(".files-name")?.textContent === "Archive 2025").querySelectorAll(".files-actions .btn")[1].click());
await sleep(600);
check("delete (after a confirmation naming the item)", !existsSync(path.join(a.root, "Documents", "Archive 2025")) && prompts.some((p) => /Delete "Archive 2025"/.test(p)));
check("the activity log records the file actions", /Upload completed: patch notes\.txt/.test(await page.$eval("#session-events", (e) => e.textContent)));
await page.click("#files-close");

/* --- 3. isolation ------------------------------------------------------------------------ */
console.log("\n[45] isolation");
const b = await connect("PC-BRAVO");
await page.click("#toolbar-files");
await sleep(600);
const bView = await page.evaluate(() => ({ path: document.getElementById("files-path").value, list: document.querySelector("#files-list tbody").textContent, transfers: document.getElementById("files-transfers").textContent }));
check("B's file manager starts at B's own start view, with none of A's folder or transfers",
  bView.path === "" && !/patch notes/.test(bView.transfers) && !/PC-ALPHA/.test(bView.list), JSON.stringify(bView).slice(0, 200));
await page.click("#files-close");
await selectByLabel("PC-ALPHA");
await sleep(150);
await page.click("#toolbar-files");
await sleep(500);
check("…and A's view comes back as A left it", (await page.$eval("#files-path", (i) => i.value)) === "C:\\Documents" && /patch notes/.test(await page.$eval("#files-transfers", (e) => e.textContent)));
await page.click("#files-close");

/* --- 4. clipboard --------------------------------------------------------------------------- */
console.log("\n[45] clipboard");
await page.click("#toolbar-clipboard");
await page.type("#clip-send-text", "net use Z: \\\\fs01\\share");
await page.click("#clip-send");
await page.waitForFunction(() => /Sent/.test(document.getElementById("clip-status").textContent), { timeout: 3000 }).catch(() => {});
check("send to remote clipboard", a.mock.clipboard === "net use Z: \\\\fs01\\share");
a.mock.clipboard = "remote secret <b>text</b>";
await page.click("#clip-get");
await page.waitForFunction(() => document.getElementById("clip-remote-text").value.length > 0, { timeout: 3000 }).catch(() => {});
check("get remote clipboard (shown as plain text)", (await page.$eval("#clip-remote-text", (t) => t.value)) === "remote secret <b>text</b>");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/clipboard.png` });
await page.click("#clip-close");
check("closing clears both fields", await page.evaluate(() => document.getElementById("clip-send-text").value === "" && document.getElementById("clip-remote-text").value === ""));
check("clipboard text is not left in web storage", await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes("remote secret")));

/* --- 5. system details ------------------------------------------------------------------------ */
console.log("\n[45] system details");
await page.click("#toolbar-sysinfo");
await page.waitForFunction(() => /Mock CPU/.test(document.getElementById("system-details").textContent), { timeout: 4000 }).catch(() => {});
const sys = await page.$eval("#system-details", (e) => e.textContent);
check("the System toolbar button opens System and collects", /Windows\s*Windows 11 Pro 23H2/.test(sys) && /Memory\s*16\.0 GB \(9\.0 GB free\)/.test(sys) && /Uptime\s*1 d 2 h/.test(sys), sys.slice(0, 300));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/system.png` });

/* --- 6. stop a script ---------------------------------------------------------------------------- */
console.log("\n[45] stop a script");
await page.click("#tab-scripts");
await page.$eval("#script", (t) => { t.value = "Start-Sleep 600"; });
await page.click("#run-script");
await page.waitForFunction(() => !document.getElementById("stop-script").disabled, { timeout: 3000 }).catch(() => {});
check("Stop is enabled while a user-level script runs", !(await btn("stop-script")).disabled);
await page.click("#stop-script");
await page.waitForFunction(() => /stopped by the technician/.test(document.getElementById("script-output").textContent), { timeout: 4000 }).catch(() => {});
check("Stop ends it, and the output says so", /stopped by the technician/.test(await page.$eval("#script-output", (e) => e.textContent)));
check("Stop is disabled again", (await btn("stop-script")).disabled);
await page.$eval("#script", (t) => { t.value = "Start-Sleep 600"; });
await page.click("#as-system");
await page.click("#run-script");
await page.waitForFunction(() => /^Running/.test(document.getElementById("script-status").textContent), { timeout: 3000 }).catch(() => {});
const sysStop = await btn("stop-script");
check("a running SYSTEM script cannot be stopped from here, and Stop says why",
  sysStop.disabled && /SYSTEM script runs in the elevated service/.test(sysStop.title), JSON.stringify(sysStop));

/* --- 7. customer reconnect (Phase 3) ------------------------------------------------------- */
console.log("\n[45] customer reconnect");
const r = await connect("PC-ROAM", { caps: [...CAPS, "resume"] });
const tokenMsg = await (async () => { for (let i = 0; i < 30; i++) { const m = r.host.received.find((x) => x.t === "host.resumeToken"); if (m) return m; await sleep(50); } return null; })();
r.host.terminate();
await page.waitForFunction(() => [...document.querySelectorAll(".session-tab")].some((t) => /Customer reconnecting/.test(t.textContent)), { timeout: 4000 }).catch(() => {});
check("the tab says Customer reconnecting", await page.evaluate(() => [...document.querySelectorAll(".session-tab")].some((t) => /PC-ROAM/.test(t.textContent) && /Customer reconnecting/.test(t.textContent))));
check("…the status pill too", /Customer reconnecting/.test(await page.$eval("#status", (e) => e.textContent)));
const away = await btn("toolbar-files");
check("tools are disabled meanwhile, and say why", away.disabled && /reconnecting/.test(away.title), away.title);
check("…as are scripts", await page.$eval("#scripting", (f) => f.disabled));
const back = new WebSocket(URL_WS);
back.received = [];
back.on("message", (d, bin) => { if (!bin) back.received.push(JSON.parse(d.toString())); });
await new Promise((res) => back.once("open", res));
back.send(JSON.stringify({ t: "host.resume", sessionId: tokenMsg?.sessionId, resumeToken: tokenMsg?.resumeToken }));
await page.waitForFunction(() => /^Connected$/.test(document.getElementById("status").textContent.trim()), { timeout: 4000 }).catch(() => {});
check("when the applet resumes, the session is Connected again", (await page.$eval("#status", (e) => e.textContent.trim())) === "Connected");
check("…and the tools come back", !(await btn("toolbar-files")).disabled);
check("the chat log shows both system lines", /Customer connection lost — reconnecting[\s\S]*Customer reconnected/.test(await page.$eval("#chat-log", (e) => e.textContent)));
back.close();

check("no uncaught page errors", page.errors.length === 0, page.errors.join(" | "));
await page.evaluate(() => document.getElementById("disconnect-all").click());
await page.click("#disconnect-all-confirm");
await sleep(400);
for (const x of [old, a, b]) x.host.close();
await browser.close();
void createHash;
console.log(`\n--- browser/45 files & clipboard: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
