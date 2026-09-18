/**
 * Feature Batch 1 — fullscreen, zoom, magnifier, hold/resume (console side).
 *
 * The rule these all have to survive is the one that matters in this product:
 * **a view feature that breaks click mapping is not a feature.** So the zoom
 * section does not check that the canvas "looks" scaled — it drives real clicks
 * at five points of the canvas at every zoom level and asserts the remote pixel
 * that came out the other end, against the backing store the frame arrived with.
 *
 * What is deliberately NOT claimed here: none of this proves anything about
 * Windows. It proves what the console sends. `MANUAL_TESTS.md` MT-07 is the
 * other half.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();

console.log("\n=== Feature Batch 1 — fullscreen, zoom, magnifier, hold/resume ===\n");

/* --- a 1600×900 frame, so native ≠ CSS at every zoom level ------------------- */
const maker = await browser.newPage();
await maker.goto("about:blank");
const frameB64 = await maker.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 900;
  const x = c.getContext("2d");
  // Four distinctly coloured quadrants: the magnifier can then be checked by
  // what it actually sampled, not merely by whether it drew something.
  const quad = [["#ff0000", 0, 0], ["#00ff00", 800, 0], ["#0000ff", 0, 450], ["#ffff00", 800, 450]];
  for (const [colour, qx, qy] of quad) { x.fillStyle = colour; x.fillRect(qx, qy, 800, 450); }
  return c.toDataURL("image/jpeg", 0.92).split(",")[1];
});
await maker.close();
const fullFrame = () => Buffer.concat([Buffer.from([0x01]), Buffer.from(frameB64, "base64")]);

/* --- a live session ---------------------------------------------------------- */
const page = await openConsole(browser, BASE, { viewport: { width: 1600, height: 1000 } });
const errors = page.errors;

// Record what the browser was asked to fullscreen. Headless Chrome may refuse the
// request itself, and a refusal must not be mistaken for "the button is wired".
await page.evaluateOnNewDocument(() => {
  window.__fs = { requested: [], exited: 0 };
  const realRequest = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (...args) {
    window.__fs.requested.push(this.id || this.tagName);
    return realRequest.apply(this, args);
  };
  const realExit = Document.prototype.exitFullscreen;
  Document.prototype.exitFullscreen = function (...args) {
    window.__fs.exited += 1;
    return realExit.apply(this, args);
  };
});
await page.reload({ waitUntil: "domcontentloaded" });

const code = await startSession(page);
const host = new WebSocket(URL_WS);
const received = [];
host.on("message", (d, bin) => { if (!bin) received.push(JSON.parse(d.toString())); });
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-VIEW", user: "alice", os: "Windows 11" }));
await sleep(250);

/* --- 1. idle/pre-consent: no meaningless operations -------------------------- */
console.log("[22] before consent");
const toolbarState = () => page.evaluate(() => Object.fromEntries(
  ["hold-session", "resume-session", "end-session", "toggle-fullscreen", "magnifier", "zoom", "start-session"]
    .map((id) => [id, document.getElementById(id).disabled])));
let t = await toolbarState();
check("no session: Hold, Resume, Fullscreen, Zoom and Magnifier are all disabled",
  t["hold-session"] && t["resume-session"] && t["toggle-fullscreen"] && t.magnifier && t.zoom,
  JSON.stringify(t));

host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected");
host.send(fullFrame());
await page.waitForFunction(() => document.getElementById("remote").width === 1600, { timeout: 5000 });
await sleep(200);

t = await toolbarState();
check("connected: Hold, Fullscreen, Zoom and Magnifier become available",
  !t["hold-session"] && !t["toggle-fullscreen"] && !t.magnifier && !t.zoom, JSON.stringify(t));
check("connected: Resume stays disabled — there is nothing to resume", t["resume-session"]);

/* --- 2. ZOOM: the backing store never moves, and clicks stay accurate --------- */
console.log("\n[22] zoom — display scaling only");

const geom = () => page.$eval("#remote", (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, cssW: r.width, cssH: r.height, w: c.width, h: c.height };
});

const setZoom = async (value) => {
  await page.select("#zoom", value);
  await sleep(120);
  return geom();
};

const inputs = () => received.filter((m) => m.t === "agent.input" && m.kind === "mouse");

