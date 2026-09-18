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
    // The one interactive thing inside the placeholder. It must be clickable
    // while idle and gone (not merely transparent) once a session is live.
    idleButton: shown("#idle-new-session"),
    idleButtonPointer: getComputedStyle(document.getElementById("idle-new-session")).pointerEvents,
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
// UI polish 1.1 §4: idle must not be a wall of black canvas. The placeholder is
// opaque over it, and its own New Session button is the only part of it that
// takes a click — which is safe precisely because it exists only while idle.
check("idle: the placeholder is opaque, so no black canvas is on show",
  await page.$eval("#viewport-empty", (e) => {
    const bg = getComputedStyle(e).backgroundColor;
    return bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg);
  }),
  await page.$eval("#viewport-empty", (e) => getComputedStyle(e).backgroundColor));
check("idle: the placeholder's New Session button is clickable",
  l.idleButton && l.idleButtonPointer === "auto", JSON.stringify([l.idleButton, l.idleButtonPointer]));

// Toggle labels must say what the button will do next.
await page.click("#left-panel-toggle");
const collapsedLabel = await page.$eval("#left-panel-toggle", (b) => [b.getAttribute("aria-expanded"), b.getAttribute("aria-label")]);
await page.click("#left-panel-toggle");
const expandedLabel = await page.$eval("#left-panel-toggle", (b) => [b.getAttribute("aria-expanded"), b.getAttribute("aria-label")]);
check("panel toggle updates aria-expanded and its label both ways",
  collapsedLabel[0] === "false" && /^Expand/.test(collapsedLabel[1]) &&
  expandedLabel[0] === "true" && /^Collapse/.test(expandedLabel[1]),
  JSON.stringify([collapsedLabel, expandedLabel]));

// The panel toggles above animate the grid columns (160ms); measure once that
// has settled, or the "before" is a frame from mid-transition.
await sleep(300);
const canvasWhenIdle = (await layout(page)).canvas;
const code = await startSession(page);
l = await layout(page);
check("pending: the code card is shown while the code is usable", l.session === "pending" && l.card, code);
// It used to sit in the document flow, pushing the whole workspace down and
// shrinking the remote screen area the moment a session was created.
check("pending: the code card does not resize or move the remote screen",
  Math.abs(l.canvas.w - canvasWhenIdle.w) < 1 && Math.abs(l.canvas.y - canvasWhenIdle.y) < 1,
  `${JSON.stringify(canvasWhenIdle)} → ${JSON.stringify(l.canvas)}`);
check("pending: the placeholder says we are waiting for the customer", l.overlay && l.overlayPending);

// The copy handler must change the label, not wipe the icon. Clipboard access may
// be refused headless; either outcome must leave the button intact and throw nothing.
await page.click("#copy-link");
await sleep(1700);
check("Copy Link keeps its icon after being used",
  await page.$eval("#copy-link", (b) => b.querySelector("svg") !== null && b.textContent.trim() === "Copy Link"),
  await page.$eval("#copy-link", (b) => b.innerHTML.trim().slice(0, 60)));
await page.click("#copy-code");
await sleep(1700);
check("Copy Code keeps its icon and its label too",
  await page.$eval("#copy-code", (b) => b.querySelector("svg") !== null && b.textContent.trim() === "Copy Code"),
  await page.$eval("#copy-code", (b) => b.innerHTML.trim().slice(0, 60)));

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
check("live: the placeholder's button is gone, so it cannot take a canvas click",
  !l.idleButton);
const mirrors = async () => page.evaluate(() => ({
  hint: document.getElementById("input-hint").textContent,
  bar: document.getElementById("statusbar-input").textContent,
  pill: document.getElementById("status").textContent,
  barState: document.querySelector(".statusbar-connection").textContent,
}));
let m = await mirrors();
check("live: the status bar's input and connection read the same as their sources",
  m.bar === m.hint && m.bar.length > 0 && m.barState === m.pill, JSON.stringify(m));
const canvasBeforeFocus = (await layout(page)).canvas;
await page.click("#remote");
await sleep(150);
m = await mirrors();
check("…and follow them when the canvas takes focus", m.hint === "input active" && m.bar === m.hint, JSON.stringify(m));
// #input-hint shares a row with the special keys and gets SHORTER on focus. If
// that row is allowed to reflow, the canvas moves at the exact moment of the
// click that focused it — and the mousedown handler focuses before reading the
// rect, so that click maps to the wrong remote pixel.
const canvasAfterFocus = (await layout(page)).canvas;
check("taking focus does not move or resize the remote screen",
  JSON.stringify(canvasBeforeFocus) === JSON.stringify(canvasAfterFocus),
  `${JSON.stringify(canvasBeforeFocus)} → ${JSON.stringify(canvasAfterFocus)}`);
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
  // Rounded corners on the canvas are not cosmetic: they clip real pixels of the
  // customer's desktop and Chrome hit-tests the rounded-away area to the parent,
  // so a click on the Start button or a window's X never reaches the machine.
  check(`${label}: the canvas has square corners, so the extreme corners are reachable`,
    await page.$eval("#remote", (c) => {
      const r = getComputedStyle(c);
      return [r.borderTopLeftRadius, r.borderTopRightRadius, r.borderBottomLeftRadius, r.borderBottomRightRadius]
        .every((v) => parseFloat(v) === 0);
    }),
    await page.$eval("#remote", (c) => getComputedStyle(c).borderRadius));
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
// `data-planned` is the marker; the tooltip is prose for the technician, so it is
// checked separately rather than being the marker itself.
const toolbar = await page.$$eval(".session-toolbar button", (bs) => bs.map((b) => ({
  id: b.id, planned: b.hasAttribute("data-planned"), disabled: b.disabled,
  title: b.title ?? "",
  name: (b.getAttribute("aria-label") ?? b.textContent).trim(),
})));
const planned = toolbar.filter((b) => b.planned);
check("every planned toolbar feature is disabled", planned.length > 0 && planned.every((b) => b.disabled),
  planned.filter((b) => !b.disabled).map((b) => b.name).join(", ") || `${planned.length} planned`);
