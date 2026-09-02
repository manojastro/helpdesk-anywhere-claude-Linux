/**
 * Helpdesk Anywhere server — matchmaker, WSS relay and applet file host.
 *
 * The Linux side is deliberately dumb: it pairs an agent console with a Windows
 * applet, relays frames between them, and serves the .exe. All capture, input
 * injection, UAC handling and script execution happen in the applet (CLAUDE.md).
 */

import { createServer } from "node:http";

import express from "express";

import { audit } from "./audit.js";
import { config } from "./config.js";
import { downloadRouter } from "./routes/download.js";
import { portalRouter } from "./routes/portal.js";
import { attachSignaling } from "./signaling.js";

const app = express();

app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, publicHost: config.publicHost });
});

app.use("/download", downloadRouter());
app.use("/", portalRouter());

const server = createServer(app);
const wss = attachSignaling(server);

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  console.log(`[server] join links: https://${config.publicHost}/j/<code>`);
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
