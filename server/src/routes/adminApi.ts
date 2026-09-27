/**
 * Admin-portal API — mounted ONLY on the admin application, under /api/admin.
 * The admin listener only accepts admin-portal sessions, and those are only
 * issued to Admin, Supervisor or Auditor identities; each route below then
 * checks its own permission and scopes every query to the caller's
 * organisation (and, for supervisors, team).
 *
 * Every state change is CSRF-protected and rate-limited per user. Access
 * changes commit together with their audit row. Transcript/notes views and
 * report downloads write their audit row BEFORE returning data, and fail the
 * request if they cannot.
 */

import { randomUUID } from "node:crypto";

import express, { type Router } from "express";

import { writeAudit } from "../db/auditLog.js";
import { dbHealth, query, tx } from "../db/pool.js";
import { canSeeSession, permissionsOf, primaryRole, sessionScope, sessionScopeSql, eligibleRoles, can, type Principal } from "../auth/permissions.js";
import { csrfProtect, requireApi } from "../auth/middleware.js";
import { config } from "../config.js";
import { clientIp } from "../netinfo.js";
import { persistStats } from "../records.js";
import {
  END_REASON_LABELS, EVENT_TITLES, createExport, loadNotes, loadTimeline, loadTranscript, safeDetail,
  type ExportRequest,
} from "../reports.js";
import { UUID_RE, getScopedSession, listSessions, parseFilters } from "../sessionQueries.js";
import { RateLimiter } from "../sessions.js";
import { applyUserAccessChange, liveSessions, terminateSession } from "../signaling.js";
import { me, pageParams, perUserLimit, route, str } from "./common.js";

const mutationLimiter = new RateLimiter(60, 60_000);
const exportLimiter = new RateLimiter(10, 60_000);

const AGENT_CODE_RE = /^[A-Za-z0-9._-]{1,32}$/;

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  entra_object_id: string;
  entra_roles: string[];
  status: "pending" | "active" | "suspended";
  status_reason: string | null;
  status_changed_at: Date | null;
  status_changed_by_name: string | null;
  agent_code: string | null;
  team_id: string | null;
  team_name: string | null;
  can_use_console: boolean;
  allow_scripts: boolean;
  allow_elevation: boolean;
  can_export: boolean;
  max_concurrent_sessions: number;
  first_seen_at: Date;
  last_login_at: Date | null;
  last_heartbeat_at: Date | null;
}

const USER_COLUMNS = `
  u.id, u.display_name, u.email, u.entra_object_id, u.entra_roles, u.status, u.status_reason, u.status_changed_at,
  sb.display_name AS status_changed_by_name, u.agent_code, u.team_id, t.name AS team_name, u.can_use_console,
  u.allow_scripts, u.allow_elevation, u.can_export, u.max_concurrent_sessions, u.first_seen_at, u.last_login_at,
  u.last_heartbeat_at`;
const USER_FROM = `users u LEFT JOIN teams t ON t.id = u.team_id AND t.org_id = u.org_id
                   LEFT JOIN users sb ON sb.id = u.status_changed_by`;

function userView(r: UserRow): Record<string, unknown> {
  const roles = eligibleRoles(r.entra_roles);
  const online = r.last_heartbeat_at !== null && Date.now() - r.last_heartbeat_at.getTime() < config.presenceWindowSeconds * 1000;
  return {
    id: r.id, displayName: r.display_name, email: r.email, objectId: r.entra_object_id,
    entraRoles: roles, primaryRole: primaryRole(roles),
    // The portal cannot change Entra assignments; it can only say that one is needed.
    entraAssignment: roles.length === 0 ? "required" : "assigned",
    status: r.status, statusReason: r.status_reason, statusChangedAt: r.status_changed_at, statusChangedBy: r.status_changed_by_name,
    agentCode: r.agent_code, team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
    limits: {
      canUseConsole: r.can_use_console, allowScripts: r.allow_scripts, allowElevation: r.allow_elevation,
      canExport: r.can_export, maxConcurrentSessions: r.max_concurrent_sessions,
    },
    firstSeenAt: r.first_seen_at, lastLoginAt: r.last_login_at, lastHeartbeatAt: r.last_heartbeat_at, online,
  };
}

async function loadUser(orgId: string, id: string): Promise<UserRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await query<UserRow>(`SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE u.org_id = $1 AND u.id = $2`, [orgId, id]);
  return rows[0] ?? null;
}

