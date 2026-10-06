/**
 * Platform 2.0, Phase 6 in the real console, through the real relay:
 *
 *   - Monitor and Stream quality follow capabilities (an old applet: disabled, says why)
 *   - Monitor selection frames one monitor of the picture the console already has,
 *     and a click on it still lands on the right REMOTE pixel (the mapping is the
 *     canvas's bounding box, which framing deliberately leaves spanning the desktop);
 *     the other monitor is clipped and takes no clicks
 *   - All monitors / a fixed zoom / a smaller layout undo the framing
 *   - Quality sends agent.quality, shows only what the applet CONFIRMED, and stays
 *     usable while the session is held
 */
import { mkdirSync } from "node:fs";

import { launch, openConsole } from "../lib/browser.mjs";
import { BASE, URL_WS, WebSocket, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const SHOTS = process.env.HDA_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

console.log("\n=== Platform 2.0 Phase 6 — stream quality and monitor selection ===\n");

const browser = await launch();

// A 3840×1080 "virtual screen": monitor 1 dark red, monitor 2 dark blue.
const maker = await browser.newPage();
const b64 = await maker.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 3840; c.height = 1080;
  const x = c.getContext("2d");
  x.fillStyle = "#602020"; x.fillRect(0, 0, 1920, 1080);
  x.fillStyle = "#203060"; x.fillRect(1920, 0, 1920, 1080);
  return c.toDataURL("image/jpeg", 0.6).split(",")[1];
});
await maker.close();
const frame = Buffer.concat([Buffer.from([0x01]), Buffer.from(b64, "base64")]);
const LAYOUT = { t: "host.monitors", width: 3840, height: 1080, monitors: [
  { index: 1, primary: true, x: 0, y: 0, width: 1920, height: 1080 },
  { index: 2, primary: false, x: 1920, y: 0, width: 1920, height: 1080 },
] };

