/**
 * Technician console shell (UI modernization, Phase 1): the layout guarantees
 * the remote-control blocks (11–14) do not look at.
 *
 * Blocks 11–14 prove the canvas maps clicks correctly and that every control
 * works. None of them notice if the remote screen is half off-screen, clipped by
 * its own container, covered by a placeholder, or squeezed by a column of
 * buttons — all of which shipped in the first cut of the redesign and passed
 * them. This block asserts what a technician actually sees:
 *
 *   - the whole remote frame is visible, at its aspect ratio, and every part of it
 *     hit-tests to #remote (nothing overlays it);
 *   - no page scroll at the target resolutions, and narrow windows collapse the
 *     side panels instead of pushing the screen below the fold;
 *   - the single-use code is shown only while it can still be used;
 *   - an `error` mid-session does not paint a placeholder over a live screen;
 *   - a UAC prompt is surfaced beyond the banner;
 *   - planned toolbar features are disabled, never fake.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();

console.log("\n=== Console shell — layout, visibility, honest placeholders ===\n");

/* --- fixtures: a landscape and a portrait remote desktop ----------------------- */
const maker = await browser.newPage();
await maker.goto("about:blank");
const [wide, tall] = await maker.evaluate(() => [[1920, 1080], [1080, 1920]].map(([w, h]) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = "#3060a0"; x.fillRect(0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.5).split(",")[1];
}));
await maker.close();
const fullFrame = (b64) => Buffer.concat([Buffer.from([0x01]), Buffer.from(b64, "base64")]);

const layout = (page) => page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const canvas = document.getElementById("remote");
  const shown = (sel) => {
    const e = document.querySelector(sel);
    return !!e && getComputedStyle(e).display !== "none" && e.getClientRects().length > 0;
  };
  return {
    canvas: r(canvas),
    backing: { w: canvas.width, h: canvas.height },
    wrap: r(document.querySelector(".canvas-wrap")),
    win: { w: innerWidth, h: innerHeight },
    scroll: {
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    },
    leftCollapsed: document.getElementById("left-panel").classList.contains("collapsed"),
    rightCollapsed: document.getElementById("right-panel").classList.contains("collapsed"),
    session: document.body.dataset.session,
    card: shown("#code-block"),
    overlay: shown("#viewport-empty"),
    overlayPending: shown("#viewport-empty .empty-pending"),
    overlayPointer: getComputedStyle(document.getElementById("viewport-empty")).pointerEvents,
    uacStatus: shown(".statusbar-uac"),
  };
});

const inside = (a, b, tol = 1) =>
  a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;

/* --- 1. target resolutions: no page scroll, panels open, screen on-screen ------ */
console.log("[17] target resolutions");
for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  const page = await openConsole(browser, BASE, { viewport: { width: w, height: h } });
  await sleep(150);
  const l = await layout(page);
  check(`${w}×${h}: no horizontal or vertical page scroll`, !l.scroll.x && !l.scroll.y, JSON.stringify(l.scroll));
  check(`${w}×${h}: both side panels start expanded`, !l.leftCollapsed && !l.rightCollapsed);
  check(`${w}×${h}: the remote screen is entirely inside the window`,
    inside(l.canvas, { x: 0, y: 0, w: l.win.w, h: l.win.h }), JSON.stringify(l.canvas));
  check(`${w}×${h}: the remote screen gets at least half the window width`,
    l.canvas.w >= w * 0.5, `${Math.round(l.canvas.w)}px of ${w}`);
  const keysHeight = await page.$eval("#special-keys", (f) => f.getBoundingClientRect().height);
  check(`${w}×${h}: special keys are one compact row, not a column`, keysHeight < 40, `${keysHeight}px tall`);
  await page.close();
}

/* --- 2. narrow windows collapse panels instead of stacking the screen away ----- */
console.log("\n[17] narrow windows");
for (const [w, h, left, right] of [[1200, 800, true, false], [900, 650, true, true]]) {
  const page = await openConsole(browser, BASE, { viewport: { width: w, height: h } });
  await sleep(150);
  const l = await layout(page);
  check(`${w}×${h}: left panel ${left ? "starts as a rail" : "open"}, right ${right ? "starts as a rail" : "open"}`,
    l.leftCollapsed === left && l.rightCollapsed === right, `left=${l.leftCollapsed} right=${l.rightCollapsed}`);
  check(`${w}×${h}: the remote screen is entirely inside the window (not below the fold)`,
    inside(l.canvas, { x: 0, y: 0, w: l.win.w, h: l.win.h }), JSON.stringify(l.canvas));
  check(`${w}×${h}: no page scroll`, !l.scroll.x && !l.scroll.y, JSON.stringify(l.scroll));
  await page.close();
}

