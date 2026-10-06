/**
 * Durable session records — the bridge between the in-memory relay
 * (`sessions.ts`, `signaling.ts`) and PostgreSQL.
 *
 * Ordering: every write for a session goes through that session's own promise
 * chain, and timeline sequence numbers are assigned synchronously at the moment
 * the relay observes the event. So the stored timeline is in the order things
 * happened, even though inserts are asynchronous, and a chat message can never
 * be committed ahead of the event that preceded it.
 *
 * Failure handling, by sensitivity:
 *   * session creation, chat and script requests are STRICT — the caller awaits
 *     them and refuses the action if the write fails (nothing is confirmed that
 *     was not recorded);
 *   * everything else is best-effort — a failure never takes a live support
 *     session down, but it is counted, logged without content, and the session
 *     row is marked `record_complete = false` so the gap is visible in the UI and
 *     in every report generated from it.
 *
 * Content rules: no pairing code, no credential, no script body is ever passed
 * to this module. Chat text is passed only to saveChat(), which writes it to
 * `chat_messages` and nowhere else.
 */

import { randomUUID } from "node:crypto";

import { query } from "./db/pool.js";
import type { SessionPhase } from "./lifecycle.js";
import type { HostInfo } from "./protocol.js";
import type { Session } from "./sessions.js";

export type ActorRole = "agent" | "customer" | "system" | "admin";

export type EventType =
  | "session.created"
  | "customer.joined"
  | "consent.requested"
  | "consent.accepted"
  | "consent.declined"
  | "session.active"
  | "session.held"
  | "session.resumed"
  | "session.phase"
  | "screenshot.taken"
  | "file.transfer"
  | "fs.changed"
  | "clipboard.sent"
  | "clipboard.read"
  | "sysinfo.collected"
  | "script.cancelled"
  | "desktop.changed"
  | "elevation.requested"
  | "elevation.refused"
  | "elevation.result"
  | "script.requested"
  | "script.refused"
  | "script.result"
  | "sas.sent"
  | "url.shared"
  | "notes.saved"
  | "agent.disconnected"
  | "agent.reconnecting"
  | "agent.reconnected"
  | "agent.reconnect_expired"
  | "customer.disconnected"
  | "session.terminated"
  | "session.interrupted"
  | "session.ended";

/**
 * Why a session ended — stored in `sessions.end_reason`. Stable codes, so
 * history filters and reports do not depend on human wording.
 */
export type EndReason =
  | "agent_ended"
  | "customer_ended"
  | "customer_declined"
  | "agent_disconnected"
  | "customer_disconnected"
  | "code_expired"
  | "terminated_by_admin"
  | "agent_access_revoked"
  | "agent_session_expired"
  | "storage_unavailable"
  | "server_shutdown"
  | "server_restart";

/** Process-wide persistence health, shown on the admin dashboard. */
export const persistStats = {
  failures: 0,
  lastFailureAt: null as Date | null,
};

