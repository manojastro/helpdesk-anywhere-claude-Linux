/**
 * Sign-in, sign-out and the development-only sign-in form — mounted once per
 * application (agent console and admin portal), each with its own redirect URI,
 * cookie and `auth_sessions.portal`.
 *
 *   GET  /auth/config      public: which sign-in mode the login page should offer
 *   GET  /auth/login       → Microsoft (Entra) authorization endpoint
 *   GET  /auth/callback    ← Microsoft; validates, resolves the user, sets the cookie
 *   POST /auth/logout      CSRF-protected
 *   POST /auth/dev/login   AUTH_MODE=dev ONLY — not even registered otherwise
 */

import express, { type Request, type Response, type Router } from "express";

import { config, type Portal } from "../config.js";
import { writeAudit } from "../db/auditLog.js";
import { org, resolveLogin, type VerifiedClaims } from "../auth/identity.js";
import { csrfProtect, normalizePath, requireApi } from "../auth/middleware.js";
import { beginLogin, completeLogin } from "../auth/oidc.js";
import { cookieName, cookieOptions, createAuthSession, destroyAuthSession, tokenFromCookieHeader } from "../auth/sessions.js";
import { clientIp, originMatches } from "../netinfo.js";
import { RateLimiter } from "../sessions.js";
import { revokeAuthSession } from "../signaling.js";

/** Sign-in attempts per IP per minute — covers /auth/login, /auth/callback and the dev form, both portals. */
export const signInLimiter = new RateLimiter(config.signInAttemptsPerMinute, 60_000);

function txCookie(portal: Portal): string {
  return portal === "admin" ? "hda_admin_oidc_tx" : "hda_agent_oidc_tx";
}

/**
 * Only same-origin, path-only destinations, from a strict alphabet. Anything
 * else becomes "/". A prefix check alone is not enough: browsers treat `/\host`
 * like `//host`, so a backslash (or any character outside the alphabet) is
 * refused outright rather than normalised.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const pathOnly = raw.split(/[?#]/)[0] ?? "/";
  if (!/^\/[A-Za-z0-9/_.-]{0,200}$/.test(pathOnly) || pathOnly.startsWith("//")) return "/";
  const path = normalizePath(pathOnly);
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/auth/") || path === "/login") return "/";
  return path;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function authRouter(portal: Portal): Router {
  const router = express.Router();

  async function startSession(req: Request, res: Response, userId: string, roles: string[], method: "entra" | "dev"): Promise<void> {
    const { token, expiresAt } = await createAuthSession({
      userId, orgId: org.id, roles, method, portal, ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null,
    });
    res.cookie(cookieName(portal), token, { ...cookieOptions(), expires: expiresAt });
  }

  router.get("/config", (_req, res) => {
    res.json({ mode: config.authMode, org: config.orgName, portal });
  });

  router.get("/login", (req, res) => {
    if (!signInLimiter.allow(clientIp(req))) {
      res.status(429).type("text/plain").send("Too many sign-in attempts. Wait a minute.\n");
      return;
    }
    const returnTo = safeReturnTo(req.query["returnTo"]);
    if (config.authMode === "dev") {
      res.redirect(302, `/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    beginLogin(portal, returnTo)
      .then(({ url, txId }) => {
        res.cookie(txCookie(portal), txId, { ...cookieOptions(), maxAge: 10 * 60_000 });
        res.redirect(302, url.href);
      })
      .catch((err: unknown) => {
        console.error(`[auth:${portal}] could not start Entra sign-in:`, err instanceof Error ? err.message : err);
        res.redirect(302, "/login?error=idp_unavailable");
      });
  });

  router.get("/callback", (req, res) => {
    const ip = clientIp(req);
    if (!signInLimiter.allow(ip)) {
      res.status(429).type("text/plain").send("Too many sign-in attempts. Wait a minute.\n");
      return;
    }
    const txId = readCookie(req.headers.cookie, txCookie(portal));
    res.clearCookie(txCookie(portal), cookieOptions());
    const q = req.originalUrl.indexOf("?");
    const search = q === -1 ? "" : req.originalUrl.slice(q);

    (async () => {
      if (txId === null) throw new Error("no sign-in transaction cookie");
      const { claims, returnTo } = await completeLogin(portal, txId, search);
      const outcome = await resolveLogin(claims, ip, portal);
      if (outcome.kind === "refused") {
        res.redirect(302, `/login?status=${outcome.reason}`);
        return;
      }
      await startSession(req, res, outcome.userId, outcome.roles, "entra");
      res.redirect(302, returnTo);
    })().catch((err: unknown) => {
      // The message is safe to log (library validation text); the query string,
      // which carries the authorization code, is not logged.
      console.error(`[auth:${portal}] Entra sign-in failed:`, err instanceof Error ? err.message : err);
      res.redirect(302, "/login?error=signin_failed");
    });
  });

  router.post("/logout", requireApi(), csrfProtect(), (req, res) => {
    const token = tokenFromCookieHeader(req.headers.cookie, portal);
    const p = req.principal ?? null;
    (async () => {
      if (token !== null) await destroyAuthSession(token);
      // A relay socket opened with this sign-in must not outlive it (audit F-04).
      if (p && portal === "agent") revokeAuthSession(p.sessionHash);
      if (p) await writeAudit({ orgId: p.orgId, actor: p, action: "auth.logout", detail: { portal }, ip: clientIp(req) });
    })()
      .catch((err: unknown) => console.error("[auth] logout:", err instanceof Error ? err.message : err))
      .finally(() => {
        res.clearCookie(cookieName(portal), cookieOptions());
        res.status(204).end();
      });
  });

  if (config.authMode === "dev") registerDevLogin(router, portal, startSession);

  return router;
}

/**
 * AUTH_MODE=dev: sign in as any identity, with any app roles, without Microsoft.
 *
 * This is the whole reason dev mode is fatal under NODE_ENV=production and on a
 * non-loopback host (`assertAuthModeAllowed` in index.ts): it IS an
 * authentication bypass, by design, for a developer's machine and the test
 * suite. The claims it produces go through the same resolveLogin() as a real
 * token, so the tenant check, pending/suspended handling, bootstrap and portal
 * rules are exercised exactly as in production.
 */
function registerDevLogin(
  router: Router,
  portal: Portal,
  startSession: (req: Request, res: Response, userId: string, roles: string[], method: "entra" | "dev") => Promise<void>,
): void {
  router.post("/dev/login", express.json({ limit: "4kb" }), (req, res) => {
    const ip = clientIp(req);
    if (!signInLimiter.allow(ip)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !originMatches(origin, req.headers.host)) {
      res.status(403).json({ error: "bad_origin" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
    const claims: VerifiedClaims = {
      tid: s(body["tenantId"], 64) || config.devTenantId,
      oid: s(body["objectId"], 64),
      name: s(body["name"], 120),
      email: s(body["email"], 254) || null,
      roles: Array.isArray(body["roles"]) ? body["roles"] : [],
    };

    (async () => {
      const outcome = await resolveLogin(claims, ip, portal);
      if (outcome.kind === "refused") {
        res.status(403).json({ error: outcome.reason, ...(outcome.userId ? { userId: outcome.userId } : {}) });
        return;
      }
      await startSession(req, res, outcome.userId, outcome.roles, "dev");
      res.json({ ok: true, userId: outcome.userId, bootstrapped: outcome.bootstrapped });
    })().catch((err: unknown) => {
      console.error("[auth] dev sign-in failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "server_error" });
    });
  });
}