/* --- 3. a whole session at 1366×768 ------------------------------------------- */
console.log("\n[17] session lifecycle at 1366×768");
const page = await openConsole(browser, BASE, { viewport: { width: 1366, height: 768 } });
const errors = page.errors;

let l = await layout(page);
check("idle: no session card, a placeholder that cannot take clicks",
  l.session === "none" && !l.card && l.overlay && l.overlayPointer === "none", JSON.stringify(l));

// Toggle labels must say what the button will do next.
await page.click("#left-panel-toggle");
const collapsedLabel = await page.$eval("#left-panel-toggle", (b) => [b.getAttribute("aria-expanded"), b.getAttribute("aria-label")]);
await page.click("#left-panel-toggle");
const expandedLabel = await page.$eval("#left-panel-toggle", (b) => [b.getAttribute("aria-expanded"), b.getAttribute("aria-label")]);
check("panel toggle updates aria-expanded and its label both ways",
  collapsedLabel[0] === "false" && /^Expand/.test(collapsedLabel[1]) &&
  expandedLabel[0] === "true" && /^Collapse/.test(expandedLabel[1]),
  JSON.stringify([collapsedLabel, expandedLabel]));

const code = await startSession(page);
l = await layout(page);
check("pending: the code card is shown while the code is usable", l.session === "pending" && l.card, code);
check("pending: the placeholder says we are waiting for the customer", l.overlay && l.overlayPending);

// The copy handler must change the label, not wipe the icon. Clipboard access may
// be refused headless; either outcome must leave the button intact and throw nothing.
await page.click("#copy-link");
await sleep(1700);
check("Copy keeps its icon after being used",
  await page.$eval("#copy-link", (b) => b.querySelector("svg") !== null && b.textContent.trim() === "Copy"),
  await page.$eval("#copy-link", (b) => b.innerHTML.trim().slice(0, 60)));

const host = new WebSocket(URL_WS);
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-SHELL", user: "bob", os: "Windows 11" }));
await sleep(300);
check("the customer machine is mirrored into the sessions panel",
  (await page.$eval("#session-current-host", (e) => e.textContent)).includes("WIN-SHELL"));

host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected");
await sleep(150);
l = await layout(page);
check("live: the burned code card is gone, the placeholder is gone",
  l.session === "live" && !l.card && !l.overlay, JSON.stringify({ card: l.card, overlay: l.overlay }));
const mirrors = async () => page.evaluate(() => ({
  hint: document.getElementById("input-hint").textContent,
  bar: document.getElementById("statusbar-input").textContent,
  pill: document.getElementById("status").textContent,
  barState: document.querySelector(".statusbar-connection").textContent,
}));
let m = await mirrors();
check("live: the status bar's input and connection read the same as their sources",
  m.bar === m.hint && m.bar.length > 0 && m.barState === m.pill, JSON.stringify(m));
await page.click("#remote");
await sleep(100);
m = await mirrors();
check("…and follow them when the canvas takes focus", m.hint === "input active" && m.bar === m.hint, JSON.stringify(m));
await page.evaluate(() => document.getElementById("remote").blur());
check("live: #code still holds the code (portal.js and block 10 read it)",
  (await page.$eval("#code", (e) => e.textContent.trim())) === code);

