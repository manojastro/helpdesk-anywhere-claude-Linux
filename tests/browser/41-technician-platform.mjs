/**
 * Technician Platform 2.0, Phase 1 — the console a technician actually sees.
 *
 *   - idle screen: today's cards and recent sessions (from the record), while the
 *     placeholder itself still takes no click
 *   - New Session card: grouped PIN, live expiry countdown, Copy Invitation text
 *   - workspace header: device, session reference, elevated chip
 *   - connection health from relay-measured round trips (never invented)
 *   - zoom − / + steps
 *   - Dashboard dialog: cards, queue (click switches), search and filter over
 *     history, 4 / 4 limit message; typing in it reaches no remote machine
 *   - the lifecycle phase from the relay shown in Info
 *   - Reboot is gone (owner decision D-018); Monitor/Quality are honest "planned"
 */
import { launch, openConsole } from "../lib/browser.mjs";
import { BASE, URL_WS, WebSocket, sleep } from "../lib/harness.mjs";
import { active } from "../lib/session.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const cookie = process.env.HDA_AGENT_COOKIE;

console.log("\n=== Technician Platform 2.0 — Phase 1 console ===\n");

// One finished session today, so the record has something to show.
const past = await active(cookie, { machine: "FIN-LAPTOP-07", user: "dave", label: "past" });
await sleep(200);
past.agent.send(JSON.stringify({ t: "agent.end" }));
await sleep(600);

const browser = await launch();
const page = await openConsole(browser, BASE, { viewport: { width: 1440, height: 900 } });
await page.waitForFunction(() => window.hdaConsole?.me && window.hdaSessions, { timeout: 5000 });

/* --- 1. idle screen ------------------------------------------------------------- */
console.log("[41] idle dashboard");
await page.waitForFunction(() => /FIN-LAPTOP-07/.test(document.querySelector("[data-dash-recent-compact]")?.textContent ?? ""), { timeout: 6000 })
  .catch(() => {});
const idle = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("#idle-dashboard .dash-card")].map((c) => [
    c.querySelector(".dash-card-label").textContent, c.querySelector(".dash-card-value").textContent]);
  const dash = document.getElementById("idle-dashboard");
  return {
    cards: Object.fromEntries(cards),
    recent: document.querySelector("[data-dash-recent-compact]").textContent,
    visible: dash.getBoundingClientRect().height > 0,
    dashPointer: getComputedStyle(dash).pointerEvents,
    overlayPointer: getComputedStyle(document.getElementById("viewport-empty")).pointerEvents,
  };
});
check("idle: four cards — Active, Waiting, Reconnecting, Completed today", Object.keys(idle.cards).join("|") === "Active|Waiting|Reconnecting|Completed today", JSON.stringify(idle.cards));
check("idle: Completed today comes from the record (1)", idle.cards["Completed today"] === "1", JSON.stringify(idle.cards));
check("idle: recent sessions list the finished one", /FIN-LAPTOP-07/.test(idle.recent) && /Completed/.test(idle.recent), idle.recent);
check("idle: the placeholder still takes no click; only the dashboard inside it does",
  idle.visible && idle.overlayPointer === "none" && idle.dashPointer === "auto", JSON.stringify(idle));

/* --- 2. toolbar ------------------------------------------------------------------ */
console.log("\n[41] toolbar");
const toolbar = await page.evaluate(() => [...document.querySelectorAll(".session-toolbar button")].map((b) => ({
  id: b.id, label: b.getAttribute("aria-label") ?? b.textContent.trim(), planned: b.hasAttribute("data-planned"), disabled: b.disabled })));
check("Reboot is not offered (D-018: no remote restart)", !toolbar.some((b) => /reboot|restart/i.test(b.label)));
check("Monitor selection and Stream quality are present, planned and disabled",
  ["Monitor selection", "Stream quality"].every((n) => toolbar.some((b) => b.label === n && b.planned && b.disabled)));
check("zoom − / + are disabled with no session", toolbar.filter((b) => b.id === "zoom-in" || b.id === "zoom-out").every((b) => b.disabled));

/* --- 3. new session card ---------------------------------------------------------- */
console.log("\n[41] New Session card");
await page.evaluate(() => {
  window.__copied = [];
  navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); };
});
await page.click("#idle-new-session");
await page.waitForFunction(() => /^[0-9]{6}$/.test(document.getElementById("code").textContent.trim()), { timeout: 5000 });
const card = await page.evaluate(() => ({
  code: document.getElementById("code").textContent.trim(),
  groups: [...document.getElementById("code").children].map((c) => c.textContent),
  expiry: document.getElementById("code-expiry").textContent,
  wait: document.getElementById("code-wait-text").textContent,
  link: document.getElementById("join-url").textContent,
  title: document.querySelector(".session-card-title").textContent,
}));
check("the PIN is shown in two groups of three; its text is still the six digits",
  card.groups.length === 2 && card.groups.join("") === card.code, JSON.stringify(card.groups));