const page = await openConsole(browser, BASE, { viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.waitForFunction(() => window.hdaConsole?.me && window.hdaSessions, { timeout: 5000 });

async function connect(machine, caps) {
  const n = await page.evaluate(() => window.hdaSessions.list().length);
  await page.click("#start-session");
  await page.waitForFunction((k) => {
    const list = window.hdaSessions.list();
    return list.length === k + 1 && list[k].state === "waiting" && list[k].selected && /^[0-9]{6}$/.test(document.getElementById("code").textContent.trim());
  }, { timeout: 5000 }, n);
  const code = await page.$eval("#code", (e) => e.textContent.trim());
  const host = new WebSocket(URL_WS);
  host.received = [];
  host.on("message", (d, bin) => { if (!bin) host.received.push(JSON.parse(d.toString())); });
  await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
  host.send(JSON.stringify({ t: "host.join", code, machine, user: "customer", os: "Windows 11", ...(caps ? { protocolVersion: 2, capabilities: caps } : {}) }));
  await sleep(250);
  host.send(JSON.stringify({ t: "host.consent", accepted: true }));
  await page.waitForFunction((m) => window.hdaSessions.list().some((s) => s.label === m && s.state === "connected"), { timeout: 5000 }, machine);
  return host;
}
const btn = (id) => page.$eval(`#${id}`, (b) => ({ disabled: b.disabled, title: b.title, badge: b.querySelector(".btn-badge")?.hidden ? "" : b.querySelector(".btn-badge")?.textContent ?? "" }));
const canvasState = () => page.$eval("#remote", (c) => {
  const r = c.getBoundingClientRect();
  const w = c.closest(".canvas-wrap").getBoundingClientRect();
  return { monitor: c.dataset.monitor ?? null, x: r.x, y: r.y, w: r.width, h: r.height, bw: c.width, bh: c.height,
    wrap: { x: w.x, y: w.y, w: w.width, h: w.height }, styleWidth: c.style.width };
});

/* --- 1. capabilities ----------------------------------------------------------- */
console.log("[47] capabilities");
const old = await connect("OLD-PC", null);
for (const id of ["toolbar-monitor", "toolbar-quality"]) {
  const b = await btn(id);
  check(`old applet: #${id} disabled and says why`, b.disabled && /older/.test(b.title), b.title);
}
old.send(JSON.stringify({ t: "host.monitors", ...LAYOUT }));

const host = await connect("DUAL-PC", ["quality", "monitors"]);
check("v2 applet before its layout arrives: Monitor waits for it", /Waiting for the customer's monitor layout/.test((await btn("toolbar-monitor")).title));
check("v2 applet: Stream quality enabled, High (10 fps)", !(await btn("toolbar-quality")).disabled && /High \(10 fps\)/.test((await btn("toolbar-quality")).title), (await btn("toolbar-quality")).title);
host.send(frame);
await page.waitForFunction(() => document.getElementById("remote").width === 3840, { timeout: 5000 });
host.send(JSON.stringify(LAYOUT));
await page.waitForFunction(() => !document.getElementById("toolbar-monitor").disabled, { timeout: 3000 });
check("with two monitors reported, Monitor is enabled", /showing all 2 monitors/.test((await btn("toolbar-monitor")).title), (await btn("toolbar-monitor")).title);

/* --- 2. monitor framing ---------------------------------------------------------- */
console.log("\n[47] monitor selection");
await page.click("#toolbar-monitor");
const items = await page.$$eval("#monitor-menu [role=menuitemradio]", (bs) => bs.map((b) => ({ text: b.textContent, checked: b.getAttribute("aria-checked") })));
check("the menu lists All + each monitor, All checked", items.length === 3 && /All monitors/.test(items[0].text) && items[0].checked === "true" && /Monitor 1 \(primary\)/.test(items[1].text) && /Monitor 2/.test(items[2].text), JSON.stringify(items));
const whole = await canvasState();
if (SHOTS) await page.screenshot({ path: `${SHOTS}/47-menu.png` });
await page.click('#monitor-menu [data-monitor="2"]');
await sleep(150);
const framed = await canvasState();
check("Monitor 2 is framed", framed.monitor === "2");
check("…the monitor is displayed larger than in the whole-desktop view", framed.w > whole.w * 1.5, `${Math.round(whole.w)} → ${Math.round(framed.w)}`);
// The visible monitor: the right half of the element box.
const mon = { x: framed.x + framed.w / 2, y: framed.y, w: framed.w / 2, h: framed.h };
check("…and fits inside the viewport",
  mon.x >= framed.wrap.x - 1 && mon.x + mon.w <= framed.wrap.x + framed.wrap.w + 1 && mon.y >= framed.wrap.y - 1 && mon.y + mon.h <= framed.wrap.y + framed.wrap.h + 1,
  JSON.stringify({ mon, wrap: framed.wrap }));
check("the canvas's backing store is untouched (input maps against it)", framed.bw === 3840 && framed.bh === 1080);
check("the button shows which monitor", (await btn("toolbar-monitor")).badge === "2" && /monitor 2 of 2/.test((await btn("toolbar-monitor")).title));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/47-monitor2.png` });

const downs = () => host.received.filter((m) => m.t === "agent.input" && m.action === "down");
let before = downs().length;
await page.mouse.click(mon.x + mon.w / 2, mon.y + mon.h / 2);
await sleep(250);
const hit = downs()[before];
check("a click in the middle of monitor 2 lands in the middle of monitor 2 on the remote",
  hit && Math.abs(hit.x - 2880) <= 6 && Math.abs(hit.y - 540) <= 6, hit ? `(${hit.x},${hit.y}) want ~(2880,540)` : "no input");
before = downs().length;
await page.mouse.click(mon.x + 3, mon.y + 3);
await sleep(250);
const corner = downs()[before];
check("…its top-left corner lands at monitor 2's origin", corner && Math.abs(corner.x - 1920) <= 8 && corner.y <= 8, corner ? `(${corner.x},${corner.y})` : "no input");
const clipped = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.id ?? null, mon.x - 20, mon.y + mon.h / 2);
check("monitor 1, beside it, is clipped and takes no click", clipped !== "remote", String(clipped));

await page.click("#toolbar-monitor");
await page.click('#monitor-menu [data-monitor="0"]');
await sleep(150);
const back = await canvasState();
check("All monitors restores the whole desktop", back.monitor === null && back.styleWidth === "" && Math.abs(back.w - whole.w) < 2, `${Math.round(back.w)} vs ${Math.round(whole.w)}`);

await page.click("#toolbar-monitor");
await page.click('#monitor-menu [data-monitor="1"]');
await sleep(100);
await page.select("#zoom", "1");
await sleep(150);
check("a fixed zoom shows the whole desktop again (framing is a Fit view)", (await canvasState()).monitor === null && (await page.evaluate(() => window.hdaSessions.list().find((s) => s.selected)?.label)) === "DUAL-PC");
await page.select("#zoom", "fit");

await page.click("#toolbar-monitor");
await page.click('#monitor-menu [data-monitor="2"]');
await sleep(100);
host.send(JSON.stringify({ t: "host.monitors", width: 1920, height: 1080, monitors: [{ index: 1, primary: true, x: 0, y: 0, width: 1920, height: 1080 }] }));
await sleep(300);
const one = await btn("toolbar-monitor");
check("when the customer goes down to one monitor, the framing is dropped", (await canvasState()).monitor === null);
check("…and Monitor says there is only one", one.disabled && /one monitor/.test(one.title), one.title);
host.send(JSON.stringify(LAYOUT));
await sleep(200);

/* --- 3. quality -------------------------------------------------------------------- */
console.log("\n[47] stream quality");
await page.click("#toolbar-quality");
const qItems = await page.$$eval("#quality-menu [data-profile]", (bs) => bs.map((b) => `${b.dataset.profile}:${b.getAttribute("aria-checked")}`));
check("the menu offers High / Balanced / Low, High checked", qItems.join(",") === "high:true,balanced:false,low:false", qItems.join(","));
await page.click('#quality-menu [data-profile="low"]');
const asked = await (async () => { for (let i = 0; i < 50; i++) { const m = host.received.find((x) => x.t === "agent.quality"); if (m) return m; await sleep(40); } return null; })();
check("choosing Low sends agent.quality low to the applet", asked?.profile === "low", JSON.stringify(asked));
const pending = await page.$$eval("#quality-menu [data-profile]", (bs) => bs.map((b) => `${b.dataset.profile}:${b.getAttribute("aria-checked")}:${b.disabled}`));
check("until the applet confirms, High stays checked and the menu waits", pending.join(",") === "high:true:true,balanced:false:true,low:false:true", pending.join(","));
host.send(JSON.stringify({ t: "host.quality", profile: "low", fps: 2 }));
await page.waitForFunction(() => /Low bandwidth/.test(document.getElementById("toolbar-quality").title), { timeout: 3000 });
const q = await btn("toolbar-quality");
check("once confirmed: Low bandwidth (2 fps), badge L", /Low bandwidth \(2 fps\)/.test(q.title) && q.badge === "L", `${q.title} [${q.badge}]`);
check("…and it is on the session's activity log", await page.evaluate(() => /Stream quality: Low bandwidth \(2 fps\)/.test(document.body.textContent)));

await page.click("#hold-session");
await page.waitForFunction(() => document.body.dataset.hold === "on", { timeout: 3000 });
check("while held, Stream quality stays available", !(await btn("toolbar-quality")).disabled, (await btn("toolbar-quality")).title);
await page.click("#toolbar-quality");
await page.click('#quality-menu [data-profile="high"]');
await sleep(300);
check("…and a change goes through", host.received.filter((m) => m.t === "agent.quality").at(-1)?.profile === "high");
host.send(JSON.stringify({ t: "host.quality", profile: "high", fps: 10 }));
await sleep(200);
check("back to High: the badge goes away", (await btn("toolbar-quality")).badge === "");
await page.click("#resume-session");

/* --- 4. menus behave ------------------------------------------------------------------ */
await page.click("#toolbar-quality");
await page.keyboard.press("Escape");
check("Escape closes a menu", await page.$eval("#quality-menu", (m) => m.hidden));
await page.click("#toolbar-monitor");
await page.click("#toolbar-quality");
check("opening one menu closes the other", await page.$eval("#monitor-menu", (m) => m.hidden) && !(await page.$eval("#quality-menu", (m) => m.hidden)));
await page.mouse.click(5, 5);
check("a click elsewhere closes it", await page.$eval("#quality-menu", (m) => m.hidden));

check("no page errors", errors.length === 0, errors.join(" | "));

old.close();
host.close();
await browser.close();
console.log(`\n--- browser/47 quality and monitors: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
