/**
 * Turning a verified identity into an application user.
 *
 * Input is always the claims of an ID token that the OIDC library has already
 * validated (issuer, audience, signature, expiry, nonce) — or, in AUTH_MODE=dev
 * only, the equivalent fields from the local sign-in form. This module then
 * applies the application's own rules:
 *
 *   * the tenant must be the one configured tenant;
 *   * the stable key is (tid, oid) — the e-mail address is display data only;
 *   * an identity with no eligible app role is recorded (so an admin can see the
 *     request and knows Entra assignment is needed) but gets no session;
 *   * a pending or suspended identity gets no session either;
 *   * the first administrator is bootstrapped only for a configured object ID
 *     that also carries the Admin app role, while no active admin exists.
 */

import { randomUUID } from "node:crypto";

import { config, type Portal } from "../config.js";
import { writeAudit } from "../db/auditLog.js";
import { query, tx } from "../db/pool.js";
import { eligibleRoles, mayUsePortal, type AppRole, type UserStatus } from "./permissions.js";

/** The organisation row for the configured tenant, created at startup. */
export const org = { id: "", tenantId: "" };

export function configuredTenantId(): string {
  return config.authMode === "dev" ? config.devTenantId : config.entraTenantId;
}

export async function ensureOrganization(): Promise<void> {
  const tenantId = configuredTenantId();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO organizations (id, entra_tenant_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (entra_tenant_id) DO UPDATE SET name = organizations.name
     RETURNING id`,
    [randomUUID(), tenantId, config.orgName],
  );
  const row = rows[0];
  if (!row) throw new Error("could not create the organisation row");
  org.id = row.id;
  org.tenantId = tenantId;
}

/** The subset of ID-token claims this application reads. */
export interface VerifiedClaims {
  tid: string;
  oid: string;
  name: string;
  email: string | null;
  roles: unknown;
}

export type LoginOutcome =
  | { kind: "ok"; userId: string; roles: AppRole[]; bootstrapped: boolean }
  | {
      kind: "refused";
      reason: "wrong_tenant" | "missing_oid" | "entra_role_required" | "pending" | "suspended" | "portal_not_permitted";
      userId?: string;
    };

export async function resolveLogin(claims: VerifiedClaims, ip: string | null, portal: Portal): Promise<LoginOutcome> {
  if (claims.tid !== org.tenantId) {
    // Not the configured directory. Nothing is written for another tenant's user
    // beyond the refusal record — there is no org to attach them to.
    await writeAudit({
      orgId: org.id, actor: null, action: "auth.login_refused",
      detail: { reason: "wrong_tenant", tenant: claims.tid }, ip,
    });
    return { kind: "refused", reason: "wrong_tenant" };
  }
  if (!/^[0-9a-f-]{8,64}$/i.test(claims.oid)) {
    await writeAudit({ orgId: org.id, actor: null, action: "auth.login_refused", detail: { reason: "missing_oid" }, ip });
    return { kind: "refused", reason: "missing_oid" };
  }

  const roles = eligibleRoles(claims.roles);
  const name = claims.name.trim().slice(0, 120) || "Unnamed user";
  const email = claims.email?.trim().slice(0, 254) || null;

  return tx(async (client) => {
    const { rows } = await client.query<{ id: string; status: UserStatus; can_use_console: boolean }>(
      `INSERT INTO users (id, org_id, entra_tenant_id, entra_object_id, display_name, email, entra_roles, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (entra_tenant_id, entra_object_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             email = EXCLUDED.email,
             entra_roles = EXCLUDED.entra_roles,
             last_login_at = now(),
             updated_at = now()
       RETURNING id, status, can_use_console`,
      [randomUUID(), org.id, claims.tid, claims.oid, name, email, roles],
    );
    const user = rows[0];
    if (!user) throw new Error("user upsert returned nothing");
    const actor = { userId: user.id, displayName: name };

    if (roles.length === 0) {
      await writeAudit({ orgId: org.id, actor, action: "auth.login_refused", targetType: "user", targetId: user.id,
        detail: { reason: "entra_role_required" }, ip }, client);
      return { kind: "refused", reason: "entra_role_required", userId: user.id } as const;
    }

    let status = user.status;
    let bootstrapped = false;
    if (status === "pending" && (roles.includes("Admin") || roles.includes("SuperAdmin")) && config.bootstrapAdminOids.includes(claims.oid)) {
      // Serialise concurrent bootstraps; only the first may succeed.
      await client.query("SELECT pg_advisory_xact_lock($1)", [0x4844_4101]);
      const { rows: admins } = await client.query<{ n: number }>(
        `SELECT count(*) AS n FROM users WHERE org_id = $1 AND status = 'active' AND 'Admin' = ANY(entra_roles)`,
        [org.id],
      );
      if ((admins[0]?.n ?? 0) === 0) {
        await client.query(
          `UPDATE users SET status = 'active', status_reason = 'bootstrap administrator',
             status_changed_at = now(), updated_at = now() WHERE id = $1`,
          [user.id],
        );
        await writeAudit({ orgId: org.id, actor, action: "access.bootstrap_admin", targetType: "user", targetId: user.id,
          detail: { objectId: claims.oid }, ip }, client);
        status = "active";
        bootstrapped = true;
      }
    }

    if (status !== "active") {
      await writeAudit({ orgId: org.id, actor, action: "auth.login_refused", targetType: "user", targetId: user.id,
        detail: { reason: status }, ip }, client);
      return { kind: "refused", reason: status, userId: user.id } as const;
    }

    // Which application: the admin portal takes oversight roles only, and the
    // console only people allowed to run sessions.
    if (!mayUsePortal(roles, portal) || (portal === "agent" && !user.can_use_console)) {
      await writeAudit({ orgId: org.id, actor, action: "auth.login_refused", targetType: "user", targetId: user.id,
        detail: { reason: "portal_not_permitted", portal, roles }, ip }, client);
      return { kind: "refused", reason: "portal_not_permitted", userId: user.id } as const;
    }

    await writeAudit({ orgId: org.id, actor, action: "auth.login", targetType: "user", targetId: user.id,
      detail: { roles, portal }, ip }, client);
    return { kind: "ok", userId: user.id, roles, bootstrapped } as const;
  });
}