const secs = (t) => { const m = /(\d\d):(\d\d)/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
check("an expiry countdown from the relay's TTL (≈ 10:00)", /^Expires in \d\d:\d\d$/.test(card.expiry) && secs(card.expiry) > 580 && secs(card.expiry) <= 600, card.expiry);
check("…and it says it is waiting for the customer", /Waiting for customer/.test(card.wait), card.wait);
await sleep(2200);
const later = await page.$eval("#code-expiry", (e) => e.textContent);
check("the countdown moves", secs(later) < secs(card.expiry), `${card.expiry} → ${later}`);

await page.click("#copy-invite");
await page.click("#copy-code");
await page.click("#copy-link");
const copied = await page.evaluate(() => window.__copied);
check("Copy Invitation copies a message with the PIN and the link",
  copied[0]?.includes(`Support PIN: ${card.code}`) && copied[0]?.includes(card.link) && /ready to assist you/.test(copied[0]), JSON.stringify(copied[0]));
check("Copy PIN copies just the six digits; Copy Link just the link", copied[1] === card.code && copied[2] === card.link, JSON.stringify(copied.slice(1)));
check("the invitation never carries anything but the PIN and link (no session id, no token)",
  !/resume|token|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(copied[0] ?? ""));

/* --- 4. customer connects ------------------------------------------------------------- */
console.log("\n[41] connected workspace");
const host = new WebSocket(URL_WS);
host.received = [];
host.on("message", (d, bin) => host.received.push(bin ? { t: "<binary>" } : JSON.parse(d.toString())));
await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
host.send(JSON.stringify({ t: "host.join", code: card.code, machine: "JOHN-PC", user: "john", os: "Windows 11 Pro" }));
await sleep(300);
host.send(JSON.stringify({ t: "host.consent", accepted: true }));
await page.waitForFunction(() => document.body.dataset.session === "live", { timeout: 5000 });
const jpeg = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 360;
  c.getContext("2d").fillRect(0, 0, 640, 360);
  return c.toDataURL("image/jpeg").split(",")[1];
});
host.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(jpeg, "base64")]), { binary: true });
await sleep(300);

const hdr = await page.evaluate(() => ({
  device: [document.getElementById("header-session-device").hidden, document.getElementById("header-session-device").textContent],
  id: [document.getElementById("header-session-id").hidden, document.getElementById("header-session-id").textContent],
  elevated: document.getElementById("header-session-elevated").hidden,
}));
check("header shows the machine and its OS", !hdr.device[0] && hdr.device[1] === "JOHN-PC · Windows 11 Pro", JSON.stringify(hdr.device));
check("header shows the permanent session reference", !hdr.id[0] && /^HDA-[0-9A-F]{8}$/.test(hdr.id[1]), JSON.stringify(hdr.id));
check("no Elevated chip on a standard session", hdr.elevated === true);
check("the PIN card is gone once the customer joined (single use)", await page.$eval("#code-block", (e) => getComputedStyle(e).display === "none" || e.hidden));

await page.waitForFunction(() => /ms$/.test(document.getElementById("statusbar-latency").textContent), { timeout: 9000 }).catch(() => {});
const health = await page.evaluate(() => ({
  q: document.getElementById("statusbar-quality").textContent,
  grade: document.getElementById("statusbar-quality").dataset.grade,
  lat: document.getElementById("statusbar-latency").textContent,
}));
check("connection quality is graded from a real measurement", ["Excellent", "Good"].includes(health.q) && health.grade !== "", JSON.stringify(health));
check("latency shows the measured round trip", /^\d+ ms$/.test(health.lat), health.lat);

/* --- 5. zoom steps ---------------------------------------------------------------------- */
console.log("\n[41] zoom steps");
const zoomVal = () => page.$eval("#zoom", (s) => s.value);
await page.click("#zoom-in");
const z1 = await zoomVal();
await page.click("#zoom-in");
const z2 = await zoomVal();
await page.click("#zoom-out");
await page.click("#zoom-out");
const z3 = await zoomVal();
check("+ from Fit goes to 100%, then 125%", z1 === "1" && z2 === "1.25", `${z1}, ${z2}`);
check("− steps back down (75%)", z3 === "0.75", z3);
await page.select("#zoom", "fit");

/* --- 6. phase in Info -------------------------------------------------------------------- */
console.log("\n[41] relay lifecycle phase");
await page.click("#remote");
await page.keyboard.press("KeyQ");
await sleep(400);
await page.click("#tab-info");
const info = await page.$eval("#session-info", (e) => e.textContent);
check("Info shows the relay's lifecycle phase (CONTROLLING after input)", /Lifecycle phase\s*CONTROLLING/.test(info), info.slice(0, 200));
check("Info shows the connection quality", /Connection quality\s*(Excellent|Good)/.test(info));
await page.click("#tab-tools");

