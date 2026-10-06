/**
 * Agent-console API — mounted ONLY on the agent application, under /api/agent.
 *
 *   GET  /api/agent/me                     who am I (verified identity, limits, CSRF token)
 *   POST /api/agent/presence               console heartbeat ("agents online")
 *   GET  /api/agent/sessions/live          my live sessions and my concurrent-session limit
 *   GET  /api/agent/dashboard              my queue counts, completed today, recent history (search/filter)
 *   GET  /api/agent/sessions/:id/notes     my private notes for a session I ran
 *   POST /api/agent/sessions/:id/notes     save a new revision of them
 *
 * Notes travel over this authenticated HTTPS API and never over the WebSocket,
 * so there is no path by which they could reach the customer's socket.
 */

import express, { type Router } from "express";

import { permissionsOf, primaryRole } from "../auth/permissions.js";
import { csrfProtect, requireApi } from "../auth/middleware.js";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { MAX_NOTES_LENGTH } from "../protocol.js";
import { recordEvent } from "../records.js";
import { PHASES, type SessionPhase } from "../lifecycle.js";
import { END_REASON_LABELS } from "../reports.js";
import { UUID_RE, likeEscape } from "../sessionQueries.js";
import { RateLimiter, sessions } from "../sessions.js";
import { effectiveSessionLimit, liveSessions } from "../signaling.js";
import { me, perUserLimit, route } from "./common.js";
import { randomUUID } from "node:crypto";

const notesLimiter = new RateLimiter(60, 60_000);

/** Timeline entry for a notes save, whether or not the session is still live. */
export async function recordNotesEvent(orgId: string, sessionId: string, userId: string, length: number): Promise<void> {
  const live = sessions.byId(sessionId);
  if (live && live.orgId === orgId) {
    await recordEvent(live, "notes.saved", "agent", { length }, userId);
    return;
  }
  await query(
    `INSERT INTO session_events (session_id, seq, org_id, type, at, actor_role, actor_user_id, detail)
     SELECT $1, COALESCE(max(seq), 0) + 1, $2, 'notes.saved', now(), 'agent', $3, $4
       FROM session_events WHERE session_id = $1`,
    [sessionId, orgId, userId, JSON.stringify({ length })],
  );
}

