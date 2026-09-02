/**
 * Agent console and end-user join page (PLAN 1.4, 1.5).
 *
 * `/`          → the agent console (portal.html)
 * `/j/:code`   → the join page, path-style so the URL is easy to read aloud on a
 *                support call. The client reads the code from `location.pathname`.
 *
 * NOTE (PLAN "out of scope"): the agent console has no authentication. Phase 7
 * must put `basic_auth` on `/` in the Caddyfile before this goes on a public
 * hostname. `/j/:code` and `/download/*` must stay unauthenticated — end users
 * need them.
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

  router.use(express.static(publicDir, { index: "portal.html" }));

  return router;
}
