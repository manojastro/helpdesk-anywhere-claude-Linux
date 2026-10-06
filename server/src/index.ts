/**
 * Helpdesk Anywhere server — one process, two applications:
 *
 *   AGENT app  (PORT, app.<domain>):   technician console, customer join page,
 *              applet download, /ws relay, /api/agent/*, its own sign-in.
 *   ADMIN app  (ADMIN_PORT, admin.<domain>): the admin portal (separate
 *              frontend in /admin-portal), /api/admin/*, its own sign-in.
 *
 * They share the database, the live-session state and this code — there is one
 * relay and one database — but not a listener, an origin, a cookie or a
 * browser session. The admin app has no WebSocket and no customer surface.
 *
 * The Linux side still does no capture, input or elevation: all of that is in
 * the Windows applet (CLAUDE.md).
 */

import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Express } from "express";

import { verifyAuditWritable } from "./audit.js";
import { ensureOrganization } from "./auth/identity.js";
import { attachPrincipal, gatePages } from "./auth/middleware.js";
import { entraConfigured } from "./auth/oidc.js";
import { config, type Portal } from "./config.js";
import { migrate } from "./db/migrate.js";
import { dbHealth, pool } from "./db/pool.js";
import { accessLog, metricsAuthorised, renderMetrics, requestId } from "./observability.js";
import { reconcileInterrupted } from "./records.js";
import { verifyReportFonts } from "./reports.js";
import { scheduleRetention } from "./retention.js";
import { adminApiRouter } from "./routes/adminApi.js";
import { agentApiRouter } from "./routes/agentApi.js";
import { authRouter } from "./routes/auth.js";
import { downloadRouter } from "./routes/download.js";
import { portalRouter } from "./routes/portal.js";
import { attachSignaling, connectionCounts, endAllSessions, liveSessions } from "./signaling.js";
import { startupProblems } from "./startupChecks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_STATIC = process.env["ADMIN_STATIC_DIR"] ?? path.resolve(here, "../../admin-portal/public");

/* -------------------------------------------------------------- refuse early */

const problems = startupProblems();
if (problems.length > 0) {
  for (const p of problems) console.error(`[server] FATAL: ${p}`);
  console.error("[server] Refusing to start.");
  process.exit(1);
}
if ((process.env["CONSOLE_PASSWORD"] ?? "") !== "") {
  console.warn("[server] CONSOLE_PASSWORD is set but no longer used: console access is by Entra ID sign-in (DECISIONS.md D-014).");
}

/**
 * Conservative response headers, set in the app so they apply behind Caddy and
 * behind a tunnel alike. `script-src 'self'`: nothing this server sends can
 * execute an injected string. `style-src 'unsafe-inline'` only because the join
 * page keeps its self-contained inline `<style>` (see git history for the full
 * rationale). No framing, ever — clickjacking a live remote-control panel or an
 * access-management page is a real attack.
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

const startedAt = Date.now();

function baseApp(portal: Portal): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(requestId());
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });

  /**
   * Liveness probe for Docker, Caddy and uptime checks. Nothing an
   * unauthenticated caller should not see: no counts, no codes, no identities.
   */
  app.get("/healthz", (_req, res) => {
    res.status(dbHealth.ok ? 200 : 503).json({
      ok: dbHealth.ok,
      app: portal,
      publicHost: portal === "admin" ? config.adminPublicHost : config.publicHost,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      authMode: config.authMode,
    });
  });
  return app;
}

/* ----------------------------------------------------------------- agent app */

const agentApp = baseApp("agent");

/**
 * A request to `/ws` that is **not** a WebSocket upgrade. A real upgrade never
 * reaches Express (`ws` handles the HTTP server's `upgrade` event). What lands
 * here is usually a proxy hop that dropped the upgrade — HTTP/2 cannot carry
 * `Connection: Upgrade` (RFC 9113 s8.2.2) — and 426 says so, instead of a 401
 * that sends the operator hunting in the wrong place (DEV_NOTES.md 2026-09-04).
 */
agentApp.get("/ws", (_req, res) => {
  res
    .status(426)
    .set("Upgrade", "websocket")
    .type("text/plain")
    .send(
      "This endpoint speaks WebSocket only.\n" +
        "Connect over HTTP/1.1 with Connection: Upgrade and Upgrade: websocket.\n" +
        "HTTP/2 cannot carry those headers, so an h2 client always arrives here.\n",
    );
});

