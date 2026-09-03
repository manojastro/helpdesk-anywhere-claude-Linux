/**
 * Phase 4.1 acceptance (Linux half): drive the real agent console with a real
 * browser and assert the exact `agent.input` frames that reach the host.
 *
 * The Win32 injection half needs Windows. What CAN be verified here is the part
 * most likely to be wrong and hardest to eyeball on a screenshot: the canvas →
 * remote-pixel mapping, which must use the backing store and not the CSS size.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

const WS = URL_WS;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();

console.log("\n=== Phase 4.1 — browser input capture and coordinate mapping ===\n");

/* A 1600x900 "remote desktop", so the canvas is displayed far smaller than it is. */
const maker = await browser.newPage();
await maker.goto("about:blank");
const b64 = await maker.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 900;
  const x = c.getContext("2d");
  x.fillStyle = "#202020"; x.fillRect(0, 0, 1600, 900);
  return c.toDataURL("image/jpeg", 0.6).split(",")[1];
});
await maker.close();
const frame = Buffer.concat([Buffer.from([0x01]), Buffer.from(b64, "base64")]);

// A viewport tall enough that the whole canvas is clickable.
const page = await openConsole(browser, BASE, { viewport: { width: 1400, height: 1200 } });
const errors = page.errors;
const code = await startSession(page);

const host = new WebSocket(WS);
const received = [];
host.on("message", (d, isBinary) => { if (!isBinary) received.push(JSON.parse(d.toString())); });
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-TEST", user: "alice", os: "Windows" }));
await sleep(300);

const inputs = () => received.filter((m) => m.t === "agent.input");

/* --- 1. nothing is injectable before consent -------------------------------- */
const rectBefore = await page.$eval("#remote", (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(rectBefore.x + 40, rectBefore.y + 40);
await sleep(300);
check("no input reaches the host before consent", inputs().length === 0, `${inputs().length} frames`);

/* --- consent, then a frame so the canvas takes its native size -------------- */
host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected");
host.send(frame);
await page.waitForFunction(() => document.getElementById("remote").width === 1600, { timeout: 5000 });

const geom = await page.$eval("#remote", (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, cssW: r.width, cssH: r.height, w: c.width, h: c.height };
});
check("canvas is displayed much smaller than the remote desktop",
  Math.round(geom.cssW) < geom.w, `css ${Math.round(geom.cssW)}px vs remote ${geom.w}px`);

// focus() scrolls the canvas into view, so the rect is re-read for every click
// rather than cached — a stale rect silently aims at the wrong place.
const rect = () => page.$eval("#remote", (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, cssW: r.width, cssH: r.height };
});

const clickAt = async (fx, fy) => {
  const r = await rect();
  received.length = 0;
  await page.mouse.click(r.x + r.cssW * fx, r.y + r.cssH * fy);
  await sleep(200);
  return inputs().filter((m) => m.action === "down")[0];
};

/* --- 2. coordinate mapping uses the backing store, not the CSS size --------- */
const centre = await clickAt(0.5, 0.5);
const wantX = Math.round(geom.w * 0.5), wantY = Math.round(geom.h * 0.5);
check("a click at the centre maps to the centre of the remote desktop",
  centre && Math.abs(centre.x - wantX) <= 4 && Math.abs(centre.y - wantY) <= 4,
  centre ? `got (${centre.x},${centre.y}) want ~(${wantX},${wantY})` : "no frame");
// The classic bug: using the CSS size would have reported ~499 here, not 800.
const cssHalf = Math.round(geom.cssW * 0.5);
check("…and NOT to the CSS-pixel position (the classic bug)",
  centre && Math.abs(centre.x - cssHalf) > 100,
  centre ? `mapped x=${centre.x}; the CSS-pixel bug would give ~${cssHalf}` : "");

const topLeft = await clickAt(0.001, 0.001);
check("top-left corner maps near (0,0)",
  topLeft && topLeft.x <= 4 && topLeft.y <= 4, topLeft ? `(${topLeft.x},${topLeft.y})` : "no frame");

// 2 CSS px inside the corner: the outermost sub-pixel row of a fractional rect
// hit-tests to the parent element, which is a browser detail, not a mapping bug.
const brRect = await rect();
received.length = 0;
await page.mouse.click(brRect.x + brRect.cssW - 2, brRect.y + brRect.cssH - 2);
await sleep(200);
const bottomRight = inputs().find((m) => m.action === "down");
const scale = geom.w / brRect.cssW;
check("bottom-right corner reaches the far edge, clamped inside the frame",
  bottomRight &&
  bottomRight.x >= geom.w - 1 - Math.ceil(2 * scale) && bottomRight.x <= geom.w - 1 &&
  bottomRight.y >= geom.h - 1 - Math.ceil(2 * scale) && bottomRight.y <= geom.h - 1,
  bottomRight ? `(${bottomRight.x},${bottomRight.y}) of max (${geom.w - 1},${geom.h - 1})` : "no frame");

/* --- 3. buttons ------------------------------------------------------------- */
let r0 = await rect();
received.length = 0;
await page.mouse.click(r0.x + 100, r0.y + 100, { button: "right" });
await sleep(200);
const right = inputs();
check("right button sends button:2 down and up",
  right.some((m) => m.action === "down" && m.button === 2) &&
  right.some((m) => m.action === "up" && m.button === 2),
  JSON.stringify(right.map((m) => `${m.action}:${m.button}`)));

