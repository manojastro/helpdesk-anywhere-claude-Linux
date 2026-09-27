/**
 * Server-side browser sessions.
 *
 * The cookie carries 32 random bytes; the database stores only their SHA-256, so
 * a database read (or backup) cannot be replayed as a login. HttpOnly, SameSite
 * Lax, Secure and `__Host-` prefixed in every deployment; only AUTH_MODE=dev on
 * a loopback host drops Secure, and that mode is fatal anywhere else.
 *
 * Each request re-reads the user row, so a suspension takes effect on the very
 * next request, not at cookie expiry.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { config, hostIsLocal, type Portal } from "../config.js";
import { query } from "../db/pool.js";
import { eligibleRoles, type Principal, type UserStatus } from "./permissions.js";

/**
 * Plain-HTTP cookies exist only for AUTH_MODE=dev on a loopback host — the one
 * combination that is also refused anywhere else at startup (index.ts).
 */
const plainHttpDev = config.authMode === "dev" && hostIsLocal();

/**
 * One cookie per application. In production the two portals are different
 * hosts and host-only `__Host-` cookies are isolated anyway; locally they share
 * `localhost` (cookies ignore ports), so the names must differ — and the
 * `portal` column means a stolen or confused cookie still resolves only on the
 * portal that issued it.
 */
export function cookieName(portal: Portal): string {
  const base = portal === "admin" ? "hda_admin" : "hda_agent";
  return plainHttpDev ? base : `__Host-${base}`;
}

export function cookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/" } {
  return { httpOnly: true, secure: !plainHttpDev, sameSite: "lax", path: "/" };
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function createAuthSession(input: {
  userId: string;
  orgId: string;
  roles: string[];
  method: "entra" | "dev";
  portal: Portal;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + config.authMaxHours * 3_600_000);
  await query(
    `INSERT INTO auth_sessions (id_hash, user_id, org_id, csrf_token, entra_roles, auth_method, portal, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [hash(token), input.userId, input.orgId, csrf, input.roles, input.method, input.portal, expiresAt, input.ip,
      input.userAgent?.slice(0, 300) ?? null],
  );
  return { token, expiresAt };
}

export async function destroyAuthSession(token: string): Promise<void> {
  await query("DELETE FROM auth_sessions WHERE id_hash = $1", [hash(token)]);
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
}

interface Row {
  hash_hex: string;
  csrf_token: string;
  entra_roles: string[];
  auth_method: "entra" | "dev";
  expires_at: Date;
  last_seen_at: Date;
  user_id: string;
  org_id: string;
  entra_tenant_id: string;
  entra_object_id: string;
  display_name: string;
  email: string | null;
  agent_code: string | null;
  team_id: string | null;
  status: UserStatus;
  can_use_console: boolean;
  allow_scripts: boolean;
  allow_elevation: boolean;
  can_export: boolean;
  max_concurrent_sessions: number;
}

/**
 * Resolve a cookie value to a principal, or null when it is unknown, expired,
 * idle too long, or belongs to a user who is no longer active.
 */
export async function principalFromToken(token: string, portal: Portal): Promise<Principal | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await query<Row>(
    `SELECT encode(a.id_hash, 'hex') AS hash_hex, a.csrf_token, a.entra_roles, a.auth_method, a.expires_at, a.last_seen_at,
            u.id AS user_id, u.org_id, u.entra_tenant_id, u.entra_object_id, u.display_name, u.email, u.agent_code,
            u.team_id, u.status, u.can_use_console, u.allow_scripts, u.allow_elevation, u.can_export,
            u.max_concurrent_sessions
       FROM auth_sessions a JOIN users u ON u.id = a.user_id AND u.org_id = a.org_id
      WHERE a.id_hash = $1 AND a.portal = $2`,
    [hash(token), portal],
  );
  const r = rows[0];
  if (!r) return null;

  const now = Date.now();
  const idleLimit = config.authIdleMinutes * 60_000;
  if (r.expires_at.getTime() <= now || now - r.last_seen_at.getTime() > idleLimit || r.status !== "active") {
    await query("DELETE FROM auth_sessions WHERE id_hash = $1", [hash(token)]);
    return null;
  }
  // Sliding idle window, written at most once a minute per session.
  if (now - r.last_seen_at.getTime() > 60_000) {
    await query("UPDATE auth_sessions SET last_seen_at = now() WHERE id_hash = $1", [hash(token)]);
  }

  return {
    userId: r.user_id,
    orgId: r.org_id,
    tenantId: r.entra_tenant_id,
    objectId: r.entra_object_id,
    displayName: r.display_name,
    email: r.email,
    agentCode: r.agent_code,
    teamId: r.team_id,
    status: r.status,
    roles: eligibleRoles(r.entra_roles),
    limits: {
      canUseConsole: r.can_use_console,
      allowScripts: r.allow_scripts,
      allowElevation: r.allow_elevation,
      canExport: r.can_export,
      maxConcurrentSessions: r.max_concurrent_sessions,
    },
    authMethod: r.auth_method,
    csrfToken: r.csrf_token,
    sessionHash: r.hash_hex,
    sessionExpiresAt: r.expires_at,
    portal,
  };
}

/** The session cookie's value from a raw Cookie header, if present. */
export function tokenFromCookieHeader(header: string | undefined, portal: Portal): string | null {
  if (!header) return null;
  const name = cookieName(portal);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function principalFromRequest(req: IncomingMessage, portal: Portal): Promise<Principal | null> {
  const token = tokenFromCookieHeader(req.headers.cookie, portal);
  return token === null ? null : principalFromToken(token, portal);
}
