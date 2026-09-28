/**
 * Multi-session console, end to end through the real relay: four sessions in
 * one console, each driven by its own applet-shaped host socket.
 *
 *   - tabs, 4/4 summary, New Session disabled at the limit, the limit dialog
 *   - keyboard and mouse reach ONLY the selected session's machine
 *   - switching releases keys still held on the session being left; the
 *     switch shortcut itself is never forwarded
 *   - per-session chat, unread badge, notification; per-session script draft
 *   - grid view: a click on another tile selects it and sends nothing
 *   - per-session disconnect; reload resumes every session; Disconnect all
 */
import { launch, openConsole } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();
console.log("\n=== Multi-session console ===\n");

/* --- four distinguishable JPEG frames --------------------------------------- */
const maker = await browser.newPage();
await maker.goto("about:blank");
const COLORS = ["#c03030", "#30a040", "#3050c0", "#c0a020"];
const frames = [];
for (const color of COLORS) {
  const b64 = await maker.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = 800; cv.height = 450;
    const x = cv.getContext("2d");
    x.fillStyle = c; x.fillRect(0, 0, 800, 450);
    return cv.toDataURL("image/jpeg", 0.8).split(",")[1];
  }, color);
  frames.push(Buffer.concat([Buffer.from([0x01]), Buffer.from(b64, "base64")]));
}
await maker.close();

const page = await openConsole(browser, BASE, { viewport: { width: 1600, height: 1000 } });
const errors = page.errors;
await page.waitForFunction(() => window.hdaSessions && window.hdaConsole?.me, { timeout: 5000 });

const list = () => page.evaluate(() => window.hdaSessions.list());
const tabCount = () => page.$$eval(".session-tab", (t) => t.length);
const keys = (host) => host.received.filter((m) => m.t === "agent.input" && m.kind === "key");
const mice = (host) => host.received.filter((m) => m.t === "agent.input" && m.kind === "mouse");

async function openHost() {
  const host = new WebSocket(URL_WS);
  host.received = [];
  host.closedWith = null;
  host.on("message", (d, bin) => host.received.push(bin ? { t: "<binary>" } : JSON.parse(d.toString())));
  host.on("close", (c) => { host.closedWith = c; });
  await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
  return host;
}

/** Start one more session from the console and connect a host to it. */
async function addSession(i, machine) {
  const before = await page.$eval("#code", (e) => e.textContent.trim());
  await page.click("#start-session");
  await page.waitForFunction((prev) => {
    const t = document.getElementById("code").textContent.trim();
    return /^[0-9]{6}$/.test(t) && t !== prev && !document.getElementById("code-block").hidden;
  }, { timeout: 5000 }, before);
  const code = await page.$eval("#code", (e) => e.textContent.trim());
  const host = await openHost();
  host.send(JSON.stringify({ t: "host.join", code, machine, user: `user${i}`, os: "Windows 11" }));
  await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Awaiting consent…", { timeout: 5000 });
  host.send(JSON.stringify({ t: "host.consent", accepted: true }));
  await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected", { timeout: 5000 });
  host.send(frames[i]);
  await page.waitForFunction(() => document.getElementById("remote").width === 800, { timeout: 5000 });
  await sleep(120);
  return { host, code, machine };
}

async function selectTab(machine) {
  await page.evaluate((m) => {
    const tab = [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === m);
    tab?.click();
  }, machine);
  await sleep(150);
}