/* --- 7. dashboard dialog ----------------------------------------------------------------- */
console.log("\n[41] Dashboard dialog");
host.received.length = 0;
await page.click("#open-dashboard");
await page.waitForFunction(() => document.getElementById("dashboard-modal").open, { timeout: 3000 });
await page.waitForFunction(() => document.querySelectorAll("#dash-recent tbody tr").length > 0, { timeout: 5000 }).catch(() => {});
const dash = await page.evaluate(() => ({
  cards: Object.fromEntries([...document.querySelectorAll("#dashboard-modal .dash-card")].map((c) => [
    c.querySelector(".dash-card-label").textContent, c.querySelector(".dash-card-value").textContent])),
  queue: [...document.querySelectorAll("#dash-queue tbody tr")].map((r) => r.textContent),
  slots: document.getElementById("dash-slots").textContent,
  limitShown: !document.getElementById("dash-limit").hidden,
  recent: [...document.querySelectorAll("#dash-recent tbody tr")].map((r) => r.textContent),
}));
check("cards: 1 active, Completed today 1", dash.cards.Active === "1" && dash.cards["Completed today"] === "1", JSON.stringify(dash.cards));
check("queue lists the live session with user, device and status", dash.queue.length === 1 && /john/.test(dash.queue[0]) && /JOHN-PC/.test(dash.queue[0]) && /Connected/.test(dash.queue[0]), JSON.stringify(dash.queue));
check("slots read 1 / 4, no limit warning", /1 \/ 4/.test(dash.slots) && !dash.limitShown, dash.slots);
check("recent history lists the finished session", dash.recent.some((r) => /FIN-LAPTOP-07/.test(r) && /Completed/.test(r)), JSON.stringify(dash.recent));

await page.type("#dash-search", "zzz-no-such-device");
await page.waitForFunction(() => !document.getElementById("dash-recent-empty").hidden, { timeout: 4000 }).catch(() => {});
check("search narrows history (no match → empty notice)",
  await page.evaluate(() => !document.getElementById("dash-recent-empty").hidden && document.querySelectorAll("#dash-recent tbody tr").length === 0));
await sleep(200);
check("typing in the dashboard reached no remote machine", !host.received.some((m) => m.t === "agent.input" && m.kind === "key"),
  JSON.stringify(host.received.filter((m) => m.t === "agent.input").slice(0, 3)));
await page.$eval("#dash-search", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); });
await page.select("#dash-filter", "DECLINED");
await sleep(800);
check("filter by result (Declined → nothing here)", await page.evaluate(() => document.querySelectorAll("#dash-recent tbody tr").length === 0));
await page.select("#dash-filter", "");
await sleep(600);

await page.click("#dash-queue tbody tr");
await sleep(200);
check("clicking a queue row closes the dashboard and selects that session",
  await page.evaluate(() => !document.getElementById("dashboard-modal").open && window.hdaSessions.list().some((s) => s.selected && s.label === "JOHN-PC")));

/* --- 8. at the limit ------------------------------------------------------------------------ */
console.log("\n[41] 4 / 4");
for (let i = 0; i < 3; i++) {
  await page.click("#start-session");
  await page.waitForFunction((n) => window.hdaSessions.list().filter((s) => s.state === "waiting").length === n, { timeout: 5000 }, i + 1);
}
await page.click("#open-dashboard");
await sleep(300);
const full = await page.evaluate(() => ({
  slots: document.getElementById("dash-slots").textContent,
  limit: !document.getElementById("dash-limit").hidden ? document.getElementById("dash-limit").textContent.replace(/\s+/g, " ").trim() : null,
  newDisabled: document.getElementById("dash-new").disabled,
  waitingCard: [...document.querySelectorAll("#dashboard-modal .dash-card")].find((c) => /Waiting/.test(c.textContent))?.querySelector(".dash-card-value").textContent,
  rows: document.querySelectorAll("#dash-queue tbody tr").length,
}));
check("4 / 4: the limit message is shown and New Session is disabled",
  /4 \/ 4/.test(full.slots) && full.limit === "Maximum concurrent session limit reached. End or transfer a session before starting another." && full.newDisabled, JSON.stringify(full));
check("…the queue shows all four, three of them waiting", full.rows === 4 && full.waitingCard === "3", JSON.stringify(full));
await page.click("#dash-close");

check("no uncaught page errors", page.errors.length === 0, page.errors.join(" | "));

await page.evaluate(() => document.getElementById("disconnect-all").click());
await page.click("#disconnect-all-confirm");
await sleep(500);
host.close();
await browser.close();
console.log(`\n--- browser/41 technician platform: ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