check("every planned toolbar feature says so in its tooltip",
  planned.every((b) => /planned/i.test(b.title)),
  planned.filter((b) => !/planned/i.test(b.title)).map((b) => b.name).join(", "));
check("every toolbar button has an accessible name", toolbar.every((b) => b.name.length > 0));
check("every toolbar button has a tooltip", toolbar.every((b) => b.title.length > 0),
  toolbar.filter((b) => !b.title.length).map((b) => b.id || b.name).join(", "));
check("the only working toolbar controls are the implemented ones",
  JSON.stringify(toolbar.filter((b) => !b.planned).map((b) => b.id).sort()) ===
  JSON.stringify(["end-session", "start-session", "toggle-fullscreen", "toolbar-more", "toolbar-scripts"]),
  toolbar.filter((b) => !b.planned).map((b) => b.id).join(", "));

/* --- 4b. the inspector tabs ---------------------------------------------------- */
// Switching tabs is show/hide only: nothing behind a hidden tab may be torn down,
// or a script's output would vanish when the technician looks at something else.
console.log("\n[17] inspector tabs");
const tabState = () => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll(".panel-tab")].map((t) => [
    t.dataset.tab,
    { selected: t.getAttribute("aria-selected") === "true",
      shown: !document.getElementById(t.getAttribute("aria-controls")).hidden },
  ])));
let tabs = await tabState();
check("Tools is the tab that is open by default",
  tabs.tools.selected && tabs.tools.shown && !tabs.scripts.shown && !tabs.chat.shown && !tabs.notes.shown,
  JSON.stringify(tabs));
await page.click("#tab-scripts");
tabs = await tabState();
check("selecting Scripts shows that pane and hides the others",
  tabs.scripts.selected && tabs.scripts.shown && !tabs.tools.shown, JSON.stringify(tabs));
// The output pane is the thing that must survive a tab round-trip.
await page.evaluate(() => { document.getElementById("script-output").textContent = "survivor"; });
await page.click("#tab-chat");
await page.click("#tab-scripts");
check("a hidden tab keeps its state — the script output survives the round trip",
  (await page.$eval("#script-output", (e) => e.textContent)) === "survivor");
await page.evaluate(() => { document.getElementById("script-output").textContent = ""; });
await page.click("#tab-tools");
check("Chat and Notes say they are not implemented yet, and simulate nothing",
  await page.evaluate(() => {
    const t = (id) => document.getElementById(id).textContent.toLowerCase();
    return /next feature phase/.test(t("chat-section")) && /next feature phase/.test(t("notes-section"))
      && document.querySelectorAll("#chat-section input, #chat-section textarea, #notes-section textarea").length === 0;
  }));

/* --- 4c. the More overflow at narrow widths ------------------------------------ */
// Below 1280px the Support group becomes this menu instead of a toolbar wide
// enough to scroll sideways. One DOM subtree, so the buttons are never doubled.
const menuShown = (p) => p.evaluate(() => {
  const g = document.querySelector(".toolbar-support");
  return { display: getComputedStyle(g).display, inWindow: g.getBoundingClientRect().right <= innerWidth };
});
const narrow = await openConsole(browser, BASE, { viewport: { width: 1200, height: 800 } });
await sleep(150);
check("narrow: the support group is folded away until More is pressed",
  (await menuShown(narrow)).display === "none");
check("narrow: support buttons are not duplicated anywhere",
  await narrow.$$eval('[aria-label="Send File"]', (b) => b.length) === 1);
await narrow.click("#toolbar-more");
await sleep(150);
let menu = await menuShown(narrow);
check("narrow: More opens the menu, on screen", menu.display === "flex" && menu.inWindow, JSON.stringify(menu));
check("narrow: More reports its state to assistive tech",
  (await narrow.$eval("#toolbar-more", (b) => b.getAttribute("aria-expanded"))) === "true");
// Somewhere inert: NOT the canvas, whose centre is where the idle placeholder's
// own New Session button sits.
await narrow.click(".viewport-title");
await sleep(150);
check("narrow: a click outside closes it again", (await menuShown(narrow)).display === "none");
const narrowScroll = await narrow.evaluate(() => ({
  x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("narrow: still no horizontal page scroll", !narrowScroll.x);
await narrow.close();

/* --- 4d. both New Session buttons run the same flow ----------------------------- */
const idlePage = await openConsole(browser, BASE, { viewport: { width: 1440, height: 900 } });
await sleep(150);
await idlePage.click("#idle-new-session");
await idlePage.waitForFunction(
  () => document.getElementById("code").textContent.trim() !== "------", { timeout: 5000 });
check("the idle screen's New Session button creates a real session",
  /^[0-9]{6}$/.test(await idlePage.$eval("#code", (e) => e.textContent.trim())),
  await idlePage.$eval("#code", (e) => e.textContent.trim()));
check("…and both New Session buttons are disabled together while it is created",
  await idlePage.evaluate(() => document.getElementById("start-session").disabled
    && document.getElementById("idle-new-session").disabled));
check("no uncaught page errors on the idle-start page", idlePage.errors.length === 0, idlePage.errors.join(" | "));
await idlePage.close();

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