agentApp.use(attachPrincipal("agent"));
agentApp.use(accessLog("agent"));
agentApp.use("/auth", authRouter("agent"));
agentApp.use("/api/agent", agentApiRouter());
agentApp.use("/api", (_req, res) => {
  res.status(404).json({ error: "not_found" });
});
// Everything below is gated; /j/*, /download/* and the sign-in page stay open
// because the customer has no account and must not need one.
agentApp.use(gatePages("agent"));
agentApp.use("/download", downloadRouter());
agentApp.use("/", portalRouter());

/* ----------------------------------------------------------------- admin app */

const adminApp = baseApp("admin");

/**
 * Platform 2.0: Prometheus scrape endpoint, admin listener only, off unless
 * METRICS_TOKEN is set (bearer). Counts only — no names, ids or content.
 */
adminApp.get("/metrics", (req, res) => {
  if (!metricsAuthorised(req)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const live = liveSessions();
  const byPhase = new Map<string, number>();
  for (const l of live) byPhase.set(l.phase, (byPhase.get(l.phase) ?? 0) + 1);
  const gauges: Array<{ name: string; labels: Record<string, string>; value: number }> =
    [...byPhase.entries()].map(([phase, value]) => ({ name: "hda_sessions", labels: { phase }, value }));
  if (gauges.length === 0) gauges.push({ name: "hda_sessions", labels: { phase: "none" }, value: 0 });
  for (const [kind, value] of Object.entries(connectionCounts())) gauges.push({ name: "hda_ws_connections", labels: { kind }, value });
  res.type("text/plain; version=0.0.4").send(renderMetrics(gauges));
});

adminApp.use(attachPrincipal("admin"));
adminApp.use(accessLog("admin"));
adminApp.use("/auth", authRouter("admin"));
adminApp.use("/api/admin", adminApiRouter());
adminApp.use("/api", (_req, res) => {
  res.status(404).json({ error: "not_found" });
});
adminApp.use(gatePages("admin"));
adminApp.get("/login", (_req, res) => {
  res.sendFile(path.join(ADMIN_STATIC, "login.html"));
});
adminApp.use(express.static(ADMIN_STATIC, { index: "index.html" }));

/* ------------------------------------------------------------------ startup */

try {
  // Refuse to start rather than run un-auditable (CLAUDE.md constraint #5).
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

try {
  if (config.dbMigrateOnStart) await migrate();
  await ensureOrganization();
  // Sessions the database still shows as open belonged to a previous process.
  const interrupted = await reconcileInterrupted();
  if (interrupted > 0) console.warn(`[server] reconciled ${interrupted} session(s) left open by a previous run as server_restart`);
} catch (err) {
  console.error(`[server] FATAL: database initialisation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Report fonts (English + Tamil) must be present before anyone can request a PDF.
try {
  verifyReportFonts();
} catch (err) {
  console.error(`[server] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

scheduleRetention();

const agentServer = createServer(agentApp);
const wss = attachSignaling(agentServer);
const adminServer = createServer(adminApp);

function listen(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      console.log(`[server] ${label} listening on :${port}`);
      resolve();
    });
  });
}

await listen(agentServer, config.port, `agent console (${config.publicHost})`);
await listen(adminServer, config.adminPort, `admin portal (${config.adminPublicHost})`);
console.log(`[server] join links: https://${config.publicHost}/j/<code>`);
if (config.authMode === "dev") {
  console.warn("[server] AUTH_MODE=dev — development sign-in form enabled. Loopback only; refused in production.");
} else if (!entraConfigured()) {
  console.warn("[server] Entra ID is not fully configured; sign-in will fail.");
}
if (config.allowInsecureDev) {
  console.warn("[server] ALLOW_INSECURE_DEV is set — credential-mode elevation over plain HTTP is permitted. Never set this in a deployment.");
}

/* ----------------------------------------------------------------- shutdown */

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — shutting down`);

  // Don't let a wedged socket or database hold the process open forever.
  setTimeout(() => process.exit(0), 5000).unref();

  // End live sessions with a recorded reason, THEN close; whatever does not
  // make it is reconciled as server_restart on the next start.
  endAllSessions()
    .catch(() => undefined)
    .finally(() => {
      for (const client of wss.clients) client.close(1001, "server shutting down");
      wss.close();
      adminServer.close();
      agentServer.close(() => {
        void pool.end().finally(() => process.exit(0));
      });
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