export function agentApiRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(requireApi("console.use"));
  router.use(csrfProtect());

  router.get("/me", route(async (req, res) => {
    const p = me(req);
    const team = p.teamId
      ? (await query<{ name: string }>("SELECT name FROM teams WHERE id = $1 AND org_id = $2", [p.teamId, p.orgId])).rows[0]?.name ?? null
      : null;
    res.json({
      user: {
        id: p.userId, displayName: p.displayName, email: p.email, agentCode: p.agentCode, team,
        roles: p.roles, primaryRole: primaryRole(p.roles), limits: p.limits,
        // Multi-session: min(account limit, server ceiling) — what the relay enforces.
        maxSessions: effectiveSessionLimit(p),
      },
      permissions: permissionsOf(p),
      csrfToken: p.csrfToken,
      authMode: p.authMethod,
      org: config.orgName,
      chatRetentionDays: config.transcriptRetentionDays,
      heartbeatSeconds: Math.max(10, Math.floor(config.presenceWindowSeconds / 3)),
    });
  }));

  router.post("/presence", route(async (req, res) => {
    const p = me(req);
    await query("UPDATE users SET last_heartbeat_at = now() WHERE id = $1 AND org_id = $2", [p.userId, p.orgId]);
    res.status(204).end();
  }));

  /**
   * Multi-session: this technician's own live sessions — never anyone else's —
   * and the limit the relay will hold them to. Carries no pairing code and no
   * resume token: those only ever travel on the owning socket.
   */
  router.get("/sessions/live", route(async (req, res) => {
    const p = me(req);
    const now = Date.now();
    const items = liveSessions()
      .filter((s) => s.orgId === p.orgId && s.agentUserId === p.userId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s.id, state: s.state, held: s.held, reconnecting: s.reconnecting, reconnectCount: s.reconnectCount,
        elevated: s.elevated, createdAt: new Date(s.createdAt),
        phase: s.phase, phaseSince: new Date(s.phaseSince), hostRttMs: s.hostRttMs,
        durationSeconds: s.consentedAt ? Math.round((now - s.consentedAt) / 1000) : null,
        customer: s.customer,
      }));
    res.json({ items, active: items.length, maxSessions: effectiveSessionLimit(p) });
  }));

  /**
   * Platform 2.0 technician dashboard: this technician's own queue and history —
   * never anyone else's (the WHERE is pinned to the signed-in user, whatever the
   * query string says). Live counts come from the relay; "completed today" and
   * the recent list from the record.
   *
   *   since   ISO timestamp of the technician's local midnight (default: UTC midnight)
   *   q       machine / user / session-id prefix
   *   phase   one lifecycle phase
   */
  router.get("/dashboard", route(async (req, res) => {
    const p = me(req);
    const live = liveSessions().filter((s) => s.orgId === p.orgId && s.agentUserId === p.userId);
    const count = (...phases: SessionPhase[]): number => live.filter((s) => phases.includes(s.phase)).length;

    const sinceRaw = typeof req.query["since"] === "string" ? Date.parse(req.query["since"]) : NaN;
    const now = Date.now();
    const utcMidnight = new Date(new Date().toISOString().slice(0, 10)).getTime();
    // A day either side of UTC midnight covers every time zone; anything else is ignored.
    const since = Number.isFinite(sinceRaw) && Math.abs(sinceRaw - utcMidnight) <= 36 * 3600_000 ? sinceRaw : utcMidnight;

    const q = typeof req.query["q"] === "string" ? req.query["q"].trim().slice(0, 100) : "";
    const phaseRaw = typeof req.query["phase"] === "string" ? req.query["phase"] : "";
    const phase = (PHASES as readonly string[]).includes(phaseRaw) ? phaseRaw : null;

    const params: unknown[] = [p.orgId, p.userId];
    const where = ["s.org_id = $1", "s.agent_user_id = $2", "s.status = 'ended'"];
    if (phase !== null) { params.push(phase); where.push(`s.phase = $${params.length}`); }
    if (q !== "") {
      if (UUID_RE.test(q)) { params.push(q); where.push(`s.id = $${params.length}`); }
      else {
        params.push(`%${likeEscape(q)}%`);
        where.push(`(s.customer_machine ILIKE $${params.length} OR s.customer_user ILIKE $${params.length})`);
      }
    }

    const [recent, today] = await Promise.all([
      query<{ id: string; customer_machine: string | null; customer_user: string | null; customer_os: string | null;
        created_at: Date; active_at: Date | null; ended_at: Date | null; phase: string; end_reason: string | null }>(
        `SELECT s.id, s.customer_machine, s.customer_user, s.customer_os, s.created_at, s.active_at, s.ended_at,
                s.phase, s.end_reason
           FROM sessions s WHERE ${where.join(" AND ")}
          ORDER BY s.ended_at DESC NULLS LAST LIMIT 25`,
        params,
      ),
      query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sessions
          WHERE org_id = $1 AND agent_user_id = $2 AND status = 'ended' AND active_at IS NOT NULL AND ended_at >= $3`,
        [p.orgId, p.userId, new Date(since)],
      ),
    ]);

    res.json({
      counts: {
        active: count("CONNECTED", "CONTROLLING", "ON_HOLD"),
        waiting: count("CREATED", "WAITING", "CONSENT_PENDING"),
        reconnecting: count("RECONNECTING"),
        onHold: count("ON_HOLD"),
        completedToday: today.rows[0]?.n ?? 0,
      },
      live: live.length,
      maxSessions: effectiveSessionLimit(p),
      recent: recent.rows.map((r) => ({
        id: r.id,
        machine: r.customer_machine, user: r.customer_user, os: r.customer_os,
        createdAt: r.created_at, endedAt: r.ended_at,
        durationSeconds: r.active_at && r.ended_at ? Math.round((r.ended_at.getTime() - r.active_at.getTime()) / 1000) : null,
        phase: r.phase,
        endReason: r.end_reason, endReasonLabel: r.end_reason ? END_REASON_LABELS[r.end_reason] ?? r.end_reason : null,
      })),
      generatedAt: new Date(now),
    });
  }));

  /** The session must be one this technician ran; anything else is a 404. */
  async function ownSession(orgId: string, userId: string, id: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const { rows } = await query("SELECT 1 FROM sessions WHERE id = $1 AND org_id = $2 AND agent_user_id = $3", [id, orgId, userId]);
    return rows.length > 0;
  }

  router.get("/sessions/:id/notes", route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    if (!(await ownSession(p.orgId, p.userId, id))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { rows } = await query<{ body: string; created_at: Date }>(
      `SELECT body, created_at FROM session_notes WHERE org_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [p.orgId, id],
    );
    res.json({ body: rows[0]?.body ?? "", savedAt: rows[0]?.created_at ?? null });
  }));

  router.post("/sessions/:id/notes", perUserLimit(notesLimiter), route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== "string" || body.length > MAX_NOTES_LENGTH) {
      res.status(400).json({ error: "invalid_notes", max: MAX_NOTES_LENGTH });
      return;
    }
    if (!(await ownSession(p.orgId, p.userId, id))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { rows } = await query<{ created_at: Date }>(
      `INSERT INTO session_notes (id, org_id, session_id, author_user_id, body) VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
      [randomUUID(), p.orgId, id, p.userId, body],
    );
    await recordNotesEvent(p.orgId, id, p.userId, body.length);
    res.json({ ok: true, savedAt: rows[0]?.created_at ?? null });
  }));

  return router;
}