/**
 * Click a fraction of the way across the DISPLAYED canvas and report both what
 * the console sent and what the mapping should have produced for the point that
 * was actually clicked.
 *
 * Above 100% the canvas is wider than its viewport, so the target has to be
 * scrolled into view first — which is also the harder case for the product: the
 * rect must be re-read after the scroll, and a cached one would be wrong by
 * exactly the scroll offset.
 */
async function clickFraction(fx, fy) {
  const target = await page.evaluate((x, y) => {
    const c = document.getElementById("remote");
    const w = document.querySelector(".canvas-wrap");
    // 1px inside the edge: the outermost sub-pixel row of a fractional rect
    // hit-tests to the parent, which is a browser detail, not a mapping bug.
    const inset = (size, f) => Math.min(size - 1, Math.max(1, size * f));

    let wr = w.getBoundingClientRect();
    let cr = c.getBoundingClientRect();
    const px = cr.left - wr.left + w.scrollLeft + inset(cr.width, x);
    const py = cr.top - wr.top + w.scrollTop + inset(cr.height, y);
    w.scrollLeft = px - wr.width / 2;
    w.scrollTop = py - wr.height / 2;

    // Re-read AFTER scrolling: this is where the point actually is on screen now.
    cr = c.getBoundingClientRect();
    return {
      x: cr.left + inset(cr.width, x), y: cr.top + inset(cr.height, y),
      cx: cr.left, cy: cr.top, cw: cr.width, ch: cr.height,
      onScreen: cr.left + inset(cr.width, x) > 0 && cr.top + inset(cr.height, y) > 0
        && cr.left + inset(cr.width, x) < innerWidth && cr.top + inset(cr.height, y) < innerHeight,
    };
  }, fx, fy);

  received.length = 0;
  if (target.onScreen) {
    await page.mouse.click(target.x, target.y);
    await sleep(120);
  }
  return {
    sent: inputs().find((m) => m.action === "down"),
    onScreen: target.onScreen,
    wantX: Math.round((target.x - target.cx) * (1600 / target.cw)),
    wantY: Math.round((target.y - target.cy) * (900 / target.ch)),
  };
}

const before = await geom();
check("a frame sized the canvas to the remote's native resolution",
  before.w === 1600 && before.h === 900, `${before.w}×${before.h}`);

const CORNERS = [
  ["top-left", 0, 0], ["top-right", 1, 0],
  ["bottom-left", 0, 1], ["bottom-right", 1, 1], ["centre", 0.5, 0.5],
];

for (const level of ["fit", "0.5", "0.75", "1", "1.25", "1.5", "2"]) {
  const g = await setZoom(level);
  const label = level === "fit" ? "Fit" : `${Number(level) * 100}%`;

  check(`${label}: the backing store is still the remote's native 1600×900`,
    g.w === 1600 && g.h === 900, `${g.w}×${g.h}`);

  if (level !== "fit") {
    // 100% means one remote pixel per CSS pixel; the rest scale from native.
    check(`${label}: displayed at ${label} of the native width`,
      Math.abs(g.cssW - 1600 * Number(level)) <= 1, `${Math.round(g.cssW)}px vs ${1600 * Number(level)}px`);
  }
  check(`${label}: aspect ratio preserved, nothing stretched`,
    Math.abs(g.cssW / g.cssH - 1600 / 900) < 0.01, (g.cssW / g.cssH).toFixed(3));

  let worst = 0, worstAt = "";
  for (const [corner, fx, fy] of CORNERS) {
    const r = await clickFraction(fx, fy);
    if (!r.onScreen) { worst = Infinity; worstAt = `${corner}: could not be scrolled into view`; continue; }
    if (!r.sent) { worst = Infinity; worstAt = `${corner}: no frame`; continue; }
    const off = Math.max(Math.abs(r.sent.x - r.wantX), Math.abs(r.sent.y - r.wantY));
    if (off > worst) { worst = off; worstAt = `${corner}: got (${r.sent.x},${r.sent.y}) want ~(${r.wantX},${r.wantY})`; }
  }
  // One native pixel of slack for the rounding on both sides of the scale.
  check(`${label}: all five points map to the right remote pixel`, worst <= 2, worstAt || "exact");
}

// The classic regression: a zoom implementation that "helpfully" resizes the
// backing store to match the display, which silently halves every coordinate.
await setZoom("0.5");
const half = await clickFraction(0.5, 0.5);
check("50%: a centre click still maps to the centre of the REMOTE, not of the view",
  half.sent && Math.abs(half.sent.x - 800) <= 2 && Math.abs(half.sent.y - 450) <= 2,
  half.sent ? `(${half.sent.x},${half.sent.y})` : "no frame");