function enqueue<T>(s: Session, op: () => Promise<T>): Promise<T> {
  // Run after the previous write whether it succeeded or not.
  const run = s.writeChain.then(op, op);
  s.writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function noteFailure(s: Session, what: string, err: unknown): void {
  s.persistFailures += 1;
  persistStats.failures += 1;
  persistStats.lastFailureAt = new Date();
  // What failed, never the content that failed to be written.
  console.error(`[records] write failed for session ${s.id} (${what}):`, err instanceof Error ? err.message : err);
  // Best effort: flag the row now. If the database is down this fails too, and
  // the end-of-session update (or restart reconciliation) carries the flag.
  void enqueue(s, () =>
    query(
      `UPDATE sessions SET record_complete = false, persist_failures = persist_failures + 1
        WHERE id = $1 AND org_id = $2`,
      [s.id, s.orgId],
    ),
  ).catch(() => undefined);
}

function insertEvent(
  s: Session,
  seq: number,
  at: Date,
  type: EventType,
  actor: ActorRole,
  actorUserId: string | null,
  detail: Record<string, unknown>,
): Promise<unknown> {
  return query(
    `INSERT INTO session_events (session_id, seq, org_id, type, at, actor_role, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [s.id, seq, s.orgId, type, at, actor, actorUserId, JSON.stringify(detail)],
  );
}

/**
 * Best-effort row write in this session's ordered chain (Platform 2.0 features).
 * Never rejects; a failure marks the record incomplete like any other.
 */
export function recordWrite(s: Session, what: string, op: () => Promise<unknown>): void {
  void enqueue(s, op).catch((err: unknown) => noteFailure(s, what, err));
}

/** Best-effort timeline event. Never rejects. */
export function recordEvent(
  s: Session,
  type: EventType,
  actor: ActorRole,
  detail: Record<string, unknown> = {},
  actorUserId: string | null = null,
): Promise<boolean> {
  const seq = ++s.eventSeq;
  const at = new Date();
  return enqueue(s, () => insertEvent(s, seq, at, type, actor, actorUserId, detail)).then(
    () => true,
    (err: unknown) => {
      noteFailure(s, type, err);
      return false;
    },
  );
}

/** Timeline event the caller must not proceed without. Rejects on failure (and marks the record). */
export async function recordEventStrict(
  s: Session,
  type: EventType,
  actor: ActorRole,
  detail: Record<string, unknown> = {},
  actorUserId: string | null = null,
): Promise<void> {
  const seq = ++s.eventSeq;
  const at = new Date();
  try {
    await enqueue(s, () => insertEvent(s, seq, at, type, actor, actorUserId, detail));
  } catch (err) {
    noteFailure(s, type, err);
    throw err;
  }
}

/** Insert the session row and its first event. STRICT: no code is issued without it. */
export async function recordSessionCreated(s: Session, codeTtlMs: number, ip: string): Promise<void> {
  const seq = ++s.eventSeq;
  const created = new Date(s.createdAt);
  await enqueue(s, async () => {
    await query(
      `INSERT INTO sessions (id, org_id, agent_user_id, team_id, agent_display_name, agent_code, status, created_at, code_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'waiting_for_customer', $7, $8)`,
      [s.id, s.orgId, s.agentUserId, s.teamId, s.agentName, s.agentCode, created, new Date(s.createdAt + codeTtlMs)],
    );
    // The code itself is deliberately absent: it is a pairing secret, not data.
    await insertEvent(s, seq, created, "session.created", "agent", s.agentUserId, {
      codeIssued: true, codeTtlSeconds: Math.round(codeTtlMs / 1000), agentIp: ip,
    });
  });
}

export function recordCustomerJoined(s: Session, info: HostInfo, ip: string): void {
  const at = new Date();
  void enqueue(s, () =>
    query(
      `UPDATE sessions SET status = 'waiting_for_consent', customer_joined_at = $3,
              customer_machine = $4, customer_user = $5, customer_os = $6, customer_ip = $7
        WHERE id = $1 AND org_id = $2`,
      [s.id, s.orgId, at, info.machine.slice(0, 200), info.user.slice(0, 200), info.os.slice(0, 200), ip],
    ),
  ).catch((err: unknown) => noteFailure(s, "customer.joined row", err));
  void recordEvent(s, "customer.joined", "customer", { machine: info.machine, os: info.os });
  void recordEvent(s, "consent.requested", "system", { agentName: s.agentName });
}

export function recordConsent(s: Session, accepted: boolean): void {
  const at = new Date();
  void enqueue(s, () =>
    query(
      accepted
        ? `UPDATE sessions SET status = 'active', consent_decision = 'accepted', consent_decided_at = $3, active_at = $3
            WHERE id = $1 AND org_id = $2`
        : `UPDATE sessions SET consent_decision = 'declined', consent_decided_at = $3
            WHERE id = $1 AND org_id = $2`,
      [s.id, s.orgId, at],
    ),
  ).catch((err: unknown) => noteFailure(s, "consent row", err));
  void recordEvent(s, accepted ? "consent.accepted" : "consent.declined", "customer");
  if (accepted) void recordEvent(s, "session.active", "system");
}

/** Final event + row update. Returns when written (or failed), for graceful shutdown. */
export function recordEnded(
  s: Session,
  reason: EndReason,
  detail: Record<string, unknown> = {},
  actorUserId: string | null = null,
): Promise<void> {
  const actor: ActorRole =
    reason === "agent_ended" ? "agent"
      : reason === "customer_ended" || reason === "customer_declined" ? "customer"
        : reason === "terminated_by_admin" ? "admin"
          : "system";
  const events: Promise<boolean>[] = [];
  if (reason === "agent_disconnected") events.push(recordEvent(s, "agent.disconnected", "system"));
  if (reason === "customer_disconnected") events.push(recordEvent(s, "customer.disconnected", "system"));
  events.push(recordEvent(s, "session.ended", actor, { reason, ...detail }, actorUserId));

  const at = new Date();
  const row = enqueue(s, () =>
    query(
      `UPDATE sessions SET status = 'ended', end_reason = $3, ended_at = $4,
              record_complete = record_complete AND $5, persist_failures = GREATEST(persist_failures, $6)
        WHERE id = $1 AND org_id = $2`,
      [s.id, s.orgId, reason, at, s.persistFailures === 0, s.persistFailures],
    ),
  ).catch((err: unknown) => noteFailure(s, "session.ended row", err));
  return Promise.all([...events, row]).then(() => undefined);
}

/**
 * Lifecycle phase change (Platform 2.0). The timeline gets every validated
 * change with its timestamp; the row gets the visible phase. A change that
 * happened while the technician was reconnecting (`deferred`) moves only the
 * phase the session will return to, so it is on the timeline but not the row.
 */
export function recordPhase(
  s: Session,
  from: SessionPhase,
  to: SessionPhase,
  deferred: boolean,
  at: number,
  actor: ActorRole = "system",
  actorUserId: string | null = null,
): void {
  if (!deferred) {
    void enqueue(s, () =>
      query(`UPDATE sessions SET phase = $3, phase_changed_at = $4 WHERE id = $1 AND org_id = $2`,
        [s.id, s.orgId, to, new Date(at)]),
    ).catch((err: unknown) => noteFailure(s, "phase row", err));
  }
  void recordEvent(s, "session.phase", actor, deferred ? { from, to, deferred: true } : { from, to }, actorUserId);
}

/**
 * Multi-session: the technician socket dropped and the session entered its
 * reconnect grace. `reason` is a stable code chosen by the relay, never text
 * from a client.
 */
export function recordAgentDropped(s: Session, reason: string, graceMs: number): void {
  const at = new Date();
  void enqueue(s, () =>
    query(
      `UPDATE sessions SET last_disconnect_reason = $3, last_disconnect_at = $4 WHERE id = $1 AND org_id = $2`,
      [s.id, s.orgId, reason, at],
    ),
  ).catch((err: unknown) => noteFailure(s, "agent dropped row", err));
  void recordEvent(s, "agent.reconnecting", "system", { reason, graceSeconds: Math.round(graceMs / 1000) });
}

/** Multi-session: the owning technician resumed the session on a new socket. */
export function recordAgentResumed(s: Session, downtimeMs: number | null): void {
  void enqueue(s, () =>
    query(`UPDATE sessions SET reconnect_count = $3 WHERE id = $1 AND org_id = $2`, [s.id, s.orgId, s.reconnectCount]),
  ).catch((err: unknown) => noteFailure(s, "agent resumed row", err));
  void recordEvent(s, "agent.reconnected", "agent", { reconnectCount: s.reconnectCount, downtimeMs }, s.agentUserId);
}

/**
 * The stored transcript of one live session, as canonical `chat.message`s, for a
 * technician who just resumed it. Only ever called for the session's verified
 * owner (`signaling.ts handleAgentResume`).
 */
export async function loadChatForResume(s: Session): Promise<Array<{
  seq: number; senderRole: "agent" | "host"; kind: "text" | "url"; text: string | null; url: string | null;
  label: string | null; ts: number; clientId: string | null;
}>> {
  const { rows } = await query<{ seq: number; sender_role: "agent" | "customer"; kind: "text" | "url"; body: string | null;
    url: string | null; label: string | null; created_at: Date; client_msg_id: string | null }>(
    `SELECT seq, sender_role, kind, body, url, label, created_at, client_msg_id
       FROM chat_messages WHERE org_id = $1 AND session_id = $2 ORDER BY seq LIMIT 1000`,
    [s.orgId, s.id],
  );
  return rows.map((r) => ({
    seq: r.seq, senderRole: r.sender_role === "agent" ? "agent" : "host", kind: r.kind, text: r.body, url: r.url,
    label: r.label, ts: r.created_at.getTime(), clientId: r.client_msg_id,
  }));
}

export interface SavedChat {
  seq: number;
  createdAt: Date;
  duplicate: boolean;
  kind: "text" | "url";
  text: string | null;
  url: string | null;
  label: string | null;
}

/**
 * Persist one chat message BEFORE anyone is told it was sent. A retry with the
 * same client message id from the same side returns the stored row with
 * `duplicate: true` instead of creating a second transcript entry.
 */
export function saveChat(
  s: Session,
  sender: "agent" | "customer",
  senderUserId: string | null,
  msg: { kind: "text" | "url"; text?: string; url?: string; label?: string; clientId: string },
): Promise<SavedChat> {
  const clientId = msg.clientId === "" ? null : msg.clientId.slice(0, 100);
  return enqueue(s, async () => {
    const seq = s.chatSeq + 1;
    const inserted = await query<{ created_at: Date }>(
      `INSERT INTO chat_messages (id, org_id, session_id, seq, sender_role, sender_user_id, kind, body, url, label, client_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (session_id, sender_role, client_msg_id) DO NOTHING
       RETURNING created_at`,
      [randomUUID(), s.orgId, s.id, seq, sender, senderUserId, msg.kind, msg.text ?? null, msg.url ?? null,
        msg.label ?? null, clientId],
    );
    const row = inserted.rows[0];
    if (row) {
      s.chatSeq = seq;
      return { seq, createdAt: row.created_at, duplicate: false, kind: msg.kind,
        text: msg.text ?? null, url: msg.url ?? null, label: msg.label ?? null };
    }
    const existing = await query<{ seq: number; created_at: Date; kind: "text" | "url"; body: string | null; url: string | null; label: string | null }>(
      `SELECT seq, created_at, kind, body, url, label FROM chat_messages
        WHERE session_id = $1 AND sender_role = $2 AND client_msg_id = $3`,
      [s.id, sender, clientId],
    );
    const prior = existing.rows[0];
    if (!prior) throw new Error("chat insert conflicted but no prior row found");
    return { seq: prior.seq, createdAt: prior.created_at, duplicate: true, kind: prior.kind,
      text: prior.body, url: prior.url, label: prior.label };
  }).catch((err: unknown) => {
    noteFailure(s, "chat", err);
    throw err;
  });
}

/**
 * At startup, before accepting connections: any session the database still
 * shows as live belonged to a previous process whose sockets are gone. End it
 * as `server_restart` and put a server-side event on its timeline.
 *
 * Assumes a single relay instance per database (docs/ADMIN_PORTAL.md).
 */
export async function reconcileInterrupted(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `WITH open AS (
       UPDATE sessions SET status = 'ended', end_reason = 'server_restart', ended_at = now(),
                          phase = 'ENDED', phase_changed_at = now()
        WHERE status <> 'ended'
        RETURNING id, org_id, status
     ), ev AS (
       INSERT INTO session_events (session_id, seq, org_id, type, at, actor_role, detail)
       SELECT o.id,
              COALESCE((SELECT max(seq) FROM session_events e WHERE e.session_id = o.id), 0) + 1,
              o.org_id, 'session.interrupted', now(), 'system',
              '{"reason":"server_restart","note":"The relay restarted while this session was open; live connections were lost."}'::jsonb
         FROM open o
       RETURNING 1
     )
     SELECT count(*) AS n FROM ev`,
  );
  return rows[0]?.n ?? 0;
}
