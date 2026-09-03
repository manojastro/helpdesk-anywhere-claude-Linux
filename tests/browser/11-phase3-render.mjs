/**
 * Phase 3.4 acceptance (Linux half): drive the real agent console with real
 * binary frames in the real wire format, and read the pixels back off the canvas.
 *
 * The Windows capture half cannot run here. What CAN be verified without Windows
 * is everything downstream of the wire: the [0x01]/[0x02] framing, big-endian
 * headers, canvas sizing at native remote resolution, dirty-rect placement, the
 * FPS/kbps counter, and the reset on session end.
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

console.log("\n=== Phase 3.4 — renderer, framing and counters ===\n");

/* --- fixtures: real JPEGs, made by the same browser engine that will decode them */
const maker = await browser.newPage();
await maker.goto("about:blank");
const fixtures = await maker.evaluate(() => {
  const jpeg = (w, h, paint) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    paint(x, w, h);
    return c.toDataURL("image/jpeg", 0.6).split(",")[1];
  };
  return {
    // 640x400: left half red, right half blue.
    full: jpeg(640, 400, (x, w, h) => {
      x.fillStyle = "#ff0000"; x.fillRect(0, 0, w / 2, h);
      x.fillStyle = "#0000ff"; x.fillRect(w / 2, 0, w / 2, h);
    }),
    // 128x128 solid yellow, to be pasted as a dirty rect.
    tile: jpeg(128, 128, (x, w, h) => {
      x.fillStyle = "#ffff00"; x.fillRect(0, 0, w, h);
    }),
    // A second full frame at a different size, to prove the canvas re-sizes.
    resized: jpeg(800, 600, (x, w, h) => {
      x.fillStyle = "#00ff00"; x.fillRect(0, 0, w, h);
    }),
  };
});
await maker.close();

const fullJpeg = Buffer.from(fixtures.full, "base64");
const tileJpeg = Buffer.from(fixtures.tile, "base64");
const resizedJpeg = Buffer.from(fixtures.resized, "base64");
check("fixtures encode as real JPEGs", fullJpeg[0] === 0xff && fullJpeg[1] === 0xd8,
  `${fullJpeg.length}B full, ${tileJpeg.length}B tile`);

/* --- frame builders: byte-for-byte what ScreenStreamer.cs emits ------------- */
const fullFrame = (jpeg) => Buffer.concat([Buffer.from([0x01]), jpeg]);
const dirtyRect = (x, y, w, h, jpeg) => {
  const head = Buffer.alloc(9);
  head[0] = 0x02;
  head.writeUInt16BE(x, 1);   // big-endian, per shared/protocol.md
  head.writeUInt16BE(y, 3);
  head.writeUInt16BE(w, 5);
  head.writeUInt16BE(h, 7);
  return Buffer.concat([head, jpeg]);
};

/* --- console + host -------------------------------------------------------- */
const page = await openConsole(browser, BASE);
const pageErrors = page.errors;
const code = await startSession(page);
check("console created a session", /^\d{6}$/.test(code), code);

const host = new WebSocket(WS);
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-TEST", user: "alice", os: "Windows" }));
await new Promise((res) => host.once("message", res));
host.send(JSON.stringify({ t: "host.consent", accepted: true }));
const connected = await page.waitForFunction(
  () => document.getElementById("status").textContent.trim() === "Connected",
  { timeout: 5000 },
).then(() => true, () => false);
check("consent accepted → console Connected", connected);

const px = (x, y) => page.evaluate(([x, y]) => {
  const c = document.getElementById("remote");
  const d = c.getContext("2d").getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}, [x, y]);
const near = (got, want, tol = 45) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

/* --- 1. full frame sizes the canvas to native remote resolution ------------- */
host.send(fullFrame(fullJpeg));
await page.waitForFunction(() => document.getElementById("remote").width === 640, { timeout: 5000 });
const size = await page.evaluate(() => {
  const c = document.getElementById("remote");
  return { w: c.width, h: c.height, cssW: Math.round(c.getBoundingClientRect().width) };
});
check("[0x01] resizes the backing store to the remote's native size",
  size.w === 640 && size.h === 400, `${size.w}x${size.h}`);