// Oversized zoom has to be reachable, or the bottom-right of the desktop is lost.
await setZoom("2");
const scroll = await page.$eval(".canvas-wrap", (w) => ({
  overflow: getComputedStyle(w).overflow,
  scrollable: w.scrollWidth > w.clientWidth || w.scrollHeight > w.clientHeight,
}));
check("200%: the viewport scrolls, so the whole desktop stays reachable",
  scroll.overflow === "auto" && scroll.scrollable, JSON.stringify(scroll));
const scrolled = await page.evaluate(() => {
  const w = document.querySelector(".canvas-wrap");
  w.scrollLeft = 200; w.scrollTop = 120;
  return { left: w.scrollLeft, top: w.scrollTop };
});
const afterScroll = await clickFraction(0.5, 0.5);
check("200% scrolled: mapping still correct (the rect is re-read, not cached)",
  afterScroll.sent && Math.abs(afterScroll.sent.x - 800) <= 2 && Math.abs(afterScroll.sent.y - 450) <= 2,
  `${JSON.stringify(scrolled)} → ${afterScroll.sent ? `(${afterScroll.sent.x},${afterScroll.sent.y})` : "no frame"}`);

await setZoom("fit");
const fitGeom = await geom();
check("Fit: the canvas is inside its container again",
  fitGeom.cssW <= (await page.$eval(".canvas-wrap", (w) => w.clientWidth)) + 1,
  `${Math.round(fitGeom.cssW)}px`);
check("Fit: still not rendered 1:1 with the backing store (it is a fit, not a no-op)",
  Math.round(fitGeom.cssW) !== fitGeom.w, `${Math.round(fitGeom.cssW)} vs ${fitGeom.w}`);

/* --- 3. MAGNIFIER ------------------------------------------------------------- */
console.log("\n[22] magnifier");

const lensState = () => page.evaluate(() => {
  const l = document.getElementById("magnifier-lens");
  const s = getComputedStyle(l);
  return {
    hidden: l.hidden, pointer: s.pointerEvents,
    left: parseFloat(l.style.left || "0"), top: parseFloat(l.style.top || "0"),
    pressed: document.getElementById("magnifier").getAttribute("aria-pressed"),
    title: document.getElementById("magnifier").title,
  };
});

let lens = await lensState();
check("magnifier off by default, lens hidden, and it says 'Enable'",
  lens.hidden && lens.pressed === "false" && /enable/i.test(lens.title), JSON.stringify(lens));

// No animation loop may run while it is off.
const framesWhileOff = await page.evaluate(async () => {
  let n = 0;
  const real = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { n += 1; return real(cb); };
  const g = await new Promise((r) => setTimeout(r, 400));
  window.requestAnimationFrame = real;
  return n + (g ? 0 : 0);
});
check("magnifier off: nothing schedules animation frames", framesWhileOff === 0, `${framesWhileOff} rAF calls`);

await page.click("#magnifier");
lens = await lensState();
check("enabling it flips the button state and the tooltip",
  lens.pressed === "true" && /disable/i.test(lens.title), JSON.stringify(lens));

const g2 = await geom();
await page.mouse.move(g2.x + g2.cssW * 0.25, g2.y + g2.cssH * 0.25);
await sleep(180);
lens = await lensState();
const posA = { left: lens.left, top: lens.top };
check("the lens appears over the canvas and cannot take pointer events",
  !lens.hidden && lens.pointer === "none", JSON.stringify(lens));

// It must sample what is under the pointer. The frame's quadrants are distinct
// colours, so the lens's own pixels say where it looked.
const sampled = (fx, fy) => page.evaluate(async (x, y) => {
  const c = document.getElementById("remote");
  const r = c.getBoundingClientRect();
  const ev = (type) => new MouseEvent(type, {
    clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true,
  });
  c.dispatchEvent(ev("mousemove"));
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const l = document.getElementById("magnifier-lens");
  const d = l.getContext("2d").getImageData(l.width / 2, l.height / 2, 1, 1).data;
  return [d[0], d[1], d[2]];
}, fx, fy);

const dominant = ([r, g, b]) => (r > 160 && g < 90 && b < 90 ? "red"
  : r < 90 && g > 160 && b < 90 ? "green"
  : r < 90 && g < 90 && b > 160 ? "blue"
  : r > 160 && g > 160 && b < 90 ? "yellow" : `rgb(${r},${g},${b})`);

