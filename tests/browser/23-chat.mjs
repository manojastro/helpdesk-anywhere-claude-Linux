/**
 * Feature Batch 2 — chat, Send URL, predefined replies, history & notes
 * (console side).
 *
 * The one requirement this batch cannot be allowed to get wrong is keyboard
 * isolation (§15): a keystroke typed into the chat composer, the notes
 * textarea, the quick-reply editor or the Send URL dialog must never reach the
 * customer's machine. This is proven the same way `tests/browser/12` proves
 * remote input works at all — by watching what the REAL HOST SOCKET receives
 * through the real relay, not by reading portal.js's source and trusting it.
 *
 * What is deliberately NOT claimed here: this proves what the console SENDS
 * and RENDERS. `MANUAL_TESTS.md` MT-08 is the Windows half — the applet's own
 * compact chat window, and that the customer never sees a technician's notes.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { WebSocket, BASE, URL_WS, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();

console.log("\n=== Feature Batch 2 — chat, Send URL, predefined replies, history & notes ===\n");

/* --- a small remote frame, so the canvas is live and clickable --------------- */
const maker = await browser.newPage();
await maker.goto("about:blank");
const frameB64 = await maker.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 800; c.height = 450;
  const x = c.getContext("2d");
  x.fillStyle = "#202020"; x.fillRect(0, 0, 800, 450);
  return c.toDataURL("image/jpeg", 0.6).split(",")[1];
});
await maker.close();
const fullFrame = () => Buffer.concat([Buffer.from([0x01]), Buffer.from(frameB64, "base64")]);

/**
 * `startSession()` in `../lib/browser.mjs` waits only for `#code` to differ
 * from the placeholder "------", which is already true the moment a SECOND
 * session starts on the same page (the old code is still showing). Reconnect
 * tests need the actual new code, so this also waits for it to differ from
 * whatever was there before.
 */
async function startAnotherSession(page, previousCode) {
  await page.click("#start-session");
  await page.waitForFunction((prev) => {
    const t = document.getElementById("code").textContent.trim();
    return t !== "------" && t !== prev;
  }, { timeout: 5000 }, previousCode);
  return page.$eval("#code", (e) => e.textContent.trim());
}

async function connectSession(page, previousCode) {
  const code = previousCode ? await startAnotherSession(page, previousCode) : await startSession(page);
  const host = new WebSocket(URL_WS);
  host.received = [];
  host.on("message", (d, bin) => host.received.push(bin ? { t: "<binary>" } : JSON.parse(d.toString())));
  await new Promise((res, rej) => { host.once("open", res); host.once("error", rej); });
  host.send(JSON.stringify({ t: "host.join", code, machine: "WIN-CHAT", user: "alice", os: "Windows 11" }));
  await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Awaiting consent…",
    { timeout: 5000 }).catch(() => {});
  host.send(JSON.stringify({ t: "host.consent", accepted: true }));
  await page.waitForFunction(() => document.getElementById("status").textContent.trim() === "Connected", { timeout: 5000 });
  host.send(fullFrame());
  await page.waitForFunction(() => document.getElementById("remote").width === 800, { timeout: 5000 });
  await sleep(150);
  return { code, host };
}

function inputCount(host) {
  return host.received.filter((m) => m.t === "agent.input" && m.kind === "key").length;
}

const page = await openConsole(browser, BASE, { viewport: { width: 1600, height: 1000 } });
const errors = page.errors;
let { host, code } = await connectSession(page);

/* --- 1. Chat tab opens and the composer follows session state --------------- */
console.log("[23] chat tab");
await page.click("#toolbar-chat");
check("Chat tab opens and is selected", await page.$eval("#tab-chat", (t) => t.getAttribute("aria-selected") === "true"));
check("the composer is enabled once connected",
  await page.$eval("#chat-input", (i) => !i.disabled) && await page.$eval("#chat-send", (b) => !b.disabled));
check("chat connection state reads Connected",
  (await page.$eval("#chat-connection", (e) => e.textContent.trim())) === "Connected");

/* --- 2. KEYBOARD ISOLATION — the most important check in this batch --------- */
console.log("\n[23] keyboard isolation (§15)");

let before = inputCount(host);
await page.type("#chat-input", "hello");
await sleep(250);
check("typing in the chat composer sends NOTHING to the remote machine",
  inputCount(host) === before, `${inputCount(host) - before} key frames leaked`);
