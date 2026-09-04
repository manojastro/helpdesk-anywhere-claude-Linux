/**
 * Helpdesk Anywhere server — matchmaker, WSS relay and applet file host.
 *
 * The Linux side is deliberately dumb: it pairs an agent console with a Windows
 * applet, relays frames between them, and serves the .exe. All capture, input
 * injection, UAC handling and script execution happen in the applet (CLAUDE.md).
 */

import { createServer } from "node:http";

import express from "express";

import { audit, verifyAuditWritable } from "./audit.js";
import { consoleAuth, consoleAuthEnabled } from "./auth.js";
import { config } from "./config.js";
import { downloadRouter } from "./routes/download.js";
import { portalRouter } from "./routes/portal.js";
import { attachSignaling } from "./signaling.js";

const app = express();

app.disable("x-powered-by");

/**
 * Conservative response headers, set in the app so they apply in BOTH deployment
 * modes — behind Caddy and behind an ngrok tunnel where there is no Caddy.
 *
 * The Content-Security-Policy needs no nonce. The join page's one inline script
 * moved to `/join.js`, so `script-src` is a plain `'self'`: nothing this server
 * sends can execute an injected string, which is the protection worth having on
 * a page that hands an unauthenticated visitor a remote-control binary.
 *
 * A nonce was the earlier plan and is the wrong tool here. It would mean
 * templating an otherwise static file on every request, and neither page has any
 * server-injected content for a nonce to protect — the join page reads its code
 * from `location.pathname` and writes it with `textContent`.
 *
 * Two deliberate looseness points, both weaker than they look:
 *
 * - `style-src` keeps `'unsafe-inline'`, because the join page keeps its inline
 *   `<style>`. That page is loaded by a stressed non-technical person mid-call
 *   (PLAN 1.5) and is deliberately self-contained. A style hash would be exact,
 *   but it breaks silently on any CSS edit — the precise failure the original
 *   note warned against — and CSS injection is not the risk here anyway, since
 *   no attacker-controlled string reaches the markup.
 * - `connect-src 'self'` covers the same-origin `/ws` upgrade. The relay is the
 *   only connection either page makes.
 *
 * Everything else is denied outright: no plugins, no `<base>` rewriting, no
 * framing, no form posts anywhere. The console must never be framed —
 * clickjacking a live remote-control panel is a real attack, not a theoretical
 * one — so it is refused twice, by `frame-ancestors` and by X-Frame-Options for
 * anything that predates it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const startedAt = Date.now();

/**
 * Liveness probe for Docker, Caddy and any uptime check (PLAN 7.1). Deliberately
 * free of anything an unauthenticated caller should not see: no session counts,
 * no codes, no client details.
 */
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    publicHost: config.publicHost,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    consoleAuth: consoleAuthEnabled,
  });
});

// Guards the console only; /j/*, /download/* and /healthz stay open because the
// end user has no credentials and must not need any.
app.use(consoleAuth());

app.use("/download", downloadRouter());
app.use("/", portalRouter());

const server = createServer(app);
const wss = attachSignaling(server);

// Refuse to start rather than run un-auditable (CLAUDE.md constraint #5). In a
// container this usually means the bind-mounted audit directory belongs to a
// different uid than the container user — see HOST_UID in .env.example.
try {
  await verifyAuditWritable();
} catch (err) {
  console.error(
    `[server] FATAL: the audit directory ${config.auditDir} is not writable ` +
      `(${err instanceof Error ? err.message : String(err)}).\n` +
      "[server] Refusing to start: an unauditable support tool is worse than none.\n" +
      "[server] In Docker, set HOST_UID/HOST_GID in .env to the owner of ./audit.",
  );
  process.exit(1);
}

// ALLOW_INSECURE_DEV switches off the one check that keeps an administrator
// password off a plaintext wire (PLAN 5.2c rule 1). A warning is not enough for
// that: a stale line in a .env travels to a public host unnoticed, and the
// symptom — a credential-mode elevation quietly succeeding over ws:// — looks
// exactly like everything working. So the combination is fatal rather than loud.
const looksPublic =
  config.trustProxy ||
  !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(config.publicHost);

if (config.allowInsecureDev && looksPublic) {
  console.error(
    "[server] FATAL: ALLOW_INSECURE_DEV is set on what looks like a real " +
      `deployment (PUBLIC_HOST=${config.publicHost}, TRUST_PROXY=${config.trustProxy ? "1" : "0"}).\n` +
      "[server] That flag permits administrator credentials over an unencrypted\n" +
      "[server] connection (CLAUDE.md constraint #6.1). Refusing to start.",
  );
  process.exit(1);
}

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  console.log(`[server] join links: https://${config.publicHost}/j/<code>`);
  if (consoleAuthEnabled) {
    console.log(`[server] agent console requires HTTP Basic auth as "${config.consoleUser}"`);
  } else {
    console.warn(
      "[server] CONSOLE_PASSWORD is not set — the agent console is OPEN. That is " +
        "fine locally and unsafe on any address reachable from the internet.",
    );
  }
  if (config.allowInsecureDev) {
    console.warn(
      "[server] ALLOW_INSECURE_DEV is set — credential-mode elevation over " +
        "plain HTTP is permitted. Never set this in a deployment.",
    );
  }
});

/** Idempotent shutdown — mirrors the applet's Teardown() guarantee (PLAN 2.4). */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — shutting down`);

  void audit("session.ended", null, { reason: `server ${signal}` });

  for (const client of wss.clients) client.close(1001, "server shutting down");
  wss.close();
  server.close(() => process.exit(0));

  // Don't let a wedged socket hold the process open forever.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