check("backing store is NOT the CSS size (Phase 4 coordinate mapping depends on this)",
  size.cssW !== size.w, `css ${size.cssW}px vs backing ${size.w}px`);

const left = await px(100, 200);
const right = await px(540, 200);
check("[0x01] painted the frame (left half red)", near(left, [255, 0, 0]), left.join(","));
check("[0x01] painted the frame (right half blue)", near(right, [0, 0, 255]), right.join(","));

/* --- 2. dirty rect lands at the big-endian coordinates it carries ----------- */
host.send(dirtyRect(128, 128, 128, 128, tileJpeg));
await sleep(400);
const inside = await px(160, 160);
const outside = await px(20, 20);
const belowRect = await px(160, 300);
check("[0x02] painted at x=128,y=128 (yellow inside the rect)", near(inside, [255, 255, 0]), inside.join(","));
check("[0x02] left the rest of the frame alone (still red at 20,20)", near(outside, [255, 0, 0]), outside.join(","));
check("[0x02] did not bleed below the rect (still red at 160,300)", near(belowRect, [255, 0, 0]), belowRect.join(","));

/* --- 3. a dirty rect at a large offset — proves BE, not LE, decoding -------- */
host.send(dirtyRect(400, 260, 128, 128, tileJpeg));
await sleep(400);
const farTile = await px(440, 300);
check("[0x02] with x=400 (0x0190) decodes big-endian", near(farTile, [255, 255, 0]), farTile.join(","));

/* --- 4. counters, measured while frames are actually flowing ---------------- */
// A steady ~10 FPS for 1.5s, the rate ScreenStreamer targets.
const burst = setInterval(() => {
  try { host.send(dirtyRect(0, 0, 128, 128, tileJpeg)); } catch {}
}, 100);
await sleep(1600);
const counters = await page.evaluate(() => ({
  fps: document.getElementById("fps").textContent,
  kbps: document.getElementById("kbps").textContent,
}));
clearInterval(burst);
const fpsValue = Number.parseFloat(counters.fps);
const kbpsValue = Number.parseInt(counters.kbps, 10);
check("FPS counter counts frames under a ~10 FPS load", fpsValue >= 5 && fpsValue <= 15, counters.fps);
check("kbps counter counts bytes", kbpsValue > 0, counters.kbps);

// And falls back to zero once the stream stops, rather than sticking. Two full
// counter windows, so the sampled window cannot still overlap the burst.
await sleep(2400);
const idleFps = await page.evaluate(() => document.getElementById("fps").textContent);
check("FPS counter returns to 0 when frames stop", Number.parseFloat(idleFps) === 0, idleFps);

/* --- 5. resolution change mid-session re-sizes the canvas ------------------- */
host.send(fullFrame(resizedJpeg));
await page.waitForFunction(() => document.getElementById("remote").width === 800, { timeout: 5000 });
const after = await page.evaluate(() => {
  const c = document.getElementById("remote");
  return { w: c.width, h: c.height };
});
const green = await px(400, 300);
check("a full frame at a new size re-sizes the canvas", after.w === 800 && after.h === 600, `${after.w}x${after.h}`);
check("…and repaints it completely", near(green, [0, 255, 0]), green.join(","));

/* --- 6. session end clears the canvas and the counters ---------------------- */
await page.click("#end-session");
await sleep(600);
const cleared = await px(400, 300);
const resetCounters = await page.evaluate(() => document.getElementById("fps").textContent);
check("End session clears the canvas to black", near(cleared, [0, 0, 0], 12), cleared.join(","));
check("End session resets the counters", resetCounters.includes("–"), resetCounters);
check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

try { host.close(); } catch {}
await browser.close();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
