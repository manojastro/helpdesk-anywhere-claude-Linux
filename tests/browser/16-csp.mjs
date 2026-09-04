/**
 * Content-Security-Policy — the header, and proof it breaks neither page.
 *
 * A CSP failure is not a page error. The browser blocks the resource, logs to a
 * console the suite is not watching, and renders a page that looks nearly right
 * — which is exactly how "the one page a stressed end user has to follow" ends
 * up silently broken. So this block does not ask whether the pages loaded; it
 * registers a `securitypolicyviolation` listener before navigation and asserts
 * the count is zero, then asserts the things the scripts were supposed to do
 * actually happened.
 *
 * The console half matters most: `connect-src 'self'` has to admit the
 * same-origin `/ws` upgrade, and nothing but a real browser settles that.
 */
import { launch, openConsole, startSession } from "../lib/browser.mjs";
import { BASE, sleep } from "../lib/harness.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Collect CSP violations from inside the page, before anything can load. */
async function watchViolations(page) {
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
}
const violations = (page) => page.evaluate(() => window.__csp ?? []);

console.log("\n=== Content-Security-Policy ===\n");

// ------------------------------------------------------------------ header
console.log("[16] the header itself");
const auth = process.env.CONSOLE_PASSWORD
  ? { Authorization: "Basic " + Buffer.from(
      `${process.env.CONSOLE_USER ?? "agent"}:${process.env.CONSOLE_PASSWORD}`,
    ).toString("base64") }
  : {};

for (const path of ["/", "/j/482913"]) {
  const res = await fetch(`${BASE}${path}`, { headers: auth });
  const csp = res.headers.get("content-security-policy") ?? "";
  check(`${path} sends a CSP`, csp.length > 0, csp.slice(0, 60) + "…");
  check(`${path} locks scripts to 'self'`, /script-src 'self'(;|$)/.test(csp));
  // The whole point of moving join.html's script out to /join.js. If this ever
  // comes back, the policy stops preventing the attack it exists to prevent.
  check(`${path} script-src has no 'unsafe-inline'`,
    !/script-src[^;]*unsafe-inline/.test(csp));
  check(`${path} script-src has no 'unsafe-eval'`,
    !/script-src[^;]*unsafe-eval/.test(csp));
  check(`${path} forbids plugins, <base> and form posts`,
    /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp)
      && /form-action 'none'/.test(csp), csp);
  check(`${path} refuses framing in the modern header too`,
    /frame-ancestors 'none'/.test(csp));
  check(`${path} still sends the older headers`,
    res.headers.get("x-frame-options") === "DENY"
      && res.headers.get("x-content-type-options") === "nosniff");
}

const browser = await launch();

// -------------------------------------------------------------- join page
console.log("\n[16] the join page renders under the policy");
const join = await browser.newPage();
await watchViolations(join);
await join.goto(`${BASE}/j/482913`, { waitUntil: "networkidle0" });

const joinViolations = await violations(join);
check("no CSP violation on the join page", joinViolations.length === 0,
  joinViolations.join(", ") || "none");

// If /join.js were blocked the page would still look fine — apart from this.
const code = await join.$eval("#code", (e) => e.textContent.trim());
check("/join.js ran: the code is filled in", code === "482913", code);
check("…and in the instructions too",
  (await join.$eval("#code-inline", (e) => e.textContent.trim())) === "482913");
check("the inline <style> still applies",
  await join.evaluate(() =>
    getComputedStyle(document.querySelector(".download")).borderRadius === "10px"));

// ---------------------------------------------------------------- console
console.log("\n[16] the console connects to the relay under the policy");
// openConsole navigates as it opens, so arm the listener and reload — otherwise
// every violation from the first load happens before anything is watching.
const consolePage = await openConsole(browser, `${BASE}/`);
await watchViolations(consolePage);
await consolePage.reload({ waitUntil: "networkidle0" });

check("portal.css and portal.js loaded",
  await consolePage.evaluate(() =>
    getComputedStyle(document.body).margin !== "8px"
    && typeof document.getElementById("start-session") === "object"));

// The real question: does connect-src 'self' admit the ws:// upgrade? A session
// code only comes back over the relay, so getting one proves the socket opened.
const sessionCode = await startSession(consolePage).catch(() => null);
check("the WebSocket connected: a code came back", /^\d{6}$/.test(sessionCode ?? ""),
  `code=${sessionCode}`);

await sleep(300);
const consoleViolations = await violations(consolePage);
check("no CSP violation on the console", consoleViolations.length === 0,
  consoleViolations.join(", ") || "none");
check("no uncaught page errors", consolePage.errors.length === 0,
  consolePage.errors.join(" | "));

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