await page.$eval("#chat-input", (i) => (i.value = ""));

await page.click("#toolbar-history");
before = inputCount(host);
await page.type("#session-notes", "customer's password is hunter2"); // exactly the kind of text §9B warns about
await sleep(250);
check("typing in the notes textarea sends NOTHING to the remote machine",
  inputCount(host) === before);
await page.$eval("#session-notes", (i) => (i.value = ""));

await page.click("#toolbar-chat");
await page.click("#quick-reply-manage");
before = inputCount(host);
await page.type("#quick-reply-add-input", "draft reply");
await sleep(250);
check("typing in the quick-reply editor sends NOTHING to the remote machine",
  inputCount(host) === before);
await page.$eval("#quick-reply-add-input", (i) => (i.value = ""));
await page.click("#quick-reply-editor-close");

await page.click("#toolbar-sendurl");
await page.waitForSelector("#url-modal[open]");
before = inputCount(host);
await page.type("#url-input", "https://example.com");
await sleep(250);
check("typing in the Send URL dialog sends NOTHING to the remote machine",
  inputCount(host) === before);
await page.click("#url-cancel");
await sleep(100);
check("the dialog closed without sending anything",
  await page.$eval("#url-modal", (d) => !d.open));

// The regression this all exists to protect: remote typing still works.
before = inputCount(host);
await page.click("#remote");
await page.keyboard.type("ab");
await sleep(250);
check("…and clicking the remote screen restores normal keyboard forwarding",
  inputCount(host) === before + 4, `expected 4 key frames (2 down + 2 up), got ${inputCount(host) - before}`);

/* --- 3. sending and receiving text ------------------------------------------- */
console.log("\n[23] sending and receiving plain text");
await page.click("#toolbar-chat");
host.received.length = 0;
await page.click("#chat-input");
await page.keyboard.type("I'm connecting to your computer now.");
await page.keyboard.press("Enter");

const sent = await new Promise((resolve) => {
  const check = () => {
    const m = host.received.find((x) => x.t === "chat.message" && x.kind === "text");
    if (m) return resolve(m);
    setTimeout(check, 30);
  };
  check();
});
check("the exact typed text reaches the customer, attributed to the agent",
  sent.senderRole === "agent" && sent.text === "I'm connecting to your computer now.", JSON.stringify(sent));

await sleep(150);
const bubbleText = await page.$$eval(".chat-msg-agent .chat-bubble", (els) => els.map((e) => e.textContent));
check("the message renders in the transcript as a technician bubble",
  bubbleText.includes("I'm connecting to your computer now."));
check("the bubble is no longer marked pending once acknowledged",
  await page.$eval(".chat-msg-agent", (e) => !e.classList.contains("chat-msg-pending")));

/* --- 4. Enter sends, Shift+Enter is a newline -------------------------------- */
console.log("\n[23] Enter sends, Shift+Enter inserts a newline");
await page.$eval("#chat-input", (i) => (i.value = ""));
host.received.length = 0;
await page.click("#chat-input");
await page.keyboard.type("line one");
await page.keyboard.down("Shift");
await page.keyboard.press("Enter");
await page.keyboard.up("Shift");
await page.keyboard.type("line two");
check("Shift+Enter does not submit",
  !host.received.some((m) => m.t === "chat.message"));
const value = await page.$eval("#chat-input", (i) => i.value);
check("…and inserts a newline in the composer", value.includes("\n"), JSON.stringify(value));
await page.keyboard.press("Enter");
const twoLine = await new Promise((resolve) => {
  const poll = () => {
    const m = host.received.find((x) => x.t === "chat.message" && x.text?.includes("line one"));
    if (m) return resolve(m);
    setTimeout(poll, 30);
  };
  poll();
});
check("Enter sends the composer's full (multi-line) content",
  twoLine.text === "line one\nline two", JSON.stringify(twoLine.text));

/* --- 5. XSS payload renders as inert text, never executes -------------------- */
console.log("\n[23] an XSS payload is rendered as plain text, never executed");
await page.evaluate(() => { window.__xss = false; });
host.received.length = 0;
await page.click("#chat-input");
await page.keyboard.type('<img src=x onerror="window.__xss=true">');
await page.keyboard.press("Enter");
await sleep(300);
const xssFired = await page.evaluate(() => window.__xss);
check("the payload never executes", xssFired === false);
const injectedImg = await page.$$eval("#chat-log img", (els) => els.length);
check("…and no <img> element was created from it (textContent only, never innerHTML)", injectedImg === 0);
const rawShown = await page.$$eval(".chat-msg-agent .chat-bubble", (els) => els.some((e) =>
  e.textContent.includes("<img src=x onerror=")));