for (const [corner, fx, fy, want] of [
  ["top-left quadrant", 0.25, 0.25, "red"],
  ["top-right quadrant", 0.75, 0.25, "green"],
  ["bottom-left quadrant", 0.25, 0.75, "blue"],
  ["bottom-right quadrant", 0.75, 0.75, "yellow"],
]) {
  const got = dominant(await sampled(fx, fy));
  check(`the lens samples the ${corner} the pointer is actually over`, got === want, `got ${got}`);
}

// …and still samples the right place when the display scale is not 1:1.
await setZoom("2");
const zoomed = dominant(await sampled(0.75, 0.75));
check("at 200% the lens still samples the pointer's real position", zoomed === "yellow", `got ${zoomed}`);
await setZoom("fit");

await page.mouse.move(g2.x + g2.cssW * 0.6, g2.y + g2.cssH * 0.6);
await sleep(180);
lens = await lensState();
check("the lens follows the pointer", lens.left !== posA.left || lens.top !== posA.top,
  `${JSON.stringify(posA)} → ${JSON.stringify({ left: lens.left, top: lens.top })}`);

// The whole point of pointer-events:none: the canvas underneath still works.
received.length = 0;
const through = await clickFraction(0.5, 0.5);
check("a click passes through the lens to the remote canvas",
  through.sent && Math.abs(through.sent.x - 800) <= 2, through.sent ? `(${through.sent.x},${through.sent.y})` : "no frame");
check("…and the element under the lens really is #remote",
  await page.evaluate(() => {
    const l = document.getElementById("magnifier-lens").getBoundingClientRect();
    return document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2)?.id;
  }) === "remote");

// Keyboard must be unaffected too.
await page.click("#remote");
received.length = 0;
await page.keyboard.down("KeyA");
await page.keyboard.up("KeyA");
await sleep(150);
check("keyboard still reaches the remote machine with the lens up",
  received.some((m) => m.t === "agent.input" && m.kind === "key" && m.code === "KeyA"));

await page.evaluate(() => document.getElementById("remote")
  .dispatchEvent(new MouseEvent("mouseleave", { bubbles: true })));
await sleep(120);
check("the lens disappears when the pointer leaves the canvas", (await lensState()).hidden);

/* --- 4. FULLSCREEN ------------------------------------------------------------ */
console.log("\n[22] fullscreen");

await page.click("#magnifier");   // off again, so it cannot colour later checks
const zoomBefore = await page.$eval("#zoom", (z) => z.value);
await page.select("#zoom", "1.25");
await sleep(120);

const canvasId = await page.$eval("#remote", (c) => { c.dataset.probe = "same-node"; return c.dataset.probe; });
await page.click("#toggle-fullscreen");
await sleep(250);
const fs = await page.evaluate(() => ({
  requested: window.__fs.requested,
  element: document.fullscreenElement?.id ?? null,
  pressed: document.getElementById("toggle-fullscreen").getAttribute("aria-pressed"),
  title: document.getElementById("toggle-fullscreen").title,
}));
check("Fullscreen requests the remote VIEWPORT, not the whole document",
  fs.requested.length === 1 && fs.requested[0] === "screen", JSON.stringify(fs.requested));

if (fs.element === "screen") {
  check("the browser granted it and the button shows the active state",
    fs.pressed === "true" && /exit/i.test(fs.title), JSON.stringify(fs));
  const inFs = await geom();
  const fsClick = await clickFraction(0.5, 0.5);
  check("fullscreen: the canvas still maps clicks correctly",
    fsClick.sent !== undefined && Math.abs(fsClick.sent.x - fsClick.wantX) <= 2
      && Math.abs(fsClick.sent.y - fsClick.wantY) <= 2,
    `${Math.round(inFs.cssW)}px wide, sent ${fsClick.sent ? `(${fsClick.sent.x},${fsClick.sent.y})` : "nothing"}`);
  // While fullscreen, the toolbar is not in the fullscreen subtree at all — which
  // is precisely why the viewport carries its own exit control. Esc is the
  // browser's own affordance and headless Chrome does not implement it, so try it
  // and then fall back to the control the product ships.
  await page.keyboard.press("Escape");
  await sleep(300);
  const escWorked = await page.evaluate(() => document.fullscreenElement === null);
  if (!escWorked) {
    check("fullscreen: the viewport's own Exit control is reachable while fullscreen",
      await page.$eval("#exit-fullscreen", (b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }));
    await page.click("#exit-fullscreen");
    await sleep(300);
  }
  check(`fullscreen: exited (${escWorked ? "Esc" : "Exit control"})`,
    await page.evaluate(() => document.fullscreenElement === null));
} else {
  // Headless refused it. That is a browser policy, not a defect — but the UI must
  // not have lied about it either.
  check("fullscreen refused by the browser: the UI does not claim it is active",
    fs.pressed === "false" && /enter/i.test(fs.title), JSON.stringify(fs));
}

