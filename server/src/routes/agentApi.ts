/**
 * Agent-console API — mounted ONLY on the agent application, under /api/agent.
 *
 *   GET  /api/agent/me                     who am I (verified identity, limits, CSRF token)
 *   POST /api/agent/presence               console heartbeat ("agents online")
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
import { UUID_RE } from "../sessionQueries.js";
import { RateLimiter, sessions } from "../sessions.js";
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