check("…the raw tag text is shown as literal characters, not stripped", rawShown);

/* --- 6. incoming message, unread badge -------------------------------------- */
console.log("\n[23] incoming message and the unread badge (§13)");
await page.click("#tab-tools"); // Chat tab no longer the active one
host.send(JSON.stringify({ t: "host.chat", text: "It's stuck on 40%.", clientId: "b1" }));
await page.waitForFunction(() => {
  const b = document.getElementById("chat-unread");
  return !b.hidden && b.textContent === "1";
}, { timeout: 3000 });
check("an unread badge appears on the Chat tab while it is not open", true);

await page.click("#tab-chat");
await sleep(100);
check("opening Chat clears the unread badge",
  await page.$eval("#chat-unread", (b) => b.hidden));
const hostBubble = await page.$$eval(".chat-msg-host .chat-bubble", (els) => els.map((e) => e.textContent));
check("the customer's message renders as a host bubble", hostBubble.includes("It's stuck on 40%."));

/* --- 7. predefined / quick replies (§8) -------------------------------------- */
console.log("\n[23] predefined replies — populate, edit, send; never auto-sent");
const options = await page.$$eval("#quick-reply-select option", (els) => els.map((e) => e.textContent));
check("the default quick replies are present", options.some((t) => t.includes("Please show me the issue")));

host.received.length = 0;
await page.select("#quick-reply-select", "0");
const composed = await page.$eval("#chat-input", (i) => i.value);
check("selecting a reply populates the composer", composed.length > 0, composed);
await sleep(150);
check("…without sending it", !host.received.some((m) => m.t === "chat.message"));

await page.type("#chat-input", " (edited)");
await page.keyboard.press("Enter");
const edited = await new Promise((resolve) => {
  const poll = () => {
    const m = host.received.find((x) => x.t === "chat.message" && x.text?.endsWith("(edited)"));
    if (m) return resolve(m);
    setTimeout(poll, 30);
  };
  poll();
});
check("the customer receives the EDITED version, proving it was reviewable before Send",
  edited.text === `${composed} (edited)`, edited.text);

// Manage: add, edit, remove.
await page.click("#quick-reply-manage");
await page.type("#quick-reply-add-input", "Test reply xyz");
await page.click("#quick-reply-add-submit");
let listed = await page.$$eval("#quick-reply-list li span", (els) => els.map((e) => e.textContent));
check("Add appends a new template", listed.includes("Test reply xyz"), JSON.stringify(listed));

// Edit it.
const editButtons = await page.$$("#quick-reply-list li");
const targetLi = await page.evaluateHandle(() => [...document.querySelectorAll("#quick-reply-list li")]
  .find((li) => li.querySelector("span").textContent === "Test reply xyz"));
await targetLi.evaluate((li) => li.querySelector("button").click()); // "Edit" is the first button
await page.$eval("#quick-reply-add-input", (i) => (i.value = ""));
await page.type("#quick-reply-add-input", "Test reply xyz (renamed)");
await page.click("#quick-reply-add-submit");
listed = await page.$$eval("#quick-reply-list li span", (els) => els.map((e) => e.textContent));
check("Edit replaces the template in place, rather than adding a second one",
  listed.includes("Test reply xyz (renamed)") && !listed.includes("Test reply xyz") &&
  listed.filter((t) => t.startsWith("Test reply xyz")).length === 1,
  JSON.stringify(listed));

const renamedLi = await page.evaluateHandle(() => [...document.querySelectorAll("#quick-reply-list li")]
  .find((li) => li.querySelector("span").textContent === "Test reply xyz (renamed)"));
await renamedLi.evaluate((li) => li.querySelectorAll("button")[1].click()); // "Remove" is the second button
listed = await page.$$eval("#quick-reply-list li span", (els) => els.map((e) => e.textContent));
check("Remove deletes the template", !listed.some((t) => t.startsWith("Test reply xyz")));
await page.click("#quick-reply-editor-close");