/** Push a committed access change into any live sockets the user holds. */
async function propagate(orgId: string, userId: string): Promise<void> {
  const u = await loadUser(orgId, userId);
  if (!u) return;
  applyUserAccessChange(userId, {
    status: u.status,
    teamId: u.team_id,
    agentCode: u.agent_code,
    limits: {
      canUseConsole: u.can_use_console, allowScripts: u.allow_scripts, allowElevation: u.allow_elevation,
      canExport: u.can_export, maxConcurrentSessions: u.max_concurrent_sessions,
    },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown }).code === "23505";
}

async function teamInOrg(orgId: string, teamId: unknown): Promise<string | null | false> {
  if (teamId === null || teamId === undefined || teamId === "") return null;
  if (typeof teamId !== "string" || !UUID_RE.test(teamId)) return false;
  const { rows } = await query("SELECT 1 FROM teams WHERE id = $1 AND org_id = $2", [teamId, orgId]);
  return rows.length > 0 ? teamId : false;
}

export function adminApiRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(requireApi());
  router.use(csrfProtect());
  // State changes, whatever the route, are rate-limited per user.
  router.use((req, res, next) => {
    if (req.method === "GET") next();
    else perUserLimit(mutationLimiter)(req, res, next);
  });

  /* --------------------------------------------------------------- identity */

  router.get("/me", route(async (req, res) => {
    const p = me(req);
    res.json({
      user: { id: p.userId, displayName: p.displayName, email: p.email, roles: p.roles, primaryRole: primaryRole(p.roles), teamId: p.teamId },
      permissions: permissionsOf(p),
      scope: sessionScope(p),
      csrfToken: p.csrfToken,
      authMode: p.authMethod,
      org: config.orgName,
    });
  }));

  router.get("/settings", requireApi("dashboard.view"), route(async (_req, res) => {
    res.json({
      retention: {
        transcriptDays: config.transcriptRetentionDays,
        sessionDays: config.sessionRetentionDays,
        auditDays: config.auditRetentionDays,
        reportTtlMinutes: config.reportTtlMinutes,
      },
      presenceWindowSeconds: config.presenceWindowSeconds,
      reportTimezone: config.reportTimezone,
      authMode: config.authMode,
      authIdleMinutes: config.authIdleMinutes,
      authMaxHours: config.authMaxHours,
      agentConsoleHost: config.publicHost,
      adminPortalHost: config.adminPublicHost,
    });
  }));

  /* -------------------------------------------------------------- dashboard */

  router.get("/dashboard", requireApi("dashboard.view"), route(async (req, res) => {
    const p = me(req);
    const tz = config.reportTimezone;

    // Agents online: distinct active users with a console heartbeat inside the window.
    const userParams: unknown[] = [p.orgId, config.presenceWindowSeconds];
    let teamClause = "";
    if (sessionScope(p) === "team") {
      userParams.push(p.teamId);
      teamClause = ` AND team_id IS NOT DISTINCT FROM $${userParams.length}`;
    }
    const online = await query<{ id: string; display_name: string; agent_code: string | null }>(
      `SELECT id, display_name, agent_code FROM users
        WHERE org_id = $1 AND status = 'active' AND last_heartbeat_at > now() - make_interval(secs => $2)${teamClause}
        ORDER BY display_name`,
      userParams,
    );

    const params: unknown[] = [];
    const scope = sessionScopeSql(p, params, "s");
    params.push(tz);
    const tzN = params.length;
    const today = `(date_trunc('day', now() AT TIME ZONE $${tzN}) AT TIME ZONE $${tzN})`;

    const counts = await query<Record<string, number | null>>(
      `SELECT
         count(*) FILTER (WHERE s.status = 'active') AS active_sessions,
         count(*) FILTER (WHERE s.status IN ('waiting_for_customer', 'waiting_for_consent')) AS waiting_sessions,
         count(*) FILTER (WHERE s.created_at >= ${today}) AS created_today,
         count(*) FILTER (WHERE s.status = 'ended' AND s.active_at IS NOT NULL AND s.ended_at >= ${today}) AS completed_today,
         count(*) FILTER (WHERE s.consent_decision = 'declined' AND s.created_at >= ${today}) AS declined_today,
         (avg(EXTRACT(EPOCH FROM (s.ended_at - s.active_at)))
            FILTER (WHERE s.status = 'ended' AND s.active_at IS NOT NULL AND s.ended_at >= ${today}))::int AS avg_duration_today,
         count(*) FILTER (WHERE NOT s.record_complete) AS incomplete_records
       FROM sessions s WHERE ${scope}`,
      params,
    );

    const trend = await query<{ day: string; created: number; completed: number }>(
      `WITH days AS (
         SELECT generate_series((now() AT TIME ZONE $${tzN})::date - 13, (now() AT TIME ZONE $${tzN})::date, '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              count(s.id) AS created,
              count(s.id) FILTER (WHERE s.active_at IS NOT NULL AND s.status = 'ended') AS completed
         FROM days d
         LEFT JOIN sessions s ON (s.created_at AT TIME ZONE $${tzN})::date = d.day AND ${scope}
        GROUP BY d.day ORDER BY d.day`,
      params,
    );

    const byAgent = await query<{ agent_user_id: string; agent_display_name: string; agent_code: string | null; sessions: number; completed: number; active_seconds: number | null }>(
      `SELECT s.agent_user_id, max(s.agent_display_name) AS agent_display_name, max(s.agent_code) AS agent_code,
              count(*) AS sessions,
              count(*) FILTER (WHERE s.active_at IS NOT NULL AND s.status = 'ended') AS completed,
              sum(EXTRACT(EPOCH FROM (s.ended_at - s.active_at)))::int AS active_seconds
         FROM sessions s
        WHERE ${scope} AND s.created_at >= now() - interval '30 days'
        GROUP BY s.agent_user_id ORDER BY sessions DESC LIMIT 20`,
      params.slice(0, tzN - 1),
    );

    const recent = await listSessions(p, {}, 1, 10);

    const c = counts.rows[0] ?? {};
    res.json({
      definitions: {
        agentsOnline: `Distinct active technicians whose console sent a heartbeat in the last ${config.presenceWindowSeconds} seconds. One technician with several sessions counts once.`,
        activeSessions: "Sessions where the customer's applet is connected and the customer has accepted consent.",
        createdToday: `Sessions created since midnight (${tz}).`,
        completedToday: `Sessions that became active and have since ended, with the end since midnight (${tz}).`,
      },
      scope: sessionScope(p),
      agentsOnline: online.rows.length,
      onlineAgents: online.rows.map((r) => ({ id: r.id, name: r.display_name, agentCode: r.agent_code })),
      activeSessions: c["active_sessions"] ?? 0,
      waitingSessions: c["waiting_sessions"] ?? 0,
      createdToday: c["created_today"] ?? 0,
      completedToday: c["completed_today"] ?? 0,
      declinedToday: c["declined_today"] ?? 0,
      avgDurationTodaySeconds: c["avg_duration_today"] ?? null,
      incompleteRecords: c["incomplete_records"] ?? 0,
      trend: trend.rows,
      byAgent: byAgent.rows.map((r) => ({
        agentId: r.agent_user_id, name: r.agent_display_name, agentCode: r.agent_code,
        sessions: r.sessions, completed: r.completed, activeSeconds: r.active_seconds ?? 0,
      })),
      recent: recent.rows.map(sessionListView),
      storage: {
        databaseOk: dbHealth.ok,
        lastDatabaseError: dbHealth.ok ? null : dbHealth.lastError,
        recordWriteFailuresSinceStart: persistStats.failures,
        lastRecordWriteFailureAt: persistStats.lastFailureAt,
      },
    });
  }));

  /* ------------------------------------------------------------ users/teams */

  router.get("/users", requireApi("users.read"), route(async (req, res) => {
    const p = me(req);
    const params: unknown[] = [p.orgId];
    const where = ["u.org_id = $1"];
    const status = str(req.query["status"], 20);
    if (status && ["pending", "active", "suspended"].includes(status)) {
      params.push(status);
      where.push(`u.status = $${params.length}`);
    }
    const q = str(req.query["q"], 100);
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.agent_code ILIKE $${params.length})`);
    }
    // Supervisors see their own team only; admins and auditors the organisation.
    if (sessionScope(p) === "team") {
      params.push(p.teamId);
      where.push(`u.team_id IS NOT DISTINCT FROM $${params.length}`);
    }
    const { rows } = await query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE ${where.join(" AND ")}
        ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, lower(u.display_name) LIMIT 500`,
      params,
    );
    res.json({ items: rows.map(userView) });
  }));

  router.post("/users/:id/activate", requireApi("users.manage"), route(async (req, res) => {
    const p = me(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = await loadUser(p.orgId, String(req.params["id"]));
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (target.status !== "pending") {
      res.status(409).json({ error: "not_pending" });
      return;
    }
    if (eligibleRoles(target.entra_roles).length === 0) {
      res.status(409).json({ error: "entra_role_required",
        message: "Assign this person an app role on the enterprise application in the Entra admin center, then ask them to sign in again." });
      return;
    }
    const agentCode = typeof body["agentCode"] === "string" ? body["agentCode"].trim() : "";
    if (!AGENT_CODE_RE.test(agentCode)) {
      res.status(400).json({ error: "invalid_agent_code", message: "Agent ID: 1–32 letters, digits, dot, dash or underscore." });
      return;
    }
    const teamId = await teamInOrg(p.orgId, body["teamId"]);
    if (teamId === false) {
      res.status(400).json({ error: "invalid_team" });
      return;
    }
    try {
      await tx(async (client) => {
        await client.query(
          `UPDATE users SET status = 'active', agent_code = $3, team_id = $4, status_reason = NULL,
                  status_changed_at = now(), status_changed_by = $5, updated_at = now()
            WHERE id = $1 AND org_id = $2`,
          [target.id, p.orgId, agentCode, teamId, p.userId],
        );
        await writeAudit({ orgId: p.orgId, actor: p, action: "access.activated", targetType: "user", targetId: target.id,
          detail: { agentCode, teamId, name: target.display_name }, ip: clientIp(req) }, client);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "agent_code_taken" });
        return;
      }
      throw err;
    }
    res.json({ user: userView((await loadUser(p.orgId, target.id)) as UserRow) });
  }));

  router.post("/users/:id/suspend", requireApi("users.manage"), route(async (req, res) => {
    const p = me(req);
    const target = await loadUser(p.orgId, String(req.params["id"]));
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (target.id === p.userId) {
      res.status(409).json({ error: "cannot_suspend_self" });
      return;
    }
    if (target.status === "suspended") {
      res.status(409).json({ error: "already_suspended" });
      return;
    }
    const reason = str((req.body as Record<string, unknown> | undefined)?.["reason"], 300) ?? "";
    const blocked = await tx(async (client) => {
      if (target.status === "active" && target.entra_roles.includes("Admin")) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*) AS n FROM users WHERE org_id = $1 AND status = 'active' AND 'Admin' = ANY(entra_roles) AND id <> $2`,
          [p.orgId, target.id],
        );
        if ((rows[0]?.n ?? 0) === 0) return true;
      }
      await client.query(
        `UPDATE users SET status = 'suspended', status_reason = $3, status_changed_at = now(), status_changed_by = $4, updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [target.id, p.orgId, reason || null, p.userId],
      );
      await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [target.id]);
      await writeAudit({ orgId: p.orgId, actor: p, action: "access.suspended", targetType: "user", targetId: target.id,
        detail: { reason, previousStatus: target.status, name: target.display_name }, ip: clientIp(req) }, client);
      return false;
    });
    if (blocked) {
      res.status(409).json({ error: "last_admin" });
      return;
    }
    // Live sockets: end their sessions and close them now, not at cookie expiry.
    await propagate(p.orgId, target.id);
    res.json({ user: userView((await loadUser(p.orgId, target.id)) as UserRow) });
  }));

  router.post("/users/:id/reactivate", requireApi("users.manage"), route(async (req, res) => {
    const p = me(req);
    const target = await loadUser(p.orgId, String(req.params["id"]));
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (target.status !== "suspended") {
      res.status(409).json({ error: "not_suspended" });
      return;
    }
    if (eligibleRoles(target.entra_roles).length === 0) {
      res.status(409).json({ error: "entra_role_required" });
      return;
    }
    await tx(async (client) => {
      await client.query(
        `UPDATE users SET status = 'active', status_reason = NULL, status_changed_at = now(), status_changed_by = $3, updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [target.id, p.orgId, p.userId],
      );
      await writeAudit({ orgId: p.orgId, actor: p, action: "access.reactivated", targetType: "user", targetId: target.id,
        detail: { name: target.display_name }, ip: clientIp(req) }, client);
    });
    res.json({ user: userView((await loadUser(p.orgId, target.id)) as UserRow) });
  }));

  router.patch("/users/:id", requireApi("users.manage"), route(async (req, res) => {
    const p = me(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = await loadUser(p.orgId, String(req.params["id"]));
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [target.id, p.orgId];
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set = (col: string, key: string, from: unknown, to: unknown): void => {
      if (from === to) return;
      params.push(to);
      sets.push(`${col} = $${params.length}`);
      changes[key] = { from, to };
    };

    if ("agentCode" in body) {
      const v = typeof body["agentCode"] === "string" ? body["agentCode"].trim() : "";
      if (!AGENT_CODE_RE.test(v)) {
        res.status(400).json({ error: "invalid_agent_code" });
        return;
      }
      set("agent_code", "agentCode", target.agent_code, v);
    }
    if ("teamId" in body) {
      const teamId = await teamInOrg(p.orgId, body["teamId"]);
      if (teamId === false) {
        res.status(400).json({ error: "invalid_team" });
        return;
      }
      set("team_id", "teamId", target.team_id, teamId);
    }
    const limits = (body["limits"] ?? {}) as Record<string, unknown>;
    const bools: Array<[string, string, boolean]> = [
      ["canUseConsole", "can_use_console", target.can_use_console],
      ["allowScripts", "allow_scripts", target.allow_scripts],
      ["allowElevation", "allow_elevation", target.allow_elevation],
      ["canExport", "can_export", target.can_export],
    ];
    for (const [key, col, current] of bools) {
      if (key in limits) {
        if (typeof limits[key] !== "boolean") {
          res.status(400).json({ error: "invalid_limit", field: key });
          return;
        }
        set(col, key, current, limits[key]);
      }
    }
    if ("maxConcurrentSessions" in limits) {
      const n = limits["maxConcurrentSessions"];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
        res.status(400).json({ error: "invalid_limit", field: "maxConcurrentSessions" });
        return;
      }
      set("max_concurrent_sessions", "maxConcurrentSessions", target.max_concurrent_sessions, n);
    }

    if (sets.length > 0) {
      try {
        await tx(async (client) => {
          await client.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND org_id = $2`, params);
          await writeAudit({ orgId: p.orgId, actor: p, action: "access.updated", targetType: "user", targetId: target.id,
            detail: { changes, name: target.display_name }, ip: clientIp(req) }, client);
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          res.status(409).json({ error: "agent_code_taken" });
          return;
        }
        throw err;
      }
      await propagate(p.orgId, target.id);
    }
    res.json({ user: userView((await loadUser(p.orgId, target.id)) as UserRow), changed: Object.keys(changes) });
  }));

  router.get("/teams", requireApi("users.read"), route(async (req, res) => {
    const p = me(req);
    const { rows } = await query<{ id: string; name: string; members: number }>(
      `SELECT t.id, t.name, count(u.id) AS members FROM teams t
         LEFT JOIN users u ON u.team_id = t.id AND u.org_id = t.org_id
        WHERE t.org_id = $1 GROUP BY t.id ORDER BY lower(t.name)`,
      [p.orgId],
    );
    res.json({ items: rows });
  }));

  router.post("/teams", requireApi("teams.manage"), route(async (req, res) => {
    const p = me(req);
    const name = str((req.body as Record<string, unknown> | undefined)?.["name"], 200)?.trim() ?? "";
    if (name.length < 1 || name.length > 80) {
      res.status(400).json({ error: "invalid_name" });
      return;
    }
    const id = randomUUID();
    try {
      await tx(async (client) => {
        await client.query("INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)", [id, p.orgId, name]);
        await writeAudit({ orgId: p.orgId, actor: p, action: "team.created", targetType: "team", targetId: id, detail: { name }, ip: clientIp(req) }, client);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "team_exists" });
        return;
      }
      throw err;
    }
    res.status(201).json({ id, name });
  }));

  router.patch("/teams/:id", requireApi("teams.manage"), route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    const name = str((req.body as Record<string, unknown> | undefined)?.["name"], 200)?.trim() ?? "";
    if (!UUID_RE.test(id) || name.length < 1 || name.length > 80) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const found = await tx(async (client) => {
        const r = await client.query<{ name: string }>("SELECT name FROM teams WHERE id = $1 AND org_id = $2 FOR UPDATE", [id, p.orgId]);
        const before = r.rows[0];
        if (!before) return false;
        await client.query("UPDATE teams SET name = $3 WHERE id = $1 AND org_id = $2", [id, p.orgId, name]);
        await writeAudit({ orgId: p.orgId, actor: p, action: "team.renamed", targetType: "team", targetId: id,
          detail: { from: before.name, to: name }, ip: clientIp(req) }, client);
        return true;
      });
      if (!found) {
        res.status(404).json({ error: "not_found" });
        return;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "team_exists" });
        return;
      }
      throw err;
    }
    res.json({ id, name });
  }));

  /* --------------------------------------------------------------- sessions */

  router.get("/sessions/live", requireApi("sessions.read"), route(async (req, res) => {
    const p = me(req);
    const now = Date.now();
    const items = liveSessions()
      .filter((s) => canSeeSession(p, s))
      .map((s) => ({
        id: s.id, agentUserId: s.agentUserId, agentName: s.agentName, agentCode: s.agentCode, teamId: s.teamId,
        state: s.state, held: s.held, consent: s.consentedAt !== null ? "accepted" : s.state === "waiting_for_consent" ? "pending" : "not_requested",
        createdAt: new Date(s.createdAt), consentedAt: s.consentedAt ? new Date(s.consentedAt) : null,
        durationSeconds: s.consentedAt ? Math.round((now - s.consentedAt) / 1000) : null,
        customer: s.customer,
        canTerminate: can(p, "sessions.terminate"),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json({ items });
  }));

  router.get("/sessions", requireApi("sessions.read"), route(async (req, res) => {
    const p = me(req);
    const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
    const { rows, total } = await listSessions(p, parseFilters(req.query as Record<string, unknown>), page, pageSize);
    res.json({ items: rows.map(sessionListView), total, page, pageSize });
  }));

  router.get("/sessions/:id", requireApi("sessions.read"), route(async (req, res) => {
    const p = me(req);
    const s = await getScopedSession(p, String(req.params["id"]));
    if (!s) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const timeline = await loadTimeline(p.orgId, s.id);
    const counts = await query<{ chat: number; notes: number }>(
      `SELECT (SELECT count(*) FROM chat_messages WHERE org_id = $1 AND session_id = $2) AS chat,
              (SELECT count(*) FROM session_notes WHERE org_id = $1 AND session_id = $2) AS notes`,
      [p.orgId, s.id],
    );
    res.json({
      session: sessionListView(s),
      timeline: timeline.map((e) => ({
        seq: e.seq, type: e.type, title: EVENT_TITLES[e.type] ?? e.type, at: e.at,
        actorRole: e.actor_role, actorName: e.actor_name, detail: safeDetail(e.detail),
      })),
      counts: counts.rows[0] ?? { chat: 0, notes: 0 },
      live: liveSessions().some((l) => l.id === s.id),
      permissions: {
        transcript: can(p, "transcripts.read"),
        notes: can(p, "notes.read"),
        export: can(p, "reports.export"),
        terminate: can(p, "sessions.terminate"),
      },
    });
  }));

  router.get("/sessions/:id/transcript", requireApi("transcripts.read"), route(async (req, res) => {
    const p = me(req);
    const s = await getScopedSession(p, String(req.params["id"]));
    if (!s) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Audit first: no transcript leaves the server without its record.
    await writeAudit({ orgId: p.orgId, actor: p, action: "transcript.viewed", targetType: "session", targetId: s.id, ip: clientIp(req) });
    if (s.transcript_purged_at) {
      res.json({ purged: true, purgedAt: s.transcript_purged_at, messages: [] });
      return;
    }
    const rows = await loadTranscript(p.orgId, s.id);
    res.json({
      purged: false,
      messages: rows.map((m) => ({
        seq: m.seq, sender: m.sender_role, senderName: m.sender_role === "agent" ? m.sender_name : "Customer",
        kind: m.kind, text: m.body, url: m.url, label: m.label, at: m.created_at,
      })),
    });
  }));

  router.get("/sessions/:id/notes", requireApi("notes.read"), route(async (req, res) => {
    const p = me(req);
    const s = await getScopedSession(p, String(req.params["id"]));
    if (!s) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await writeAudit({ orgId: p.orgId, actor: p, action: "notes.viewed", targetType: "session", targetId: s.id, ip: clientIp(req) });
    if (s.transcript_purged_at) {
      res.json({ purged: true, notes: [] });
      return;
    }
    const rows = await loadNotes(p.orgId, s.id);
    res.json({ purged: false, notes: rows.map((n) => ({ author: n.author_name, body: n.body, at: n.created_at })) });
  }));

  router.post("/sessions/:id/terminate", requireApi("sessions.terminate"), route(async (req, res) => {
    const p = me(req);
    const s = await getScopedSession(p, String(req.params["id"]));
    if (!s) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!liveSessions().some((l) => l.id === s.id)) {
      res.status(409).json({ error: "not_live" });
      return;
    }
    await writeAudit({ orgId: p.orgId, actor: p, action: "session.terminated", targetType: "session", targetId: s.id,
      detail: { agent: s.agent_display_name, reason: str((req.body as Record<string, unknown> | undefined)?.["reason"], 300) }, ip: clientIp(req) });
    const ended = await terminateSession(s.id, p);
    res.json({ ok: ended });
  }));

  /* ---------------------------------------------------------------- reports */

  router.post("/reports", requireApi("reports.export"), perUserLimit(exportLimiter), route(async (req, res) => {
    const p = me(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    let request: ExportRequest;

    if (body["kind"] === "session_pdf") {
      const s = await getScopedSession(p, String(body["sessionId"] ?? ""));
      if (!s) {
        await writeAudit({ orgId: p.orgId, actor: p, action: "report.denied", detail: { kind: "session_pdf", reason: "not_in_scope" }, ip: clientIp(req) });
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Content the role may not view is never included, whatever was asked for.
      const include = {
        chat: body["includeChat"] !== false && can(p, "transcripts.read"),
        notes: body["includeNotes"] !== false && can(p, "notes.read"),
      };
      request = { kind: "session_pdf", sessionId: s.id, include };
    } else if (body["kind"] === "summary_csv") {
      request = { kind: "summary_csv", filters: parseFilters((body["filters"] ?? {}) as Record<string, unknown>) };
    } else {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }

    const id = await createExport(p, request);
    await writeAudit({ orgId: p.orgId, actor: p, action: "report.requested", targetType: "report", targetId: id,
      detail: request.kind === "session_pdf"
        ? { kind: request.kind, sessionId: request.sessionId, include: request.include }
        : { kind: request.kind, filters: request.filters },
      ip: clientIp(req) });
    res.status(202).json({ id, status: "pending" });
  }));

  router.get("/reports", requireApi("reports.export"), route(async (req, res) => {
    const p = me(req);
    const { rows } = await query(
      `SELECT r.id, r.kind, r.session_id, r.status, r.filename, r.byte_size, r.download_count, r.created_at, r.ready_at,
              r.expires_at, r.error, r.params
         FROM report_exports r WHERE r.org_id = $1 AND r.requested_by = $2
        ORDER BY r.created_at DESC LIMIT 50`,
      [p.orgId, p.userId],
    );
    res.json({ items: rows.map(reportView), ttlMinutes: config.reportTtlMinutes });
  }));

  router.get("/reports/:id", requireApi("reports.export"), route(async (req, res) => {
    const p = me(req);
    const r = await ownReport(p, String(req.params["id"]));
    if (!r) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(reportView(r));
  }));

  router.get("/reports/:id/download", requireApi("reports.export"), route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    // Only the requester, only while ready and unexpired. Everyone else — an
    // admin included — gets the same 404, and the attempt is audited.
    const r = await ownReport(p, id);
    if (!r || r.status !== "ready" || new Date(r.expires_at).getTime() <= Date.now()) {
      await writeAudit({ orgId: p.orgId, actor: p, action: "report.denied", targetType: "report", targetId: UUID_RE.test(id) ? id : undefined,
        detail: { reason: !r ? "not_found_or_not_owner" : r.status !== "ready" ? `status_${r.status}` : "expired" }, ip: clientIp(req) });
      res.status(404).json({ error: "not_available" });
      return;
    }
    const content = await query<{ content: Buffer; content_type: string; filename: string }>(
      `UPDATE report_exports SET download_count = download_count + 1 WHERE id = $1 AND org_id = $2 AND requested_by = $3
       RETURNING content, content_type, filename`,
      [r.id, p.orgId, p.userId],
    );
    const file = content.rows[0];
    if (!file) {
      res.status(404).json({ error: "not_available" });
      return;
    }
    await writeAudit({ orgId: p.orgId, actor: p, action: "report.downloaded", targetType: "report", targetId: r.id,
      detail: { kind: r.kind, sessionId: r.session_id, bytes: r.byte_size }, ip: clientIp(req) });
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/[^\w.-]/g, "_")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(file.content);
  }));

  /* ------------------------------------------------------------------ audit */

  router.get("/audit", requireApi("audit.read"), route(async (req, res) => {
    const p = me(req);
    const { page, pageSize } = pageParams(req.query as Record<string, unknown>, 200);
    const params: unknown[] = [p.orgId];
    const where = ["a.org_id = $1"];
    const action = str(req.query["action"], 60);
    if (action && /^[a-z_.]+$/.test(action)) {
      params.push(action.endsWith(".") ? `${action}%` : action);
      where.push(action.endsWith(".") ? `a.action LIKE $${params.length}` : `a.action = $${params.length}`);
    }
    const actor = str(req.query["actorId"], 64);
    if (actor && UUID_RE.test(actor)) {
      params.push(actor);
      where.push(`a.actor_user_id = $${params.length}`);
    }
    const target = str(req.query["targetId"], 64);
    if (target) {
      params.push(target);
      where.push(`a.target_id = $${params.length}`);
    }
    for (const [key, op] of [["from", ">="], ["to", "<"]] as const) {
      const v = str(req.query[key], 40);
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        params.push(v);
        where.push(key === "to" ? `a.at < ($${params.length}::date + 1)` : `a.at ${op} $${params.length}::date`);
      }
    }
    const total = await query<{ n: number }>(`SELECT count(*) AS n FROM audit_log a WHERE ${where.join(" AND ")}`, params);
    const { rows } = await query(
      `SELECT a.id, a.at, a.actor_label, a.actor_user_id, a.action, a.target_type, a.target_id, a.detail, a.ip,
              tu.display_name AS target_user_name
         FROM audit_log a LEFT JOIN users tu ON a.target_type = 'user' AND tu.id::text = a.target_id AND tu.org_id = a.org_id
        WHERE ${where.join(" AND ")} ORDER BY a.at DESC, a.id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    res.json({ items: rows, total: total.rows[0]?.n ?? 0, page, pageSize });
  }));

  return router;
}

interface ReportRow {
  id: string; kind: string; session_id: string | null; status: string; filename: string | null; byte_size: number | null;
  download_count: number; created_at: Date; ready_at: Date | null; expires_at: Date; error: string | null; params: unknown;
}

async function ownReport(p: Principal, id: string): Promise<ReportRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await query<ReportRow>(
    `SELECT id, kind, session_id, status, filename, byte_size, download_count, created_at, ready_at, expires_at, error, params
       FROM report_exports WHERE id = $1 AND org_id = $2 AND requested_by = $3`,
    [id, p.orgId, p.userId],
  );
  return rows[0] ?? null;
}

function reportView(r: ReportRow | Record<string, unknown>): Record<string, unknown> {
  const x = r as ReportRow;
  const expired = new Date(x.expires_at).getTime() <= Date.now();
  return {
    id: x.id, kind: x.kind, sessionId: x.session_id,
    status: x.status === "ready" && expired ? "expired" : x.status,
    filename: x.filename, bytes: x.byte_size, downloads: x.download_count, createdAt: x.created_at,
    readyAt: x.ready_at, expiresAt: x.expires_at, error: x.error, params: x.params,
  };
}

export function sessionListView(r: {
  id: string; status: string; end_reason: string | null; consent_decision: string | null; created_at: Date;
  customer_joined_at: Date | null; active_at: Date | null; ended_at: Date | null; agent_user_id: string;
  agent_display_name: string; agent_code: string | null; team_id: string | null; team_name: string | null;
  customer_machine: string | null; customer_user: string | null; customer_os: string | null; record_complete: boolean;
  transcript_purged_at: Date | null; duration_seconds: number | null;
}): Record<string, unknown> {
  return {
    id: r.id, status: r.status, endReason: r.end_reason,
    endReasonLabel: r.end_reason ? END_REASON_LABELS[r.end_reason] ?? r.end_reason : null,
    consent: r.consent_decision, createdAt: r.created_at, customerJoinedAt: r.customer_joined_at,
    activeAt: r.active_at, endedAt: r.ended_at, durationSeconds: r.duration_seconds,
    agent: { id: r.agent_user_id, name: r.agent_display_name, agentCode: r.agent_code },
    team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
    customer: { machine: r.customer_machine, user: r.customer_user, os: r.customer_os },
    recordComplete: r.record_complete, transcriptPurgedAt: r.transcript_purged_at,
  };
}
