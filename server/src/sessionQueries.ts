/**
 * Scoped, filtered session queries — shared by the history API and the CSV
 * summary export, so a report can never contain a row its requester could not
 * see in the history page. Every query starts from `sessionScopeSql()` (org +
 * role scope); filters only ever narrow it.
 */

import { sessionScopeSql, type Principal } from "./auth/permissions.js";
import { query } from "./db/pool.js";

export interface SessionFilters {
  q?: string;
  agentId?: string;
  teamId?: string;
  status?: string;
  endReason?: string;
  device?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SORTS: Record<string, string> = {
  created: "s.created_at",
  ended: "s.ended_at",
  duration: "duration_seconds",
  agent: "lower(s.agent_display_name)",
  device: "lower(s.customer_machine)",
  status: "s.status",
};

const STATUSES = new Set(["waiting", "active", "ended"]);

function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isoDate(v: string | undefined): string | null {
  if (v === undefined || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v)) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/** Only these string fields are read from a query string or a stored filter object. */
export function parseFilters(src: Record<string, unknown>): SessionFilters {
  const out: SessionFilters = {};
  for (const k of ["q", "agentId", "teamId", "status", "endReason", "device", "from", "to", "sort", "dir"] as const) {
    const v = src[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim().slice(0, 200);
  }
  return out;
}

export function buildSessionWhere(p: Principal, f: SessionFilters): { where: string; params: unknown[]; order: string } {
  const params: unknown[] = [];
  const clauses = [sessionScopeSql(p, params, "s")];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    clauses.push(sql(params.length));
  };

  if (f.q) {
    if (UUID_RE.test(f.q)) {
      add((n) => `s.id = $${n}`, f.q.toLowerCase());
    } else {
      const like = `%${likeEscape(f.q)}%`;
      add((n) => `(s.agent_display_name ILIKE $${n} OR s.agent_code ILIKE $${n} OR s.customer_machine ILIKE $${n}
                  OR s.customer_user ILIKE $${n} OR s.id::text LIKE $${n})`, like);
    }
  }
  if (f.agentId && UUID_RE.test(f.agentId)) add((n) => `s.agent_user_id = $${n}`, f.agentId);
  if (f.teamId && UUID_RE.test(f.teamId)) add((n) => `s.team_id = $${n}`, f.teamId);
  if (f.status && STATUSES.has(f.status)) {
    if (f.status === "waiting") clauses.push(`s.status IN ('waiting_for_customer', 'waiting_for_consent')`);
    else add((n) => `s.status = $${n}`, f.status);
  }
  if (f.endReason && /^[a-z_]{1,40}$/.test(f.endReason)) add((n) => `s.end_reason = $${n}`, f.endReason);
  if (f.device) add((n) => `s.customer_machine ILIKE $${n}`, `%${likeEscape(f.device)}%`);
  const from = isoDate(f.from);
  if (from) add((n) => `s.created_at >= $${n}::timestamptz`, from);
  const to = isoDate(f.to);
  // A bare date means "through the end of that day".
  if (to) add((n) => (to.length === 10 ? `s.created_at < ($${n}::date + 1)` : `s.created_at <= $${n}::timestamptz`), to);

  const sortCol = SORTS[f.sort ?? "created"] ?? SORTS["created"];
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  return { where: clauses.join(" AND "), params, order: `${sortCol} ${dir} NULLS LAST, s.id` };
}

/** Columns shared by the history list and the CSV summary. */
export const SESSION_LIST_COLUMNS = `
  s.id, s.status, s.end_reason, s.consent_decision, s.created_at, s.customer_joined_at, s.active_at, s.ended_at,
  s.agent_user_id, s.agent_display_name, s.agent_code, s.team_id, t.name AS team_name,
  s.customer_machine, s.customer_user, s.customer_os, s.record_complete, s.transcript_purged_at,
  CASE WHEN s.active_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.active_at))::int END AS duration_seconds`;

export interface SessionListRow {
  id: string;
  status: string;
  end_reason: string | null;
  consent_decision: string | null;
  created_at: Date;
  customer_joined_at: Date | null;
  active_at: Date | null;
  ended_at: Date | null;
  agent_user_id: string;
  agent_display_name: string;
  agent_code: string | null;
  team_id: string | null;
  team_name: string | null;
  customer_machine: string | null;
  customer_user: string | null;
  customer_os: string | null;
  record_complete: boolean;
  transcript_purged_at: Date | null;
  duration_seconds: number | null;
}

export async function listSessions(
  p: Principal,
  f: SessionFilters,
  page: number,
  pageSize: number,
): Promise<{ rows: SessionListRow[]; total: number }> {
  const { where, params, order } = buildSessionWhere(p, f);
  const total = await query<{ n: number }>(`SELECT count(*) AS n FROM sessions s WHERE ${where}`, params);
  const rows = await query<SessionListRow>(
    `SELECT ${SESSION_LIST_COLUMNS}
       FROM sessions s LEFT JOIN teams t ON t.id = s.team_id AND t.org_id = s.org_id
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  return { rows: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** One session the principal may see, or null (not found and not permitted look identical). */
export async function getScopedSession(p: Principal, id: string): Promise<SessionListRow | null> {
  if (!UUID_RE.test(id)) return null;
  const params: unknown[] = [];
  const scope = sessionScopeSql(p, params, "s");
  params.push(id);
  const { rows } = await query<SessionListRow>(
    `SELECT ${SESSION_LIST_COLUMNS}
       FROM sessions s LEFT JOIN teams t ON t.id = s.team_id AND t.org_id = s.org_id
      WHERE ${scope} AND s.id = $${params.length}`,
    params,
  );
  return rows[0] ?? null;
}
