/**
 * Agent-application pages (PLAN 1.4, 1.5).
 *
 * `/`          → the technician console (portal.html) — gated by gatePages("agent")
 * `/login`     → the console's own sign-in page (public)
 * `/j/:code`   → the customer join page, path-style so the URL is easy to read
 *                aloud on a support call. Public: the customer has no account.
 *
 * The admin portal is a different application with its own static root
 * (`/admin-portal/public`) on its own listener; nothing here serves it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Router } from "express";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public",
);

export function portalRouter(): Router {
  const router = express.Router();

  router.get("/j/:code", (_req, res) => {
    res.sendFile(path.join(publicDir, "join.html"));
  });

  router.get("/login", (_req, res) => {
    res.sendFile(path.join(publicDir, "login.html"));
  });

  router.use(express.static(publicDir, { index: "portal.html" }));

  return router;
}
