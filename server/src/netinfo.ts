/**
 * Client address and transport security for an inbound request — shared by the
 * HTTP routes and the WebSocket relay so both apply the same proxy-trust rule.
 */

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { config } from "./config.js";

/**
 * The client IP rate limiters are keyed on.
 *
 * Behind a reverse proxy the socket address is the proxy, so the real client is
 * the *last* `X-Forwarded-For` entry — the one the trusted proxy appended.
 * Earlier entries are attacker-controlled. Without `TRUST_PROXY` the header is
 * ignored entirely.
 */
export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const nearest = parts[parts.length - 1];
    if (nearest !== undefined) return nearest;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Whether the *client's* connection is TLS-protected. Caddy terminates TLS and
 * speaks plain HTTP to this process, so behind a trusted proxy the header is the
 * only evidence.
 */
export function isSecure(req: IncomingMessage): boolean {
  const socket: Socket & { encrypted?: boolean } = req.socket;
  if (socket.encrypted === true) return true;

  if (config.trustProxy) {
    const header = req.headers["x-forwarded-proto"];
    const raw = Array.isArray(header) ? header[0] : header;
    const proto = raw?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https" || proto === "wss") return true;
  }
  return false;
}

/**
 * Whether a browser Origin belongs to this deployment: the request's own Host,
 * PUBLIC_HOST, or an ALLOWED_ORIGINS entry. A missing Origin returns null — the
 * caller decides what that means (for /ws it means "not a browser").
 */
export function originMatches(origin: string, host: string | undefined): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;  // a browser always sends a well-formed origin
  }

  if (host !== undefined && originHost === host) return true;
  if (originHost === config.publicHost) return true;

  return config.allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .some((allowed) => {
      try {
        return new URL(allowed).host === originHost;
      } catch {
        return allowed === originHost;  // a bare host:port is accepted too
      }
    });
}
