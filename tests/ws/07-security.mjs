/**
 * Regressions for the 2026-09-03 security review (DEV_NOTES.md → "Security
 * review"). Every check here failed, or was absent, before that review.
 *
 * Run with CONSOLE_PASSWORD set — the console-auth checks are the point.
 */
import { open, send, waitFor, check, report, sleep, WebSocket, BASE, URL_WS } from "../lib/harness.mjs";

const USER = process.env.CONSOLE_USER ?? "agent";
const PASS = process.env.CONSOLE_PASSWORD ?? "";
const basic = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

console.log("\n=== Security review regressions ===\n");

/* --- 1. console auth cannot be walked around with path traversal ------------ */
console.log("[S1] The console-auth check runs on the NORMALISED path");

const status = async (path, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return res.status;
};

check("console page requires credentials", await status("/") === 401);
check("/download/../portal.html does NOT bypass it", await status("/download/../portal.html") === 401,
  `got ${await status("/download/../portal.html")}`);
check("/j/../portal.js does NOT bypass it", await status("/j/../portal.js") === 401);
check("percent-encoded traversal does NOT bypass it",
  await status("/download/..%2fportal.js") === 401);
check("…while the end user's own paths stay open, as they must",
  await status("/j/123456") === 200 && await status("/healthz") === 200);
check("the applet download stays open",
  await status("/download/HelpdeskAnywhere.exe") === 200);
check("correct credentials still work", await status("/", { authorization: basic }) === 200);

/* --- 2. cross-site WebSocket hijacking ------------------------------------- */
console.log("\n[S2] The /ws upgrade refuses a foreign browser Origin");

const upgrade = (origin) => {
  const ws = new WebSocket(URL_WS, origin === null ? {} : { origin });
  return new Promise((res) => {
    ws.once("open", () => { ws.close(); res("open"); });
    ws.once("unexpected-response", (_req, r) => res(`http ${r.statusCode}`));
    ws.once("error", (e) => res(`error ${e.message}`));
  });
};

check("a foreign origin is refused with 403", (await upgrade("https://evil.example")).startsWith("http 403"),
  await upgrade("https://evil.example"));
check("the console's own origin is accepted", await upgrade(BASE) === "open");
// The applet is not a browser and sends no Origin at all. Demanding one would
// break every non-browser client while stopping nothing: Origin is a header the
// browser imposes on its own pages, not a credential.
check("a client with NO origin is accepted (the applet)", await upgrade(null) === "open");

/* --- 3. agent.create is rate-limited and capped ----------------------------- */
console.log("\n[S3] Session creation cannot be run without bound");

// The console's WebSocket is recognised by the cookie its Basic-auth response
// sets, so the test has to authenticate exactly as the browser does — there is
// no way to forge it, the signing key is per-process and random.
const loginRes = await fetch(`${BASE}/`, { headers: { authorization: basic } });
const cookie = (loginRes.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0]).join("; ");
check("authenticating the console sets a cookie for its socket", cookie.startsWith("hda_console="),
  cookie || "<none>");

const authed = () => open("agent", { headers: { cookie } });
const created = [];
let limited = null;

// The limit is CREATE_ATTEMPTS_PER_MINUTE; this block runs with it set to 3.
for (let i = 0; i < 5; i++) {
  const ws = await authed();
  send(ws, { t: "agent.create" });
  const res = await waitFor(ws, (m) => m.t === "session.created" || m.t === "error");
  if (res?.t === "session.created") created.push(res.code);
  else if (res?.t === "error") limited ??= res;
  ws.close();
  await sleep(30);
}

check("the first creates succeed", created.length === 3, `${created.length} created`);
check("further creates are refused rate_limited", limited?.code === "rate_limited",
  JSON.stringify(limited));
check("a refused create issues no code", created.length + 2 === 5);

await sleep(150);
report("security block");