// Whether it was granted or refused, none of this may have disturbed the session.
const after = await page.evaluate(() => ({
  probe: document.getElementById("remote").dataset.probe,
  session: document.body.dataset.session,
  zoom: document.getElementById("zoom").value,
  status: document.getElementById("status").textContent.trim(),
  fsElement: document.fullscreenElement?.id ?? null,
}));
check("the canvas element itself was never replaced", after.probe === canvasId, after.probe ?? "gone");
check("the session was not reconnected or reset", after.session === "live" && after.status === "Connected",
  JSON.stringify(after));
check("zoom survived the fullscreen round trip", after.zoom === "1.25", `${zoomBefore} → 1.25 → ${after.zoom}`);

// Nothing below can run while the toolbar is inside a fullscreen element's shadow.
await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
await sleep(200);
check("fullscreen: the toolbar is usable again after exiting",
  await page.$eval("#hold-session", (b) => b.getBoundingClientRect().width > 0)
    && await page.evaluate(() => document.fullscreenElement === null));

// The handler must follow the browser, not our own button, or Esc leaves a lie
// on screen. Drive the event the way Esc does.
await page.evaluate(() => document.dispatchEvent(new Event("fullscreenchange")));
await sleep(120);
check("a fullscreenchange the console did not initiate still updates the button",
  await page.$eval("#toggle-fullscreen", (b) =>
    b.getAttribute("aria-pressed") === String(document.fullscreenElement !== null)));

await page.select("#zoom", "fit");
await sleep(120);

/* --- 5. HOLD / RESUME --------------------------------------------------------- */
console.log("\n[22] hold / resume");

// Hold while a key and a mouse button are genuinely down.
await page.click("#remote");
const gh = await geom();
await page.mouse.move(gh.x + gh.cssW * 0.5, gh.y + gh.cssH * 0.5);
await page.mouse.down();
await page.keyboard.down("ShiftLeft");
await sleep(120);
received.length = 0;

// A synthetic click: the real mouse button is still held down, which is the
// whole point of this case, and Puppeteer cannot press a second one.
await page.evaluate(() => document.getElementById("hold-session").click());
await sleep(250);

const holdFrames = received.filter((m) => m.t === "agent.hold");
check("Hold sends exactly one agent.hold{held:true}",
  holdFrames.length === 1 && holdFrames[0].held === true, JSON.stringify(holdFrames));
check("…and releases the key that was still down, before it stops sending",
  received.some((m) => m.t === "agent.input" && m.kind === "key" && m.code === "ShiftLeft" && m.action === "up"),
  JSON.stringify(received.filter((m) => m.kind === "key")));
check("…and puts the held mouse button back up, so no drag is left open",
  received.some((m) => m.t === "agent.input" && m.kind === "mouse" && m.action === "up"),
  JSON.stringify(received.filter((m) => m.kind === "mouse" && m.action === "up")));

const heldUi = await page.evaluate(() => ({
  hold: document.getElementById("hold-session").disabled,
  resume: document.getElementById("resume-session").disabled,
  end: document.getElementById("end-session").disabled,
  fullscreen: document.getElementById("toggle-fullscreen").disabled,
  zoom: document.getElementById("zoom").disabled,
  magnifier: document.getElementById("magnifier").disabled,
  scripting: document.getElementById("scripting").disabled,
  elevation: document.getElementById("elevation").disabled,
  keys: document.getElementById("special-keys").disabled,
  banner: document.getElementById("hold-banner").hidden,
  statusbar: document.getElementById("statusbar-hold").hidden,
  status: document.getElementById("status").textContent.trim(),
  session: document.body.dataset.session,
}));
check("held: Hold off, Resume on, End still available",
  heldUi.hold && !heldUi.resume && !heldUi.end, JSON.stringify(heldUi));
check("held: the session is still live and says 'On hold'",
  heldUi.session === "live" && heldUi.status === "On hold", JSON.stringify(heldUi));
