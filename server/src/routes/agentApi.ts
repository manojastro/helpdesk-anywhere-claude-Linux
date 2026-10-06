/**
 * Agent-console API — mounted ONLY on the agent application, under /api/agent.
 *
 *   GET  /api/agent/me                     who am I (verified identity, limits, CSRF token)
 *   POST /api/agent/presence               console heartbeat ("agents online")
 *   GET  /api/agent/sessions/live          my live sessions and my concurrent-session limit
 *   GET  /api/agent/dashboard              my queue counts, completed today, recent history (search/filter)
 *   GET  /api/agent/scripts                the saved script library (built-in + organisation)
 *   GET  /api/agent/sessions/:id/events    the activity timeline of a session I ran
 *   POST /api/agent/sessions/:id/screenshot  record that I captured a screenshot (the image is never uploaded)
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
import { audit } from "../audit.js";
import { MAX_NOTES_LENGTH } from "../protocol.js";
import { recordEvent, type EventType } from "../records.js";
import { listScripts } from "../scriptLibrary.js";
import { PHASES, type SessionPhase } from "../lifecycle.js";
import { END_REASON_LABELS, EVENT_TITLES, loadTimeline, safeDetail } from "../reports.js";
import { UUID_RE, likeEscape } from "../sessionQueries.js";
import { RateLimiter, sessions } from "../sessions.js";
import { effectiveSessionLimit, liveSessions, onlineTechnicians } from "../signaling.js";
import { me, perUserLimit, route } from "./common.js";
import { randomUUID } from "node:crypto";

const notesLimiter = new RateLimiter(60, 60_000);
const screenshotLimiter = new RateLimiter(30, 60_000);

/**
 * Timeline entry from the console API, whether or not the session is still live:
 * through the live session's ordered write chain if it is, appended otherwise.
 */
async function recordConsoleEvent(orgId: string, sessionId: string, userId: string, type: EventType, detail: Record<string, unknown>): Promise<void> {
  const live = sessions.byId(sessionId);
  if (live && live.orgId === orgId) {
    await recordEvent(live, type, "agent", detail, userId);
    return;
  }
  await query(
    `INSERT INTO session_events (session_id, seq, org_id, type, at, actor_role, actor_user_id, detail)
     SELECT $1, COALESCE(max(seq), 0) + 1, $2, $5, now(), 'agent', $3, $4
       FROM session_events WHERE session_id = $1`,
    [sessionId, orgId, userId, JSON.stringify(detail), type],
  );
}

/** Timeline entry for a notes save, whether or not the session is still live. */
export async function recordNotesEvent(orgId: string, sessionId: string, userId: string, length: number): Promise<void> {
  await recordConsoleEvent(orgId, sessionId, userId, "notes.saved", { length });
}

/**
 * Timeline types the technician's Activity view leaves out: lifecycle bookkeeping
 * that the human-readable events already describe.
 */
const ACTIVITY_HIDDEN = new Set(["session.phase"]);

