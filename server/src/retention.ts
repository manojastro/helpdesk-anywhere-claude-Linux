/**
 * Retention sweep — runs at startup and hourly.
 *
 *   TRANSCRIPT_RETENTION_DAYS (default 365): chat messages and notes of sessions
 *     that ENDED longer ago are deleted; the session row keeps
 *     `transcript_purged_at`, so history shows "deleted by retention policy"
 *     instead of an empty transcript that looks like no one spoke.
 *   SESSION_RETENTION_DAYS (default 730): whole session records (timeline
 *     included) are deleted.
 *   REPORT_TTL_MINUTES (default 15): generated report files are erased once
 *     their download window closes; the export row stays for the audit trail.
 *   AUDIT_RETENTION_DAYS (default 0 = forever): administrative audit rows.
 *
 * 0 disables a rule. Each purge that deletes something writes a
 * `retention.purged` audit row with counts only.
 */

import { config } from "./config.js";
import { writeAudit } from "./db/auditLog.js";
import { query } from "./db/pool.js";
import { org } from "./auth/identity.js";

export interface RetentionResult {
  transcriptsPurged: number;
  sessionsDeleted: number;
  reportsErased: number;
  auditRowsDeleted: number;
  authSessionsDeleted: number;
}

export async function runRetention(): Promise<RetentionResult> {
  const result: RetentionResult = { transcriptsPurged: 0, sessionsDeleted: 0, reportsErased: 0, auditRowsDeleted: 0, authSessionsDeleted: 0 };

  if (config.transcriptRetentionDays > 0) {
    const { rows } = await query<{ n: number }>(
      `WITH due AS (
         SELECT id FROM sessions
          WHERE status = 'ended' AND transcript_purged_at IS NULL
            AND ended_at < now() - make_interval(days => $1)
       ), c AS (DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM due) RETURNING 1),
          n AS (DELETE FROM session_notes WHERE session_id IN (SELECT id FROM due) RETURNING 1),
          u AS (UPDATE sessions SET transcript_purged_at = now() WHERE id IN (SELECT id FROM due) RETURNING 1)
       SELECT (SELECT count(*) FROM u) AS n`,
      [config.transcriptRetentionDays],
    );
    result.transcriptsPurged = rows[0]?.n ?? 0;
  }

  if (config.sessionRetentionDays > 0) {
    const { rowCount } = await query(
      `DELETE FROM sessions WHERE status = 'ended' AND ended_at < now() - make_interval(days => $1)`,
      [config.sessionRetentionDays],
    );
    result.sessionsDeleted = rowCount ?? 0;
  }

  const reports = await query(
    `UPDATE report_exports
        SET content = NULL,
            status = CASE WHEN status = 'pending' THEN 'failed' ELSE 'expired' END,
            error = CASE WHEN status = 'pending' THEN 'Generation did not finish.' ELSE error END
      WHERE status IN ('ready', 'pending') AND expires_at < now()`,
  );
  result.reportsErased = reports.rowCount ?? 0;

  if (config.auditRetentionDays > 0) {
    const { rowCount } = await query(
      `DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)`,
      [config.auditRetentionDays],
    );
    result.auditRowsDeleted = rowCount ?? 0;
  }

  const auth = await query(`DELETE FROM auth_sessions WHERE expires_at < now()`);
  result.authSessionsDeleted = auth.rowCount ?? 0;

  if (result.transcriptsPurged + result.sessionsDeleted + result.auditRowsDeleted > 0) {
    await writeAudit({
      orgId: org.id, actor: null, action: "retention.purged",
      detail: {
        transcriptsPurged: result.transcriptsPurged, sessionsDeleted: result.sessionsDeleted,
        auditRowsDeleted: result.auditRowsDeleted,
        policy: { transcriptDays: config.transcriptRetentionDays, sessionDays: config.sessionRetentionDays, auditDays: config.auditRetentionDays },
      },
    });
  }
  return result;
}

export function scheduleRetention(): NodeJS.Timeout {
  const tick = (): void => {
    runRetention().catch((err: unknown) => console.error("[retention] sweep failed:", err instanceof Error ? err.message : err));
  };
  tick();
  const timer = setInterval(tick, 60 * 60_000);
  timer.unref();
  return timer;
}