r0 = await rect();
received.length = 0;
await page.mouse.click(r0.x + 100, r0.y + 100, { button: "middle" });
await sleep(200);
check("middle button sends button:1", inputs().some((m) => m.button === 1),
  JSON.stringify(inputs().map((m) => `${m.action}:${m.button}`)));

/* --- 4. drag: down, moves, up ---------------------------------------------- */
r0 = await rect();
received.length = 0;
await page.mouse.move(r0.x + 100, r0.y + 100);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(r0.x + 100 + i * 10, r0.y + 100 + i * 5);
  await sleep(20);
}
await page.mouse.up();
await sleep(200);
const drag = inputs();
const downAt = drag.findIndex((m) => m.action === "down");
const movesAfterDown = drag.slice(downAt + 1).filter((m) => m.action === "move").length;
check("a drag sends down, then moves, then up",
  downAt >= 0 && movesAfterDown > 0 && drag.at(-1)?.action === "up",
  `${drag.length} frames: down at ${downAt}, ${movesAfterDown} moves after it, last ${drag.at(-1)?.action}`);

/* --- 5. move throttling ~60/s ---------------------------------------------- */
received.length = 0;
const start = Date.now();
r0 = await rect();
for (let i = 0; i < 60; i++) {
  await page.mouse.move(r0.x + 200 + i, r0.y + 200);
}
const elapsed = Date.now() - start;
await sleep(200);
const moves = inputs().filter((m) => m.action === "move").length;
check("mousemove is throttled to roughly 60/s",
  moves <= Math.ceil(elapsed / 16) + 2, `${moves} moves in ${elapsed}ms`);

/* --- 6. wheel --------------------------------------------------------------- */
received.length = 0;
r0 = await rect();
await page.mouse.move(r0.x + 200, r0.y + 200);
await page.mouse.wheel({ deltaY: 100 });
await sleep(200);
const wheelDown = inputs().find((m) => m.action === "wheel");
check("scrolling down sends a NEGATIVE wheelDelta (Windows inverts the DOM sign)",
  wheelDown && wheelDown.wheelDelta === -120, JSON.stringify(wheelDown?.wheelDelta));

received.length = 0;
await page.mouse.wheel({ deltaY: -100 });
await sleep(200);
const wheelUp = inputs().find((m) => m.action === "wheel");
check("scrolling up sends +120", wheelUp && wheelUp.wheelDelta === 120, JSON.stringify(wheelUp?.wheelDelta));

/* --- 7. keyboard sends event.code, not event.key ---------------------------- */
received.length = 0;
await page.click("#remote");
await page.keyboard.press("KeyA");
await page.keyboard.press("Digit7");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("Backspace");
await sleep(250);
const keys = inputs().filter((m) => m.kind === "key");
const codes = keys.map((k) => `${k.code}:${k.action}`);
check("keys travel as physical event.code with matching down/up",
  ["KeyA:down", "KeyA:up", "Digit7:down", "Digit7:up", "ArrowLeft:down", "ArrowLeft:up",
   "Backspace:down", "Backspace:up"].every((c) => codes.includes(c)), codes.join(" "));
check("no event.key values leak into the wire (would be 'a', '7', …)",
  keys.every((k) => /^[A-Z]/.test(k.code)), codes.join(" "));

/* --- 8. a held modifier is released when the canvas loses focus ------------- */
received.length = 0;
await page.keyboard.down("Shift");
await sleep(100);
await page.evaluate(() => document.getElementById("remote").blur());
await sleep(250);
const shiftUp = inputs().filter((m) => m.kind === "key" && m.action === "up" && m.code.startsWith("Shift"));
check("blur releases a held modifier (no stuck Shift on the remote machine)",
  shiftUp.length > 0, JSON.stringify(inputs().map((m) => `${m.code}:${m.action}`)));
await page.keyboard.up("Shift").catch(() => {});

/* --- 9. special-key chord buttons ------------------------------------------- */
received.length = 0;
await page.click('#special-keys button[data-keys="AltLeft+Tab"]');
await sleep(250);
const chord = inputs().map((m) => `${m.code}:${m.action}`);
check("the Alt+Tab button sends the chord down-in-order, up-in-reverse",
  chord.join(",") === "AltLeft:down,Tab:down,Tab:up,AltLeft:up", chord.join(","));
check("clicking a console button injects no stray mouse event into the remote",
  inputs().every((m) => m.kind === "key"), chord.join(","));

const sasDisabled = await page.$eval("#send-sas", (b) => b.disabled);
check("Ctrl+Alt+Del stays disabled until Phase 5 elevation", sasDisabled === true);

/* --- 10. input stops when the session ends --------------------------------- */
await page.click("#end-session");
await sleep(400);
received.length = 0;
await page.mouse.click(r0.x + 120, r0.y + 120).catch(() => {});
await sleep(250);
check("no input is sent after the session ends", inputs().length === 0, `${inputs().length} frames`);
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

try { host.close(); } catch {}
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
