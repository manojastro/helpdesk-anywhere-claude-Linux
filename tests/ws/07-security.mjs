/**
 * Regressions for the 2026-09-03 security review (DEV_NOTES.md → "Security
 * review"), carried over to the admin-portal release: the shared console
 * password is gone, and the gate is now an Entra (here: dev) sign-in bound to a
 * server-side session. Every property the review established still holds.
 */
import { open, openAgent, send, waitFor, check, report, sleep, WebSocket, BASE, URL_WS, REPO } from "../lib/harness.mjs";

const cookie = process.env.HDA_AGENT_COOKIE ?? "";

console.log("\n=== Security review regressions ===\n");

/* --- 1. the sign-in gate cannot be walked around with path traversal ------- */
console.log("[S1] The console gate runs on the NORMALISED path");

const status = async (path, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return res.status;
};
const refused = (code) => code === 302 || code === 401;

check("console page requires sign-in (redirect to /login)", await status("/") === 302);
check("/download/../portal.html does NOT bypass it", refused(await status("/download/../portal.html")),
  `got ${await status("/download/../portal.html")}`);
check("/j/../portal.js does NOT bypass it", refused(await status("/j/../portal.js")));
check("percent-encoded traversal does NOT bypass it", refused(await status("/download/..%2fportal.js")));
check("/auth/../portal.html does NOT bypass it", refused(await status("/auth/..%2fportal.html")));
check("…while the end user's own paths stay open, as they must",
  await status("/j/123456") === 200 && await status("/healthz") === 200);
check("the applet download stays open", [200, 404].includes(await status("/download/HelpdeskAnywhere.exe")),
  "200 when an .exe is built, 404 otherwise — never a sign-in redirect");
check("a signed-in technician gets the console", await status("/", { cookie }) === 200);
check("a forged session cookie does not", await status("/", { cookie: "hda_agent=" + "A".repeat(43) }) === 302);

/* --- 2. cross-site WebSocket hijacking ------------------------------------- */
console.log("\n[S2] The /ws upgrade: foreign Origin refused, browser needs a session");

const upgrade = (origin, headers = {}) => {
  const ws = new WebSocket(URL_WS, origin === null ? { headers } : { origin, headers });
  return new Promise((res) => {
    ws.once("open", () => { ws.close(); res("open"); });
    ws.once("unexpected-response", (_req, r) => res(`http ${r.statusCode}`));
    ws.once("error", (e) => res(`error ${e.message}`));
  });
};

check("a foreign origin is refused with 403", (await upgrade("https://evil.example", { cookie })).startsWith("http 403"),
  await upgrade("https://evil.example"));
check("the console's own origin WITHOUT a session is refused with 401", await upgrade(BASE) === "http 401");
check("the console's own origin WITH a session is accepted", await upgrade(BASE, { cookie }) === "open");
// The applet is not a browser and sends no Origin and no cookie. It must stay
// able to connect — and can then only ever be a host.
check("a client with NO origin is accepted (the applet)", await upgrade(null) === "open");

const anon = await open("anon");
send(anon, { t: "agent.create" });
const anonErr = await waitFor(anon, (m) => m.t === "error");
check("…but an anonymous socket cannot create a session", anonErr?.code === "unauthorized", JSON.stringify(anonErr));
await sleep(100);
check("…and is closed", anon.readyState === WebSocket.CLOSED);

/* --- 2b. a /ws request that is not an upgrade ------------------------------- */
// A bare GET /ws is not an upgrade, so `ws` never sees it and it falls through
// Express. It used to land on the console's Basic auth and come back 401 — a
// true refusal reported as the wrong kind, which cost an hour on 2026-09-04
// pointed at authentication code that was working. The usual cause is a proxy
// hop that dropped the headers: HTTP/2 forbids `Connection` and `Upgrade`
// outright (RFC 9113 s8.2.2), so any h2 client arrives here.
console.log("\n[S2b] A non-upgrade GET /ws says 426, not 401");

const wsGet = await fetch(`${BASE}/ws`, { redirect: "manual" });
check("a plain GET /ws answers 426 Upgrade Required", wsGet.status === 426, `got ${wsGet.status}`);
check("…with an Upgrade header naming the protocol",
  (wsGet.headers.get("upgrade") ?? "").toLowerCase() === "websocket",
  wsGet.headers.get("upgrade") ?? "<none>");
// It sits ahead of the sign-in gate, so it must not have become a way past it.
check("…and it did not open a hole: the console still needs sign-in",
  await status("/") === 302 && await status("/portal.js") === 401);
check("…and the real upgrade is untouched", await upgrade(null) === "open");

/* --- 3. agent.create is rate-limited and capped ----------------------------- */
console.log("\n[S3] Session creation cannot be run without bound");

const authed = () => openAgent("agent");
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
/* --- 5. the dev flag that disables constraint #6.1 cannot reach a deployment -- */
console.log("\n[S5] ALLOW_INSECURE_DEV is refused on anything that looks public");

const { spawnSync } = await import("node:child_process");

const startWith = (env) =>
  spawnSync(process.execPath, [`${REPO}/server/dist/index.js`], {
    env: { ...process.env, AUDIT_DIR: "/tmp/hda-guard-probe", PORT: "8123", ADMIN_PORT: "8124",
      AUTH_MODE: "entra", ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", ENTRA_CLIENT_SECRET: "s",
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", ADMIN_PUBLIC_HOST: "admin.example.org", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });

const onPublicHost = startWith({ ALLOW_INSECURE_DEV: "1", PUBLIC_HOST: "example.duckdns.org" });
check("a public PUBLIC_HOST with ALLOW_INSECURE_DEV refuses to start",
  onPublicHost.status === 1 && /FATAL: ALLOW_INSECURE_DEV/.test(onPublicHost.stderr),
  onPublicHost.stderr.split("\n")[0] ?? "");

const behindProxy = startWith({ ALLOW_INSECURE_DEV: "1", PUBLIC_HOST: "localhost:8080", ADMIN_PUBLIC_HOST: "localhost:8081", TRUST_PROXY: "1" });
check("…and so does TRUST_PROXY, which means something is in front of it",
  behindProxy.status === 1 && /FATAL: ALLOW_INSECURE_DEV/.test(behindProxy.stderr),
  behindProxy.stderr.split("\n")[0] ?? "");

report("security block");