/** SQL: a session this technician ($2) handed over to someone else (Phase 5), in org $1. */
const HANDED_OVER_BY_ME = `s.id IN (SELECT t.session_id FROM session_transfers t
  WHERE t.org_id = $1 AND t.from_user_id = $2 AND t.status = 'completed')`;

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
      // Platform 2.0 feature flags, so the console hides what the server refuses.
      features: {
        fileManager: config.enableFileManager,
        sessionTransfer: config.enableSessionTransfer,
        customerReconnect: config.enableCustomerReconnect,
        scriptLibrary: config.enableScriptLibrary,
      },
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
    // Own sessions, plus ones this technician handed over to a colleague (Phase 5).
    const where = ["s.org_id = $1", `(s.agent_user_id = $2 OR ${HANDED_OVER_BY_ME})`, "s.status = 'ended'"];
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
        created_at: Date; active_at: Date | null; ended_at: Date | null; phase: string; end_reason: string | null; transferred_to: string | null }>(
        `SELECT s.id, s.customer_machine, s.customer_user, s.customer_os, s.created_at, s.active_at, s.ended_at,
                s.phase, s.end_reason,
                (SELECT t.to_name FROM session_transfers t WHERE t.org_id = s.org_id AND t.session_id = s.id
                   AND t.from_user_id = $2 AND t.status = 'completed' ORDER BY t.created_at DESC LIMIT 1) AS transferred_to
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
        transferredTo: r.transferred_to,
      })),
      generatedAt: new Date(now),
    });
  }));

  /**
   * The saved script library. Every technician who may use the console can SEE
   * it; running a script still needs `allowScripts`, enforced by the relay.
   */
  router.get("/scripts", route(async (req, res) => {
    const p = me(req);
    if (!config.enableScriptLibrary) {
      res.json({ items: [], canRun: p.limits.allowScripts, disabled: true });
      return;
    }
    const items = await listScripts(p.orgId);
    res.json({
      items: items.map(({ archived: _a, ...s }) => s),
      canRun: p.limits.allowScripts,
    });
  }));

  /**
   * Platform 2.0 Phase 5: who this technician could hand a session to right now —
   * colleagues in the same organisation who are signed in to the console, with
   * their free slots. Names and slots only.
   */
  router.get("/technicians/available", route(async (req, res) => {
    const p = me(req);
    if (!config.enableSessionTransfer) {
      res.json({ items: [], disabled: true });
      return;
    }
    res.json({
      items: onlineTechnicians(p.orgId).filter((t) => t.userId !== p.userId).map((t) => ({
        userId: t.userId, displayName: t.displayName, agentCode: t.agentCode, live: t.live, maxSessions: t.maxSessions,
        available: t.live < t.maxSessions,
      })),
    });
  }));

  /**
   * The session must be one this technician runs or ran; anything else is a 404.
   * `currentOnly` (writes): the current owner only — a technician who handed a
   * session over can still READ its record, not change it.
   */
  async function ownSession(orgId: string, userId: string, id: string, currentOnly = false): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const { rows } = await query(
      `SELECT 1 FROM sessions s WHERE s.id = $1 AND s.org_id = $2
          AND (s.agent_user_id = $3 ${currentOnly ? "" : `OR EXISTS (SELECT 1 FROM session_transfers t WHERE t.org_id = s.org_id
                 AND t.session_id = s.id AND t.from_user_id = $3 AND t.status = 'completed')`})`,
      [id, orgId, userId]);
    return rows.length > 0;
  }

  /** Activity timeline: the server-recorded events of one of MY sessions, readable titles, safe detail only. */
  router.get("/sessions/:id/events", route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    if (!(await ownSession(p.orgId, p.userId, id))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rows = await loadTimeline(p.orgId, id);
    res.json({
      items: rows.filter((e) => !ACTIVITY_HIDDEN.has(e.type)).map((e) => ({
        seq: e.seq, type: e.type, title: EVENT_TITLES[e.type] ?? e.type, at: e.at, actor: e.actor_role,
        actorName: e.actor_name, detail: safeDetail(e.detail),
      })),
    });
  }));

  /**
   * A screenshot was captured in the console. The image itself stays in the
   * technician's browser (downloaded locally, never uploaded or stored by the
   * server); only the fact goes on the session record and the security log.
   */
  router.post("/sessions/:id/screenshot", perUserLimit(screenshotLimiter), route(async (req, res) => {
    const p = me(req);
    const id = String(req.params["id"]);
    if (!(await ownSession(p.orgId, p.userId, id))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await recordConsoleEvent(p.orgId, id, p.userId, "screenshot.taken", {});
    void audit("screenshot.taken", id, { user: p.userId });
    res.json({ ok: true });
  }));

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
    if (!(await ownSession(p.orgId, p.userId, id, true))) {
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