for (const [label, frame, ratio] of [["landscape 1920×1080", wide, 1920 / 1080], ["portrait 1080×1920", tall, 1080 / 1920]]) {
  const want = label.startsWith("landscape") ? 1920 : 1080;
  host.send(fullFrame(frame));
  await page.waitForFunction((w) => document.getElementById("remote").width === w, { timeout: 5000 }, want);
  await sleep(150);
  l = await layout(page);
  check(`${label}: the whole frame is visible inside the viewport (nothing clipped)`,
    inside(l.canvas, l.wrap), `canvas ${JSON.stringify(l.canvas)} wrap ${JSON.stringify(l.wrap)}`);
  check(`${label}: displayed at the remote's aspect ratio`,
    Math.abs(l.canvas.w / l.canvas.h - ratio) / ratio < 0.01, `${(l.canvas.w / l.canvas.h).toFixed(3)} vs ${ratio.toFixed(3)}`);
  check(`${label}: CSS size is not the backing size (PLAN 4.1 mapping)`,
    Math.round(l.canvas.w) !== l.backing.w, `${Math.round(l.canvas.w)} vs ${l.backing.w}`);
  const hits = await page.evaluate(() => {
    const b = document.getElementById("remote").getBoundingClientRect();
    const i = 3;
    return [[b.left + i, b.top + i], [b.right - i, b.top + i], [b.left + i, b.bottom - i],
      [b.right - i, b.bottom - i], [b.left + b.width / 2, b.top + b.height / 2]]
      .map(([x, y]) => document.elementFromPoint(x, y)?.id ?? null);
  });
  check(`${label}: all four corners and the centre hit-test to #remote`,
    hits.every((id) => id === "remote"), JSON.stringify(hits));
}

// A real mid-session error: credential elevation over plain ws:// is refused by
// the relay (constraint #6) and the session carries on. The status pill turns to
// an error, which must not be mistaken for "no session".
await page.click('input[name="elev-mode"][value="credential"]');
await page.type("#elev-username", "svc-admin");
await page.type("#elev-password", "not-a-real-password");
await page.click("#elevate");
await page.waitForFunction(() => document.getElementById("status").dataset.state === "error", { timeout: 5000 })
  .catch(() => {});
l = await layout(page);
const pill = await page.$eval("#status", (e) => `${e.dataset.state}: ${e.textContent}`);
check("mid-session error: the relay refused, the pill shows it", pill.startsWith("error"), pill);
check("mid-session error: no placeholder is painted over the live screen",
  l.session === "live" && !l.overlay, JSON.stringify({ session: l.session, overlay: l.overlay }));

host.send(JSON.stringify({ t: "host.desktopChanged", desktop: "Winlogon" }));
await sleep(250);
l = await layout(page);
const border = await page.$eval("#screen", (s) => getComputedStyle(s).borderTopColor);
const normalBorder = await page.$eval(".side-panel", (s) => getComputedStyle(s).borderTopColor);
check("UAC: the status bar says a Secure Desktop prompt is up", l.uacStatus);
check("UAC: the whole viewport is outlined, not just the banner strip", border !== normalBorder, `${border} vs ${normalBorder}`);
host.send(JSON.stringify({ t: "host.desktopChanged", desktop: "Default" }));
await sleep(250);
check("UAC: both indicators clear on return to Default", !(await layout(page)).uacStatus);

/* --- 4. planned features are disabled, never fake ------------------------------ */
const toolbar = await page.$$eval(".session-toolbar button", (bs) => bs.map((b) => ({
  id: b.id, planned: b.title === "Planned feature", disabled: b.disabled,
  name: (b.getAttribute("aria-label") ?? b.textContent).trim(),
})));
const planned = toolbar.filter((b) => b.planned);
check("every planned toolbar feature is disabled", planned.length > 0 && planned.every((b) => b.disabled),
  planned.filter((b) => !b.disabled).map((b) => b.name).join(", ") || `${planned.length} planned`);
check("every toolbar button has an accessible name", toolbar.every((b) => b.name.length > 0));
check("the only working toolbar controls are the implemented ones",
  JSON.stringify(toolbar.filter((b) => !b.planned).map((b) => b.id).sort()) ===
  JSON.stringify(["end-session", "start-session", "toggle-fullscreen", "toolbar-scripts"]),
  toolbar.filter((b) => !b.planned).map((b) => b.id).join(", "));

/* --- 5. the customer leaves ---------------------------------------------------- */
host.close();
await page.waitForFunction(() => document.body.dataset.session === "none", { timeout: 5000 }).catch(() => {});
l = await layout(page);
check("after the customer leaves: the dead code is not displayed", l.session === "none" && !l.card, JSON.stringify(l.session));
check("…the placeholder is back, and the sessions panel is cleared",
  l.overlay && !l.overlayPending && (await page.$eval("#session-current-host", (e) => e.textContent)) === "—");
check("no uncaught page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