/* --- 8. Send URL (§7) --------------------------------------------------------- */
console.log("\n[23] Send URL — validated, never auto-opened");
await page.click("#toolbar-sendurl");
await page.waitForSelector("#url-modal[open]");
await page.type("#url-input", "javascript:alert(1)");
await page.click("#url-send");
const urlErr = await page.$eval("#url-error", (e) => e.textContent);
check("an unsafe scheme is rejected client-side with a visible error", urlErr.length > 0, urlErr);
check("…and the dialog stays open", await page.$eval("#url-modal", (d) => d.open));

await page.$eval("#url-input", (i) => (i.value = ""));
await page.type("#url-input", "https://support.example.com/kb/42");
await page.type("#url-label-input", "Knowledge article");
host.received.length = 0;
await page.click("#url-send");
const urlMsg = await new Promise((resolve) => {
  const poll = () => {
    const m = host.received.find((x) => x.t === "chat.message" && x.kind === "url");
    if (m) return resolve(m);
    setTimeout(poll, 30);
  };
  poll();
});
check("a valid https:// link is sent with its label",
  urlMsg.url === "https://support.example.com/kb/42" && urlMsg.label === "Knowledge article", JSON.stringify(urlMsg));
check("the dialog closes and returns to Chat", await page.$eval("#url-modal", (d) => !d.open));

const link = await page.$eval(".chat-msg-agent .chat-url-card a", (a) => (
  { href: a.href, target: a.target, rel: a.rel, text: a.textContent }));
check("it renders as a clickable link, not auto-navigated",
  link.href === "https://support.example.com/kb/42" && link.target === "_blank" &&
  link.rel.includes("noopener") && link.rel.includes("noreferrer"), JSON.stringify(link));

/* --- 9. session notes (§9B/§9C) ------------------------------------------------ */
console.log("\n[23] session notes — private, per-session");
await page.click("#toolbar-history");
await page.type("#session-notes", "Reinstalled the printer driver.");
await page.click("#save-notes");
await sleep(50);
check("saving shows a confirmation",
  (await page.$eval("#notes-saved-hint", (e) => e.textContent)).length > 0);

const historyItems = await page.$$eval("#notes-history li", (els) => els.map((e) => e.textContent));
check("the History timeline shows real events, not fabricated ones",
  historyItems.some((t) => t.includes("Chat started")) && historyItems.some((t) => t.includes("Consent accepted")),
  JSON.stringify(historyItems));

await page.click("#toolbar-chat");
await page.click("#toolbar-history");
check("notes survive switching inspector tabs",
  (await page.$eval("#session-notes", (i) => i.value)) === "Reinstalled the printer driver.");

/* --- 10. Hold: chat keeps working, remote input stays blocked ---------------- */
console.log("\n[23] Hold pauses remote control, not chat (Feature Batch 1 + 2)");
await page.click("#toolbar-chat");
await page.click("#hold-session");
await page.waitForFunction(() => document.body.dataset.hold === "on");
check("the composer stays enabled while held",
  await page.$eval("#chat-input", (i) => !i.disabled));

before = inputCount(host);
await page.click("#remote");
await page.keyboard.type("z");
await sleep(200);
check("remote keyboard input is still blocked while held",
  inputCount(host) === before);

host.received.length = 0;
await page.click("#chat-input");
await page.keyboard.type("still here");
await page.keyboard.press("Enter");
check("chat is delivered while the session is on hold",
  !!(await new Promise((resolve) => {
    const poll = () => {
      const m = host.received.find((x) => x.t === "chat.message" && x.text === "still here");
      if (m) return resolve(m);
      setTimeout(poll, 30);
    };
    poll();
    setTimeout(() => resolve(null), 2000);
  })));
await page.click("#resume-session");
await page.waitForFunction(() => document.body.dataset.hold !== "on");

/* --- 11. ending a session clears chat and notes for the next one ------------- */
console.log("\n[23] ending a session clears chat and notes (never leaked to the next customer)");
await page.click("#end-session");
await page.waitForFunction(() => document.getElementById("status").textContent.trim() !== "Connected", { timeout: 5000 });
({ host, code } = await connectSession(page, code));
await page.click("#toolbar-chat");
check("chat starts empty for the new session",
  await page.$eval("#chat-log", (l) => l.textContent.includes("No messages yet")));
await page.click("#toolbar-history");
check("notes start empty for the new session",
  (await page.$eval("#session-notes", (i) => i.value)) === "");

/* --- 12. no page errors, no runaway layout ----------------------------------- */
check("no uncaught page errors", errors.length === 0, JSON.stringify(errors));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
check("no horizontal page scroll", !overflow);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
