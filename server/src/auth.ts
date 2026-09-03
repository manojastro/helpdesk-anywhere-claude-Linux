/**
 * Optional HTTP Basic authentication for the agent console (PLAN 7.3's Caddyfile
 * TODO: "protect the console route before this goes on a public hostname").
 *
 * `PLAN.md` puts console login out of scope for the POC, and this does not add
 * one: there is still no user store, no session management and no identity. It
 * is a single shared credential whose only job is to keep a publicly reachable
 * console from being usable by whoever finds the URL — which matters the moment
 * Phase 7 puts it on the internet, and matters more here than usual, because a
 * working remote-control console is exactly what a tech-support scammer wants
 * (CLAUDE.md 7.5).
 *
 * It lives in the app rather than in Caddy so it protects **both** deployment
 * modes: behind Caddy, and behind an ngrok tunnel where there is no Caddy at all
 * (`DECISIONS.md` D-007).
 *
 * Disabled — and loudly warned about at startup — when CONSOLE_PASSWORD is unset,
 * so local development needs no credentials.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { posix } from "node:path";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { config } from "./config.js";

/** Paths the end user must reach without credentials — they have none. */
const PUBLIC_PATHS = ["/j/", "/download/", "/healthz"];

export const consoleAuthEnabled = config.consolePassword !== "";

/**
 * Per-process secret for the console cookie. Regenerated on every restart, which
 * simply means browsers re-send their cached Basic credentials — there is no
 * server-side session to lose.
 */
const cookieSecret = randomBytes(32);

const COOKIE_NAME = "hda_console";

function sign(value: string): string {
  return createHmac("sha256", cookieSecret).update(value).digest("base64url");
}

/** Constant-time compare that does not leak length through an early return. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

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

function isPublicPath(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  return PUBLIC_PATHS.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

/**
 * True when this request carries a console cookie this process issued.
 *
 * Used on the WebSocket upgrade, where Basic auth cannot be challenged: browsers
 * send cookies with the upgrade, so the console's socket is recognisable while
 * the applet's — which has no cookie and must never need one — is not.
 */
export function hasConsoleCookie(req: IncomingMessage): boolean {
  const header = req.headers.cookie;
  if (!header) return false;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE_NAME) continue;
    return safeEqual(rest.join("="), sign(config.consoleUser));
  }
  return false;
}

export function consoleAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!consoleAuthEnabled || isPublicPath(req.path)) {
      next();
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");

    if (scheme?.toLowerCase() === "basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const user = separator === -1 ? decoded : decoded.slice(0, separator);
      const password = separator === -1 ? "" : decoded.slice(separator + 1);

      // Both compared, and both constant-time: a fast "no such user" would let
      // an attacker enumerate the username separately from the password.
      const userOk = safeEqual(user, config.consoleUser);
      const passwordOk = safeEqual(password, config.consolePassword);

      if (userOk && passwordOk) {
        res.cookie?.(COOKIE_NAME, sign(config.consoleUser), {
          httpOnly: true,
          sameSite: "lax",
          secure: isSecureRequest(req),
          path: "/",
        });
        next();
        return;
      }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Helpdesk Anywhere console", charset="UTF-8"');
    res.status(401).type("text/plain").send("Authentication required.\n");
  };
}

/**
 * Whether the *client's* leg was TLS. Behind a proxy the socket is plaintext, so
 * the header is the only evidence — and is only trusted when TRUST_PROXY says
 * something really is in front (same rule as `signaling.ts`).
 */
function isSecureRequest(req: Request): boolean {
  if (req.socket && "encrypted" in req.socket && req.socket.encrypted === true) return true;
  if (!config.trustProxy) return false;

  const header = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(",")[0]?.trim().toLowerCase() === "https";
}
