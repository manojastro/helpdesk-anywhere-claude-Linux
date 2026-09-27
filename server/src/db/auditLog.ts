/**
 * Administrative audit trail (the `audit_log` table): access changes, sign-ins,
 * transcript and notes views, report exports and downloads, terminations.
 *
 * Distinct from the relay's JSONL security log (`../audit.ts`), which keeps the
 * session lifecycle, elevation attempts and scripts. Chat content never goes to
 * either.
 *
 * Callers AWAIT these writes and fail the request if they throw: a transcript
 * shown or a report handed out without its audit row is exactly the silent gap
 * this trail exists to prevent. Access changes pass their transaction client so
 * the change and its record commit or roll back together.
 */

import { redact } from "../audit.js";
import type { Principal } from "../auth/permissions.js";
import { query, type Queryable } from "./pool.js";

export type AdminAction =
  | "auth.login"
  | "auth.login_refused"
  | "auth.logout"
  | "access.bootstrap_admin"
  | "access.activated"
  | "access.suspended"
  | "access.reactivated"
  | "access.updated"
  | "team.created"
  | "team.renamed"
  | "session.terminated"
  | "transcript.viewed"
  | "notes.viewed"
  | "notes.saved"
  | "report.requested"
  | "report.downloaded"
  | "report.denied"
  | "retention.purged";

export interface AuditEntry {
  orgId: string | null;
  actor: Pick<Principal, "userId" | "displayName"> | null;
  action: AdminAction;
  targetType?: string | undefined;
  targetId?: string | undefined;
  detail?: Record<string, unknown> | undefined;
  ip?: string | null | undefined;
}

export async function writeAudit(entry: AuditEntry, client?: Queryable): Promise<void> {
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_label, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.orgId,
      entry.actor?.userId ?? null,
      entry.actor?.displayName ?? "system",
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(redact(entry.detail ?? {})),
      entry.ip ?? null,
    ],
    client,
  );
}
