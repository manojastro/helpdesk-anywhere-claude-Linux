/**
 * HTTP authentication and authorisation middleware.
 *
 *   attachPrincipal  — resolves the session cookie to a Principal (or null) once
 *                      per request, re-reading the user row every time;
 *   gatePages        — the static surface: customer paths stay public, the
 *                      console and admin pages require an active identity;
 *   requireApi       — 401/403 JSON for /api routes, by permission;
 *   csrfProtect      — state-changing requests need the per-session token in
 *                      `X-CSRF-Token` AND, when the browser sends one, a
 *                      same-deployment Origin. SameSite=Lax is a third layer,
 *                      not the only one.
 *
 * Replaces the shared console password (DECISIONS.md D-008 → D-014).
 */

import { timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Portal } from "../config.js";
import { originMatches } from "../netinfo.js";
import { can, type Permission, type Principal } from "./permissions.js";
import { principalFromRequest } from "./sessions.js";

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal | null;
  }
}

/**
 * What each application serves without a sign-in. The agent app must keep the
 * customer's paths open (the customer has no account); the admin app has no
 * customer-facing surface at all.
 */
const PUBLIC: Record<Portal, { prefixes: string[]; files: Set<string> }> = {
  agent: {
    prefixes: ["/j/", "/download/", "/auth/"],
    files: new Set(["/healthz", "/login", "/login.html", "/login.js", "/login.css", "/join.js", "/favicon.ico"]),
  },
  admin: {
    prefixes: ["/auth/"],
    files: new Set(["/healthz", "/login", "/login.html", "/login.js", "/login.css", "/favicon.ico"]),
  },
};

/**
 * Resolve `.`, `..` and percent-encoding before the path is matched.
 *
 * Without this the check is on the *raw* path, and `/download/../portal.html`
 * starts with an open prefix while `express.static` — which resolves the dots —
 * serves the console. Found by the 2026-09-03 security review; regression tests
 * in `tests/ws/07-security.mjs`.
 */
export function normalizePath(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escapes: match on the raw path rather than guessing at intent.
  }
  // A NUL or a backslash has no legitimate place in a path here, and both are
  // classic ways to smuggle one matcher past another.
  if (decoded.includes("\0") || decoded.includes("\\")) return raw;

  const normalized = posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function isPublicPath(rawPath: string, portal: Portal): boolean {
  const path = normalizePath(rawPath);
  const pub = PUBLIC[portal];
  if (pub.files.has(path)) return true;
  return pub.prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

/** Resolve this portal's cookie (and only this portal's) to a Principal. */
export function attachPrincipal(portal: Portal): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    principalFromRequest(req, portal)
      .then((p) => {
        req.principal = p;
        next();
      })
      .catch((err: unknown) => {
        // Database unavailable: treat as signed out, never as signed in.
        console.error("[auth] session lookup failed:", err instanceof Error ? err.message : err);
        req.principal = null;
        next();
      });
  };
}

/**
 * Protect everything that is not explicitly public. API routes answer for
 * themselves (401/403 JSON). A page request without a session goes to that
 * portal's own sign-in page.
 */
export function gatePages(portal: Portal): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = normalizePath(req.path);
    if (isPublicPath(path, portal) || path.startsWith("/api/")) {
      next();
      return;
    }
    if ((req.principal ?? null) === null) {
      const isPage = req.method === "GET" && (path === "/" || path.endsWith(".html") || !path.includes("."));
      if (isPage) res.redirect(302, `/login?returnTo=${encodeURIComponent(path)}`);
      else res.status(401).type("text/plain").send("Sign-in required.\n");
      return;
    }
    next();
  };
}

export function requireApi(perm?: Permission): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal ?? null;
    if (p === null) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (perm !== undefined && !can(p, perm)) {
      res.status(403).json({ error: "forbidden", permission: perm });
      return;
    }
    next();
  };
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfProtect(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !originMatches(origin, req.headers.host)) {
      res.status(403).json({ error: "bad_origin" });
      return;
    }
    const p = req.principal ?? null;
    const header = req.headers["x-csrf-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (p === null || typeof token !== "string" || !tokensEqual(token, p.csrfToken)) {
      res.status(403).json({ error: "csrf" });
      return;
    }
    next();
  };
}