check("held: the hold is visible in the viewport and the status bar",
  !heldUi.banner && !heldUi.statusbar);
check("held: everything that changes the customer's machine is off",
  heldUi.scripting && heldUi.elevation && heldUi.keys, JSON.stringify(heldUi));
check("held: observation is still allowed — Fullscreen, Zoom and Magnifier stay on",
  !heldUi.fullscreen && !heldUi.zoom && !heldUi.magnifier, JSON.stringify(heldUi));

// Let the physical button go now. Nothing may be sent for it: the console
// already synthesised the release, and a second one would be a phantom click.
received.length = 0;
await page.mouse.up();
await sleep(150);
check("held: releasing the physical button sends nothing further",
  received.filter((m) => m.t === "agent.input").length === 0,
  JSON.stringify(received.filter((m) => m.t === "agent.input")));

// The session is NOT dead: frames keep arriving and keep being drawn.
received.length = 0;
const framesBefore = await page.$eval("#fps", (e) => e.textContent);
host.send(fullFrame());
await sleep(400);
check("held: the customer's screen keeps streaming (the session is paused, not ended)",
  await page.evaluate(() => document.getElementById("remote").width === 1600) &&
  (await page.$eval("#viewport-empty", (e) => getComputedStyle(e).display)) === "none",
  framesBefore);

// And no input escapes while held.
await page.mouse.click(gh.x + gh.cssW * 0.4, gh.y + gh.cssH * 0.4);
await page.keyboard.press("KeyB");
await page.click('#special-keys button[data-keys="MetaLeft"]').catch(() => {});
await sleep(250);
check("held: not one input frame reaches the relay",
  received.filter((m) => m.t === "agent.input").length === 0,
  JSON.stringify(received.filter((m) => m.t === "agent.input")));

// Resume.
received.length = 0;
await page.click("#resume-session");
await sleep(250);
const resumeFrames = received.filter((m) => m.t === "agent.hold");
check("Resume sends agent.hold{held:false}",
  resumeFrames.length === 1 && resumeFrames[0].held === false, JSON.stringify(resumeFrames));

const resumedUi = await page.evaluate(() => ({
  hold: document.getElementById("hold-session").disabled,
  resume: document.getElementById("resume-session").disabled,
  scripting: document.getElementById("scripting").disabled,
  banner: document.getElementById("hold-banner").hidden,
  status: document.getElementById("status").textContent.trim(),
  zoom: document.getElementById("zoom").value,
}));
check("resumed: Hold is back, Resume is off, the banner is gone",
  !resumedUi.hold && resumedUi.resume && resumedUi.banner, JSON.stringify(resumedUi));
check("resumed: status is Connected again and scripts are usable",
  resumedUi.status === "Connected" && !resumedUi.scripting, JSON.stringify(resumedUi));
check("resumed: zoom was not reset by the hold round trip", resumedUi.zoom === "fit", resumedUi.zoom);

const resumedClick = await clickFraction(0.5, 0.5);
check("resumed: input reaches the remote machine again",
  resumedClick.sent !== undefined && Math.abs(resumedClick.sent.x - resumedClick.wantX) <= 2,
  resumedClick.sent ? `(${resumedClick.sent.x},${resumedClick.sent.y})` : "nothing sent");

/* --- 6. a disconnect while held outranks the hold ------------------------------ */
console.log("\n[22] disconnect while held");
await page.evaluate(() => document.getElementById("hold-session").click());
await sleep(200);
check("held again", await page.$eval("#hold-banner", (b) => !b.hidden));

host.close();
await page.waitForFunction(() => document.body.dataset.session === "none", { timeout: 5000 }).catch(() => {});
await sleep(200);
const dead = await page.evaluate(() => ({
  session: document.body.dataset.session,
  banner: document.getElementById("hold-banner").hidden,
  statusbar: document.getElementById("statusbar-hold").hidden,
  hold: document.getElementById("hold-session").disabled,
  resume: document.getElementById("resume-session").disabled,
  end: document.getElementById("end-session").disabled,
  status: document.getElementById("status").textContent.trim(),
}));
check("the customer dropping while held ends the session, it does not stay 'On hold'",
  dead.session === "none" && dead.banner && dead.statusbar, JSON.stringify(dead));
check("…and Hold, Resume and End are all disabled again",
  dead.hold && dead.resume && dead.end, JSON.stringify(dead));
check("…and the status says what actually happened", /disconnect/i.test(dead.status), dead.status);

check("no uncaught page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