async function clickCanvas(dx = 0.5, dy = 0.5) {
  const r = await page.$eval("#remote", (c) => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.click(r.x + r.w * dx, r.y + r.h * dy);
  await sleep(120);
}

/* ---------------------------------------------------------------- A: four */
console.log("[A] Four sessions in one console; the fifth is blocked");
const S = [];
for (let i = 0; i < 4; i++) S.push(await addSession(i, `PC-${"ABCD"[i]}`));
check("four tabs are shown", (await tabCount()) === 4);
const summary = await page.$eval("#session-summary", (e) => e.textContent);
check("the summary reads Active Sessions: 4 / 4", summary.includes("Active Sessions: 4 / 4"), summary);
check("New Session and + are disabled at 4 / 4",
  await page.evaluate(() => document.getElementById("start-session").disabled && document.getElementById("add-session").disabled));
check("all four hosts are still connected", S.every((s) => s.host.readyState === WebSocket.OPEN));
check("each tab names its own machine", JSON.stringify((await list()).map((s) => s.label)) === JSON.stringify(["PC-A", "PC-B", "PC-C", "PC-D"]));

// Force the button (as a stale page might) — the console still refuses and says why.
await page.evaluate(() => { const b = document.getElementById("start-session"); b.disabled = false; b.click(); });
await sleep(200);
const limitOpen = await page.$eval("#limit-modal", (d) => d.open);
check("a fifth attempt shows the 'Session limit reached' dialog", limitOpen);
check("…naming the limit", (await page.$eval("#limit-text", (e) => e.textContent)).includes("4"));
check("…and no fifth tab appeared", (await tabCount()) === 4);
await page.click("#limit-close");

/* ----------------------------------------------------------- B: isolation */
console.log("\n[B] Input reaches only the selected session");
for (const s of S) s.host.received.length = 0;
await selectTab("PC-B");
check("PC-B is selected and its canvas is #remote",
  (await list()).find((s) => s.selected)?.label === "PC-B"
  && await page.$eval("#remote", (c) => c.getContext("2d").getImageData(400, 200, 1, 1).data[1] > 120));
await clickCanvas();
await page.keyboard.press("KeyQ");
await sleep(250);
check("PC-B receives the click and the key", mice(S[1].host).some((m) => m.action === "down") && keys(S[1].host).some((k) => k.code === "KeyQ"));
check("PC-A, PC-C and PC-D receive nothing", [0, 2, 3].every((i) => S[i].host.received.filter((m) => m.t === "agent.input").length === 0));

for (const s of S) s.host.received.length = 0;
await selectTab("PC-D");
await clickCanvas(0.25, 0.25);
await page.keyboard.press("KeyZ");
await sleep(250);
check("after switching, PC-D receives input", keys(S[3].host).some((k) => k.code === "KeyZ"));
check("…and PC-B no longer does", S[1].host.received.filter((m) => m.t === "agent.input").length === 0);

console.log("\n[C] Switching releases held keys; the shortcut is never forwarded");
for (const s of S) s.host.received.length = 0;
await page.keyboard.down("ControlLeft");
await page.keyboard.down("ShiftLeft");
await sleep(80);
await page.keyboard.press("Digit1");   // Ctrl+Shift+1 → session 1
await page.keyboard.up("ShiftLeft");
await page.keyboard.up("ControlLeft");
await sleep(250);
check("Ctrl+Shift+1 selects session 1", (await list()).find((s) => s.selected)?.label === "PC-A");
const dKeys = keys(S[3].host);
check("PC-D got Ctrl and Shift released when it was left",
  dKeys.some((k) => k.code === "ControlLeft" && k.action === "up") && dKeys.some((k) => k.code === "ShiftLeft" && k.action === "up"),
  JSON.stringify(dKeys.map((k) => `${k.code}:${k.action}`)));
check("the Digit1 of the shortcut reached no machine", S.every((s) => !keys(s.host).some((k) => k.code === "Digit1")));

/* ---------------------------------------------------------------- D: chat */
console.log("\n[D] Chat, unread and drafts are per session");
S[2].host.send(JSON.stringify({ t: "host.chat", text: "help from PC-C", clientId: "hc-1" }));
await sleep(500);
const badge = await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === "PC-C");
  const b = tab.querySelector(".st-badge");
  return b.hidden ? null : b.textContent;
});
check("an inactive session with a new message shows an unread badge (1)", badge === "1", String(badge));
const toastText = await page.$eval("#toasts", (t) => t.textContent);
check("…and a notification names the session", toastText.includes("PC-C"), toastText);
check("the selected session (PC-A) did not switch on its own", (await list()).find((s) => s.selected)?.label === "PC-A");
await page.click("#tab-chat");
check("PC-A's chat does not contain PC-C's message", !(await page.$eval("#chat-log", (l) => l.textContent)).includes("help from PC-C"));
await page.type("#chat-input", "draft for A");
await page.click("#tab-scripts");
await page.type("#script", "Get-Process # for A");
await selectTab("PC-C");
check("PC-C's chat shows its own message", (await page.$eval("#chat-log", (l) => l.textContent)).includes("help from PC-C"));
check("the script draft typed for PC-A is not in PC-C's script box", (await page.$eval("#script", (e) => e.value)) === "");
await page.click("#tab-chat");
check("PC-C's composer does not hold PC-A's draft", (await page.$eval("#chat-input", (e) => e.value)) === "");
check("opening PC-C's chat clears its badge", await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === "PC-C");
  return tab.querySelector(".st-badge").hidden;
}));
await page.type("#chat-input", "reply to C");
await page.keyboard.press("Enter");
await sleep(500);
check("a chat sent in PC-C reaches only PC-C", S[2].host.received.some((m) => m.t === "chat.message" && m.text === "reply to C")
  && [0, 1, 3].every((i) => !S[i].host.received.some((m) => m.t === "chat.message")));
await selectTab("PC-A");
check("returning to PC-A restores its drafts", (await page.$eval("#chat-input", (e) => e.value)) === "draft for A"
  && (await page.$eval("#script", (e) => e.value)) === "Get-Process # for A");

/* ---------------------------------------------------------------- E: grid */
console.log("\n[E] Grid view is for monitoring; control needs an explicit selection");
await page.click("#layout-grid");
await sleep(250);
const grid = await page.evaluate(() => ({
  layout: document.querySelector(".canvas-wrap").dataset.layout,
  visible: [...document.querySelectorAll(".session-tile[data-owner]")].filter((t) => t.getBoundingClientRect().width > 50).length,
  control: [...document.querySelectorAll(".session-tile.is-selected .tile-control")].filter((e) => getComputedStyle(e).display !== "none").length,
}));
check("grid shows all four sessions", grid.layout === "grid" && grid.visible === 4, JSON.stringify(grid));
check("exactly one tile is marked CONTROL ACTIVE", grid.control === 1);
for (const s of S) s.host.received.length = 0;
const tileB = await page.evaluate(() => {
  const tile = [...document.querySelectorAll(".session-tile[data-owner]")].find((t) => t.querySelector(".tile-name").textContent === "PC-B");
  const r = tile.querySelector("canvas").getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(tileB.x, tileB.y);
await sleep(250);
check("clicking PC-B's tile selects it", (await list()).find((s) => s.selected)?.label === "PC-B");
check("…and sends nothing to PC-B (or anyone)", S.every((s) => mice(s.host).length === 0));
await page.mouse.click(tileB.x, tileB.y);
await sleep(250);
check("a second click, now that PC-B has control, reaches PC-B only",
  mice(S[1].host).some((m) => m.action === "down") && [0, 2, 3].every((i) => mice(S[i].host).length === 0));
await page.click("#layout-tabs");
await sleep(150);

/* ------------------------------------------------------ F: one disconnect */
console.log("\n[F] Disconnecting one session leaves the others alone");
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".session-tab")].find((t) => t.querySelector(".st-name").textContent === "PC-C");
  tab.querySelector(".st-close").click();
});
await sleep(600);
check("PC-C's customer side is closed", S[2].host.closedWith !== null);
check("PC-A, PC-B and PC-D stay connected", [0, 1, 3].every((i) => S[i].host.readyState === WebSocket.OPEN));
check("three tabs remain, summary 3 / 4", (await tabCount()) === 3 && (await page.$eval("#session-summary", (e) => e.textContent)).includes("3 / 4"));
check("New Session is available again", await page.evaluate(() => !document.getElementById("start-session").disabled));

/* ------------------------------------------------------------- G: reload */
console.log("\n[G] A page reload resumes every session");
const selectedBefore = (await list()).find((s) => s.selected)?.label;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.hdaSessions?.list().length === 3
  && window.hdaSessions.list().every((s) => s.state === "connected"), { timeout: 10000 }).catch(() => {});
const after = await list();
check("all three sessions come back connected", after.length === 3 && after.every((s) => s.state === "connected"), JSON.stringify(after.map((s) => s.state)));
check("the customers never noticed", [0, 1, 3].every((i) => S[i].host.readyState === WebSocket.OPEN));
check("each resumed session knows its machine", JSON.stringify(after.map((s) => s.label).sort()) === JSON.stringify(["PC-A", "PC-B", "PC-D"]));
await page.waitForFunction(() => document.getElementById("remote").width === 800, { timeout: 7000 }).catch(() => {});
check("the selected session's picture is restored from the relay", await page.$eval("#remote", (c) => c.width === 800));
for (const s of S) s.host.received.length = 0;
await selectTab("PC-D");
await clickCanvas();
await page.keyboard.press("KeyR");
await sleep(250);
check("input after the reload reaches the right machine only",
  keys(S[3].host).some((k) => k.code === "KeyR") && [0, 1].every((i) => !keys(S[i].host).some((k) => k.code === "KeyR")));
void selectedBefore;

/* -------------------------------------------------------- H: disconnect all */
console.log("\n[H] Disconnect all asks first, then ends every session");
await page.click("#disconnect-all");
await sleep(150);
check("a confirmation dialog opens", await page.$eval("#disconnect-all-modal", (d) => d.open));
check("…stating how many sessions", (await page.$eval("#disconnect-all-text", (e) => e.textContent)).includes("3"));
await page.click("#disconnect-all-cancel");
await sleep(200);
check("Cancel ends nothing", (await tabCount()) === 3 && [0, 1, 3].every((i) => S[i].host.readyState === WebSocket.OPEN));
await page.click("#disconnect-all");
await sleep(150);
await page.click("#disconnect-all-confirm");
await sleep(800);
check("confirming ends every session", [0, 1, 3].every((i) => S[i].host.closedWith !== null));
check("the console is back to idle", (await tabCount()) === 0
  && (await page.$eval("#status", (e) => e.textContent.trim())) === "Session ended"
  && await page.evaluate(() => document.body.dataset.session === "none"));
check("nothing is left to resume after a reload", await page.evaluate(() => sessionStorage.getItem("hda.sessions.v1") === null));

check("no uncaught page errors", errors.length === 0, errors.join(" | "));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
check("no horizontal page overflow", !overflow);

for (const s of S) { try { s.host.close(); } catch {} }
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
