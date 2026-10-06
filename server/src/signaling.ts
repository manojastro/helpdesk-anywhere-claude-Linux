/**
 * WebSocket signaling and stream relay (PLAN 1.3).
 *
 * Pure pass-through: relays control JSON and binary frames between the two
 * paired sockets. The server never decodes video and never inspects a credential
 * beyond the transport check and the audit redaction.
 *
 * Rules that carry the security weight here:
 *   - Nothing is relayed before `state === "active"`, so no frame can reach the
 *     agent before the user has consented (CLAUDE.md constraint #1).
 *   - Credential-mode elevation is refused outright on a non-secure transport
 *     and is forwarded verbatim, never re-serialised, buffered or logged
 *     (CLAUDE.md constraint #6, `shared/protocol.md` "Credential handling").
 *   - A technician socket is bound at upgrade to the server-side identity from
 *     the session cookie (admin portal). A browser upgrade without one is
 *     refused; a socket without a browser Origin (the applet) is anonymous and
 *     can only ever be a host. Every privileged agent message re-checks that
 *     identity, its limits, and that it has not been revoked.
 *   - The name the customer's consent dialog shows is the verified Entra
 *     display name, never anything a browser sent.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { audit } from "./audit.js";
import { can, type Principal } from "./auth/permissions.js";
import { principalFromRequest } from "./auth/sessions.js";
import { config } from "./config.js";
import {
  resume as resumeLifecycle,
  terminalPhaseFor,
  transition,
  type SessionPhase,
} from "./lifecycle.js";
import { clientIp, isSecure, originMatches } from "./netinfo.js";
import { verifyLibraryRun } from "./scriptLibrary.js";
import {
  AGENT_FEATURES,
  cancelAllTransfers,
  handleAgentFeature,
  handleHostFeature,
  parseCapabilities,
  type FeatureIo,
} from "./features.js";
import {
  loadChatForResume,
  recordAgentDropped,
  recordAgentResumed,
  recordConsent,
  recordCustomerJoined,
  recordEnded,
  recordEvent,
  recordEventStrict,
  recordHostResumed,
  recordPhase,
  recordSessionCreated,
  type ActorRole,
  saveChat,
  type EndReason,
} from "./records.js";
import {
  FRAME_FULL,
  isCredentialElevation,
  isRemoteAction,
  isValidHttpUrl,
  urlDomain,
  MAX_CHAT_LABEL_LENGTH,
  MAX_CHAT_TEXT_LENGTH,
  MAX_NOTES_LENGTH,
  type AnyMessage,
  type ChatKind,
  type ChatMessage,
  type ErrorCode,
  type HostInfo,
  type Role,
  type ServerMessage,
} from "./protocol.js";
import {
  SessionCapacityError,
  VIDEO_HIGH_WATER_BYTES,
  catchUpFrames,
  noteFrame,
  sessions,
  type Session,
} from "./sessions.js";

/** PLAN 1.3: ping every 20s, drop peers that never pong back. */
const HEARTBEAT_MS = 20_000;

/** Platform 2.0: how often the relay measures each leg's round trip and reports health. */
const HEALTH_MS = 5_000;

/** PLAN 1.2: sweep expired and ended sessions on a 60s timer. */
const SWEEP_MS = 60_000;

/** Refuse absurd control frames outright; video goes over binary frames. */
const MAX_CONTROL_BYTES = 256 * 1024;

interface Conn {
  ws: WebSocket;
  ip: string;
  /** Whether the original client connection was TLS-protected. */
  secure: boolean;
  /**
   * The technician identity bound at upgrade from the session cookie, or null
   * for an anonymous socket (the applet). Refreshed in place when an admin
   * changes the user's limits; set to null — and the socket closed — when access
   * is revoked. Only `agent.*` messages ever consult it.
   */
  principal: Principal | null;

  /** Null until the socket declares itself with `agent.create` / `host.join`. */
  role: Role | null;
  code: string | null;
  alive: boolean;
}

const conns = new Map<WebSocket, Conn>();

/** Principals resolved in verifyClient, handed to the connection handler. */
const upgradePrincipals = new WeakMap<IncomingMessage, Principal>();

/* ----------------------------------------------------------------- connection info */

/** Wire size of a control frame. `RawData` is a Buffer, an ArrayBuffer or a list of Buffers. */
function controlByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n, part) => n + part.length, 0);
  return (data as ArrayBuffer).byteLength;
}

/** A binary frame as one Buffer, without copying in the common single-Buffer case. */
function frameBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/* ------------------------------------------------------------------- origin policy */

/**
 * Reject a browser socket opened from a *different* site (cross-site WebSocket
 * hijacking).
 *
 * The applet is not a browser and sends no `Origin` at all, so a missing Origin
 * must stay allowed — Origin is a header browsers impose on their own pages, not
 * a credential, and demanding one would only break every non-browser client.
 * What it does buy: the technician's session cookie is what makes `agent.create`
 * work, and this stops another site from borrowing it in the agent's browser.
 * SameSite=lax already blocks that in current browsers; this does not depend on
 * the browser getting it right.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;  // not a browser
  return originMatches(origin, host);
}

/* --------------------------------------------------------------------- send helpers */

function send(ws: WebSocket | null, msg: ServerMessage): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket | null, code: ErrorCode, message: string, clientId?: string): void {
  send(ws, clientId === undefined ? { t: "error", code, message } : { t: "error", code, message, clientId });
}

/** Relay-originated JSON that is not a ServerMessage (Platform 2.0 feature control). */
function sendJson(ws: WebSocket | null, msg: Record<string, unknown>): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** The relay's side of a Platform 2.0 feature message: forwarding, and nothing else. */
function featureIo(session: Session, principal: Principal | null, data: RawData | null): FeatureIo {
  return {
    session,
    principal,
    forwardToHost: () => { if (data !== null) forward(session.hostWs, data, false); },
    forwardToAgent: () => { if (data !== null) forward(session.agentWs, data, false); },
    toAgent: (m) => sendJson(session.agentWs, m),
    toHost: (m) => sendJson(session.hostWs, m),
  };
}

/** Forward a frame verbatim — never re-serialised, so nothing is buffered or logged. */
function forward(ws: WebSocket | null, data: RawData, isBinary: boolean): void {
  if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
}

/* ------------------------------------------------------------------------- lifecycle */

/**
 * The one way a session's lifecycle phase changes (Platform 2.0). Validates
 * against `lifecycle.ts`, records the change with its timestamp, and tells the
 * owning console. An invalid transition changes nothing: it can only be a relay
 * bug (no client message names a phase), so it is logged and audited, never
 * thrown into a live session.
 */
function setPhase(
  session: Session,
  to: SessionPhase,
  opts: { actor?: ActorRole; actorUserId?: string | null; notify?: boolean } = {},
): boolean {
  const r = transition(session.lifecycle, to);
  if (!r.ok) {
    if (r.reason === "invalid") {
      console.error(`[lifecycle] refused ${r.from} -> ${r.to} for session ${session.id}`);
      void audit("session.invalid_transition", session.id, { from: r.from, to: r.to });
    }
    return false;
  }
  recordPhase(session, r.from, r.to, r.deferred, session.lifecycle.phaseSince, opts.actor ?? "system", opts.actorUserId ?? null);
  if (!r.deferred && opts.notify !== false) {
    send(session.agentWs, { t: "session.phase", phase: session.lifecycle.phase, since: session.lifecycle.phaseSince });
  }
  return true;
}

/* -------------------------------------------------------------------------- teardown */

/** The JSONL wording kept from before the admin portal, per stable end-reason code. */
const END_REASON_TEXT: Record<EndReason, string> = {
  agent_ended: "agent ended session",
  customer_ended: "user ended the session",
  customer_declined: "user declined consent",
  agent_disconnected: "agent disconnected",
  customer_disconnected: "host disconnected",
  code_expired: "code expired unused",
  terminated_by_admin: "terminated by administrator",
  agent_access_revoked: "agent access revoked",
  agent_session_expired: "agent sign-in expired",
  storage_unavailable: "session record could not be written",
  server_shutdown: "server shutting down",
  server_restart: "server restarted",
};

/**
 * End a session once: notify the surviving peer, close both sockets, audit, and
 * write the end of the durable record. Idempotent — the store returns undefined
 * for a session already torn down, so the close handlers that fire as a result
 * cannot recurse. Returns the record write, for graceful shutdown to await.
 */
function teardown(
  code: string,
  reason: EndReason,
  departed: Role | null,
  actorUserId: string | null = null,
): Promise<void> {
  const session = sessions.end(code);
  if (!session) return Promise.resolve();
  // Nothing in flight outlives the session (recorded as cancelled).
  cancelAllTransfers(featureIo(session, null, null), "session ended");

  const peers: Array<[WebSocket | null, Role]> = [
    [session.agentWs, "agent"],
    [session.hostWs, "host"],
  ];

  for (const [ws, role] of peers) {
    if (ws === null) continue;
    const conn = conns.get(ws);
    if (conn) conn.code = null;
    if (departed !== null && role !== departed) send(ws, { t: "peer.left", role: departed });
  }
  // After every message that existed before Platform 2.0 (clients read them in
  // order), and before the sockets close, so the console hears the final phase.
  setPhase(session, terminalPhaseFor(reason), { actorUserId });
  for (const [ws] of peers) {
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.close(1000, "session ended");
  }

  const durationMs = session.consentedAt === null ? null : Date.now() - session.consentedAt;
  void audit("session.ended", session.id, {
    reason: END_REASON_TEXT[reason],
    endReason: reason,
    machine: session.hostInfo?.machine ?? null,
    durationMs,
  });
  return recordEnded(session, reason, { durationMs }, actorUserId);
}

/* ------------------------------------------------------------------- role handshake */

/**
 * Why an agent socket may not act right now, or null if it may.
 *
 * `console.use` is part of the check (audit 2026-10-05, F-03): an administrator
 * clearing "can use console" leaves the user `active`, and before this the
 * already-open socket kept driving the customer's machine until it closed.
 */
function agentBlocked(conn: Conn): "revoked" | "expired" | null {
  const p = conn.principal;
  if (p === null || p.status !== "active" || !can(p, "console.use")) return "revoked";
  if (p.sessionExpiresAt.getTime() <= Date.now()) return "expired";
  return null;
}

async function handleAgentCreate(conn: Conn): Promise<void> {
  const p = conn.principal;
  // Protecting only the console *page* would be half a lock: the socket is what
  // actually creates sessions, and a session code is what a tech-support
  // scammer needs (CLAUDE.md 7.5). The identity, its role, its local status and
  // its limits are all checked HERE, on the server, for the socket.
  if (p === null || agentBlocked(conn) !== null || !can(p, "console.use")) {
    sendError(conn.ws, "unauthorized", "Sign in with an account that is allowed to run support sessions.");
    void audit("join.rejected", null, {
      ip: conn.ip, reason: p === null ? "console_unauthenticated" : "console_not_permitted",
      user: p?.userId ?? null,
    });
    conn.ws.close(1008, "not authorised");
    return;
  }

  // A create costs a code and a database row, so it is rate-limited exactly as
  // a join is (security review, 2026-09-03).
  if (!sessions.createLimiter.allow(conn.ip)) {
    sendError(conn.ws, "rate_limited", "Too many sessions created. Wait a minute and try again.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "create_rate_limited", user: p.userId });
    return;
  }

  // Multi-session limit. Count and create run in this same synchronous turn —
  // no await between them — so concurrent creates cannot overshoot it (see
  // SessionStore.countForUser). Nothing is ended to make room: the technician
  // must disconnect a session themselves.
  const maxSessions = effectiveSessionLimit(p);
  const activeSessions = sessions.countForUser(p.userId);
  if (activeSessions >= maxSessions) {
    send(conn.ws, {
      t: "error",
      code: "session_limit",
      message: `Maximum concurrent session limit reached. You can manage up to ${maxSessions} active session${maxSessions === 1 ? "" : "s"}. Disconnect an existing session before starting another.`,
      maxSessions,
      activeSessions,
    });
    void audit("join.rejected", null, { ip: conn.ip, reason: "session_limit", user: p.userId, maxSessions, activeSessions });
    return;
  }

  let session: Session;
  try {
    session = sessions.create(conn.ws, {
      orgId: p.orgId, userId: p.userId, teamId: p.teamId, displayName: p.displayName, agentCode: p.agentCode,
    });
  } catch (err) {
    if (!(err instanceof SessionCapacityError)) throw err;
    sendError(conn.ws, "rate_limited", "The server is at capacity. Try again shortly.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "at_capacity" });
    return;
  }

  // Claim the socket before the await, so a second message cannot start a
  // second create while the first is being recorded.
  conn.role = "agent";
  conn.code = session.code;

  try {
    // STRICT: no code is handed out for a session that has no record.
    await recordSessionCreated(session, config.sessionCodeTtlMs, conn.ip);
  } catch {
    sessions.end(session.code);
    conn.code = null;
    sendError(conn.ws, "storage_unavailable", "The session could not be recorded. Try again shortly.");
    conn.ws.close(1011, "storage unavailable");
    return;
  }

  // The agent may have hung up during the insert; teardown already ran then.
  if (sessions.get(session.code) !== session) return;

  // Not notified separately: `session.created` below carries the phase.
  setPhase(session, "WAITING", { actor: "agent", actorUserId: p.userId, notify: false });
  send(conn.ws, {
    t: "session.created",
    code: session.code,
    sessionId: session.id,
    resumeToken: sessions.issueResumeToken(session),
    expiresAt: session.createdAt + config.sessionCodeTtlMs,
    expiresInMs: Math.max(0, session.createdAt + config.sessionCodeTtlMs - Date.now()),
    phase: session.lifecycle.phase,
  });
  void audit("session.created", session.id, { ip: conn.ip, user: p.userId });
}

/** min(account limit, server ceiling) — the one definition of "how many sessions may this technician hold". */
export function effectiveSessionLimit(p: Pick<Principal, "limits">): number {
  return Math.max(1, Math.min(p.limits.maxConcurrentSessions, config.maxConcurrentSessionsPerAgent));
}

/**
 * `agent.resume` — pick a live session back up on this new socket (multi-session
 * technician reconnect). Three independent proofs, all required:
 *   1. the socket carries a valid, active technician sign-in (checked at
 *      upgrade, re-checked here like agent.create);
 *   2. that technician OWNS the session (same org, same user) — a session id is
 *      not a secret and grants nothing on its own;
 *   3. the socket presents the session's CURRENT resume token (constant-time,
 *      hashed server-side, rotated on every resume).
 * Every refusal is the same `resume_failed`, so a probe learns nothing about
 * whether the session exists or whose it is.
 */
async function handleAgentResume(conn: Conn, msg: AnyMessage): Promise<void> {
  if (msg.t !== "agent.resume") return;
  const p = conn.principal;
  if (p === null || agentBlocked(conn) !== null || !can(p, "console.use")) {
    sendError(conn.ws, "unauthorized", "Sign in with an account that is allowed to run support sessions.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "resume_unauthorized", user: p?.userId ?? null });
    conn.ws.close(1008, "not authorised");
    return;
  }
  // Keyed by technician, not IP: a helpdesk office behind one NAT address can
  // have many technicians reconnecting at once after the same network blip, and
  // one of them must not use up the others' resumes.
  if (!sessions.resumeLimiter.allow(p.userId)) {
    sendError(conn.ws, "rate_limited", "Too many reconnect attempts. Wait a minute and try again.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "resume_rate_limited", user: p.userId });
    // 4429, not 1008: a limited resume means "not yet", and the console retries
    // it. 1008 is final there and would abandon a session that is still live.
    conn.ws.close(4429, "rate limited");
    return;
  }

  const session = typeof msg.sessionId === "string" ? sessions.byId(msg.sessionId) : undefined;
  const owned = session !== undefined && session.orgId === p.orgId && session.agentUserId === p.userId;
  if (!session || !owned || !sessions.resumeTokenMatches(session, msg.resumeToken)) {
    sendError(conn.ws, "resume_failed", "This session can no longer be resumed.");
    void audit("join.rejected", null, {
      ip: conn.ip, reason: "resume_failed", user: p.userId,
      // Which check failed is for the security log only, never the client.
      detail: !session ? "unknown_session" : !owned ? "not_owner" : "bad_token",
    });
    conn.ws.close(1000, "resume failed");
    return;
  }

  // The old socket may still look open (a half-dead TCP connection the
  // heartbeat has not reaped yet, or a second tab). The verified owner wins;
  // the old socket is detached FIRST so its close cannot start a grace period.
  const previous = session.agentWs;
  if (previous !== null && previous !== conn.ws) {
    const prevConn = conns.get(previous);
    if (prevConn) prevConn.code = null;
    sendError(previous, "resume_failed", "This session was reopened in another window.");
    if (previous.readyState === WebSocket.OPEN) previous.close(4409, "session resumed elsewhere");
  }

  const downtimeMs = session.reconnect !== null ? Date.now() - session.reconnect.since : null;
  sessions.clearReconnect(session);
  // A takeover from a still-open socket was never RECONNECTING; resume() is then a no-op.
  const back = resumeLifecycle(session.lifecycle);
  if (back.ok) recordPhase(session, back.from, back.to, false, session.lifecycle.phaseSince, "agent", p.userId);
  session.agentWs = conn.ws;
  session.viewPriority = "full";
  session.reconnectCount += 1;
  conn.role = "agent";
  conn.code = session.code;

  send(conn.ws, {
    t: "session.resumed",
    sessionId: session.id,
    resumeToken: sessions.issueResumeToken(session),
    state: session.state,
    ...(session.state === "waiting_for_host" ? { code: session.code } : {}),
    host: session.hostInfo,
    held: session.held,
    elevated: session.elevated,
    desktop: session.desktop,
    createdAt: session.createdAt,
    consentedAt: session.consentedAt,
    reconnectCount: session.reconnectCount,
    capabilities: [...session.hostCaps],
    phase: session.lifecycle.phase,
    phaseSince: session.lifecycle.phaseSince,
    ...(session.state === "waiting_for_host" ? {
      expiresAt: session.createdAt + config.sessionCodeTtlMs,
      expiresInMs: Math.max(0, session.createdAt + config.sessionCodeTtlMs - Date.now()),
    } : {}),
  });
  // Rebuild the picture before live frames resume: keyframe, then every rect since.
  session.videoBehind = false;
  session.agentRttMs = null;  // a new socket: its leg is measured afresh
  if (session.state === "active") measureLegs(session);
  if (session.state === "active") {
    for (const frame of catchUpFrames(session)) forward(conn.ws, frame, true);
  }

  void audit("session.agent_resumed", session.id, { ip: conn.ip, user: p.userId, reconnectCount: session.reconnectCount, downtimeMs });
  recordAgentResumed(session, downtimeMs);

  try {
    const history = await loadChatForResume(session);
    if (session.agentWs !== conn.ws) return;
    send(conn.ws, {
      t: "chat.history",
      messages: history.map((m) => ({
        t: "chat.message" as const,
        id: `${session.id}.${m.seq}`,
        senderRole: m.senderRole,
        kind: m.kind,
        ts: m.ts,
        ...(m.text !== null ? { text: m.text } : {}),
        ...(m.url !== null ? { url: m.url } : {}),
        ...(m.label !== null ? { label: m.label } : {}),
        ...(m.clientId !== null ? { clientId: m.clientId } : {}),
      })),
    });
  } catch (err) {
    // The session itself is fine; only the replay of earlier chat is missing.
    console.error(`[ws] chat history for resumed session ${session.id} failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * The technician socket of a live session closed without `agent.end`. Keep the
 * session — and its slot — for the reconnect grace instead of ending it: the
 * customer is unaffected, nothing can be sent to their machine while no
 * technician is attached, and the frames that arrive meanwhile only update the
 * catch-up buffer. When the grace runs out the session ends exactly as a
 * disconnect always did.
 */
function beginAgentGrace(session: Session, reason: string): void {
  const graceMs = config.agentReconnectGraceMs;
  session.agentWs = null;
  sessions.clearReconnect(session);
  const timer = setTimeout(() => {
    if (sessions.get(session.code) !== session || session.reconnect === null) return;
    void recordEvent(session, "agent.reconnect_expired", "system", { graceSeconds: Math.round(graceMs / 1000) });
    void teardown(session.code, "agent_disconnected", "agent");
  }, graceMs);
  timer.unref();
  session.reconnect = { since: Date.now(), timer };
  setPhase(session, "RECONNECTING");
  cancelAllTransfers(featureIo(session, null, null), "technician disconnected");
  void audit("session.agent_reconnecting", session.id, { reason, graceMs });
  recordAgentDropped(session, reason, graceMs);
}

/**
 * Platform 2.0 Phase 3. The customer's socket closed without the applet's End
 * Session: keep the session (and the technician's view of it) for
 * HOST_RECONNECT_GRACE_MS. Nothing can reach the customer's machine meanwhile
 * (there is no socket to reach it on); the applet's own indicator stays up and
 * says it is reconnecting. Transfers in flight cannot survive and are cancelled.
 */
function beginHostGrace(session: Session, reason: string): void {
  const graceMs = config.hostReconnectGraceMs;
  session.hostWs = null;
  sessions.clearHostReconnect(session);
  const timer = setTimeout(() => {
    if (sessions.get(session.code) !== session || session.hostReconnect === null) return;
    void recordEvent(session, "customer.reconnect_expired", "system", { graceSeconds: Math.round(graceMs / 1000) });
    void teardown(session.code, "customer_disconnected", "host");
  }, graceMs);
  timer.unref();
  session.hostReconnect = { since: Date.now(), timer };
  cancelAllTransfers(featureIo(session, null, null), "customer disconnected");
  setPhase(session, "DISCONNECTED");
  void audit("session.host_reconnecting", session.id, { reason, graceMs });
  void recordEvent(session, "customer.reconnecting", "system", { reason, graceSeconds: Math.round(graceMs / 1000) });
}

/**
 * Platform 2.0 Phase 3: `host.resume {sessionId, resumeToken}` — the customer's
 * applet picking its own session back up on a new socket. The token is the
 * proof: 256 bits, issued only to the applet at consent, stored hashed, compared
 * in constant time, rotated on every use. A session id alone grants nothing and
 * every refusal looks the same. Consent is not asked again: the applet process,
 * its indicator and its End Session button never went away.
 */
function handleHostResume(conn: Conn, msg: Record<string, unknown>): void {
  if (!sessions.hostResumeLimiter.allow(conn.ip)) {
    sendError(conn.ws, "rate_limited", "Too many reconnect attempts. Wait a minute and try again.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "host_resume_rate_limited" });
    conn.ws.close(4429, "rate limited");
    return;
  }
  const session = typeof msg["sessionId"] === "string" ? sessions.byId(msg["sessionId"]) : undefined;
  if (!session || session.state !== "active" || !sessions.hostResumeTokenMatches(session, msg["resumeToken"])) {
    sendError(conn.ws, "resume_failed", "This session can no longer be resumed.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "host_resume_failed",
      detail: !session ? "unknown_session" : session.state !== "active" ? "not_active" : "bad_token" });
    conn.ws.close(1000, "resume failed");
    return;
  }

  // The old socket may not have been noticed as dead yet: the token holder wins.
  const previous = session.hostWs;
  if (previous !== null && previous !== conn.ws) {
    const prevConn = conns.get(previous);
    if (prevConn) prevConn.code = null;
    if (previous.readyState === WebSocket.OPEN) previous.close(4409, "session resumed elsewhere");
    cancelAllTransfers(featureIo(session, null, null), "customer reconnected");
  }

  const downtimeMs = session.hostReconnect !== null ? Date.now() - session.hostReconnect.since : null;
  sessions.clearHostReconnect(session);
  session.hostWs = conn.ws;
  session.hostRttMs = null;
  session.hostReconnectCount += 1;
  conn.role = "host";
  conn.code = session.code;

  sendJson(conn.ws, { t: "host.resumed", resumeToken: sessions.issueHostResumeToken(session), held: session.held });
  if (session.lifecycle.phase === "DISCONNECTED" || session.lifecycle.resumePhase === "DISCONNECTED") {
    setPhase(session, session.held ? "ON_HOLD" : "CONNECTED", { actor: "customer" });
  }
  measureLegs(session);
  void audit("session.host_resumed", session.id, { ip: conn.ip, reconnectCount: session.hostReconnectCount, downtimeMs });
  recordHostResumed(session, downtimeMs);
}

/** Longest machine / user / OS string accepted from `host.join`. */
export const MAX_HOST_FIELD_LENGTH = 200;

/** A `host.join` field as bounded, control-character-free text. */
function hostField(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, MAX_HOST_FIELD_LENGTH);
}

function handleHostJoin(conn: Conn, msg: AnyMessage): void {
  if (msg.t !== "host.join") return;

  const code = typeof msg.code === "string" ? msg.code : "";
  // Self-reported by an unauthenticated client, so bounded before it reaches the
  // audit file, the timeline JSON, the technician's console and admin views
  // (audit 2026-10-05, F-06: these were unbounded up to the 256 KB frame cap).
  const info: HostInfo = {
    machine: hostField(msg.machine),
    user: hostField(msg.user),
    os: hostField(msg.os),
  };

  // Rate limit BEFORE looking the code up, so a guesser cannot use response
  // timing to tell a real code from a fake one (PLAN 1.2). The attempted code is
  // never logged: a wrong guess is noise, and a right one is a live secret.
  if (!sessions.joinLimiter.allow(conn.ip)) {
    sendError(conn.ws, "rate_limited", "Too many attempts. Wait a minute and try again.");
    void audit("join.rejected", null, { ip: conn.ip, reason: "rate_limited" });
    return;
  }

  const result = sessions.claim(code, conn.ws, info);

  if (!result.ok) {
    const message =
      result.error === "code_expired"
        ? "That code has expired. Ask your agent for a new one."
        : "That code is not valid. Check the digits and try again.";

    sendError(conn.ws, result.error, message);
    void audit("join.rejected", null, { ip: conn.ip, reason: result.error, ...info });
    // Socket stays open: the applet shows the error and lets the user retype
    // (PLAN 2.2). The per-IP limiter, not the socket, is what caps guessing.
    return;
  }

  const { session } = result;
  conn.role = "host";
  conn.code = session.code;
  const declared = parseCapabilities(msg.protocolVersion, msg.capabilities);
  session.hostProtocol = declared.version;
  session.hostCaps = declared.caps;

  void audit("session.joined", session.id, { ip: conn.ip, ...info });
  recordCustomerJoined(session, info, conn.ip);

  // Drives the consent dialog. Nothing streams until the user accepts. The name
  // is the owner's verified directory display name, fixed at session creation.
  // The phase rides on the message that already announces it — no extra
  // message, so a client that reads messages in order sees what it always did.
  setPhase(session, "CONSENT_PENDING", { actor: "customer", notify: false });
  send(conn.ws, { t: "host.connectRequest", agentName: session.agentName });
  send(session.agentWs, {
    t: "peer.joined", role: "host", info, phase: session.lifecycle.phase,
    protocolVersion: session.hostProtocol, capabilities: [...session.hostCaps],
  });
}

/* --------------------------------------------------------------------- agent → host */

function handleAgentMessage(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
): void {
  if (msg.t === "agent.end") {
    void teardown(session.code, "agent_ended", "agent", conn.principal?.userId ?? null);
    return;
  }

  // Every agent action re-checks the bound identity: a suspension or an expired
  // sign-in stops the NEXT message, not just the next session.
  const blocked = agentBlocked(conn);
  if (blocked !== null) {
    sendError(conn.ws, "access_revoked", "Your access has changed. Sign in again.");
    void teardown(session.code, blocked === "expired" ? "agent_session_expired" : "agent_access_revoked", "agent");
    return;
  }
  const principal = conn.principal as Principal;

  // Multi-session view priority. Relay-local: never forwarded to the host, and
  // valid in any state, since the console sets it the moment a tab is created.
  if (msg.t === "agent.view") {
    setViewPriority(conn, session, msg.priority === "preview" ? "preview" : "full");
    return;
  }

  if (session.state !== "active") {
    sendError(conn.ws, "not_active", "The session is not active yet.");
    return;
  }

  if (msg.t === "agent.hold") {
    setHold(session, msg.held === true, data, principal);
    return;
  }

  // Platform 2.0 Phase 3: while the customer's applet is reconnecting there is
  // nobody to deliver to. Input is dropped silently (like a held session); a
  // deliberate action gets a clear refusal rather than waiting forever.
  if (session.hostReconnect !== null && session.hostWs === null) {
    if (msg.t !== "agent.input") {
      sendError(conn.ws, "customer_reconnecting", "The customer's connection dropped. Waiting for it to come back.");
    }
    return;
  }

  // Platform 2.0 Phase 2b: files, clipboard, system info, script cancel. The
  // module applies its own hold rule (continuations of a running transfer pass).
  if (Object.hasOwn(AGENT_FEATURES, msg.t)) {
    handleAgentFeature(featureIo(session, principal, data), msg as unknown as Record<string, unknown>);
    return;
  }

  // Hold, enforced where it counts (Feature Batch 1). The console disables its
  // own controls, but that is a UI courtesy; this is the boundary that decides
  // whether anything reaches the customer's machine.
  if (session.held && isRemoteAction(msg)) {
    // Input is dropped silently on purpose: a mouse-move already in flight when
    // Hold was pressed must not produce an error that the console would paint
    // over a live session. A script or an elevation is a deliberate act, so it
    // gets a real refusal — and a record, because "someone tried to run this
    // while the session was held" is exactly what constraint #5 exists for.
    if (msg.t === "agent.exec") {
      void audit("exec.requested", session.id, {
        id: msg.id, shell: msg.shell, asSystem: msg.asSystem, script: msg.script,
        refused: "session_held",
      });
      void recordEvent(session, "script.refused", "agent", { reason: "session_held", ...scriptSummary(msg) }, principal.userId);
    } else if (msg.t === "agent.requestElevation") {
      void audit("elevation.requested", session.id, {
        mode: msg.mode, refused: "session_held",
      });
      void recordEvent(session, "elevation.refused", "agent", { reason: "session_held", mode: msg.mode }, principal.userId);
    }
    if (msg.t !== "agent.input") {
      sendError(conn.ws, "session_held", "The session is on hold. Resume it first.");
    }
    return;
  }

  // Feature Batch 2. Deliberately reached whether or not the session is held —
  // Hold pauses remote ACTIONS, not communication (`shared/protocol.md`
  // "agent.chat"), and neither of these is in `isRemoteAction()`.
  if (msg.t === "agent.chat") {
    void relayAgentChat(conn, session, msg);
    return;
  }

  if (msg.t === "agent.notes.save") {
    handleNotesSave(conn, session, msg);
    return;
  }

  if (msg.t === "agent.requestElevation") {
    if (!principal.limits.allowElevation) {
      sendError(conn.ws, "not_permitted", "Your account is not allowed to request elevation.");
      void audit("elevation.requested", session.id, { mode: msg.mode, refused: "not_permitted" });
      void recordEvent(session, "elevation.refused", "agent", { reason: "not_permitted", mode: msg.mode }, principal.userId);
      return;
    }
    relayElevation(conn, session, msg, data);
    return;
  }

  if (msg.t === "agent.input" && msg.kind === "sas") {
    // Ordinary mouse and key events are far too many to audit, but the Secure
    // Attention Sequence is not one of them: it is only reachable once the
    // session has been elevated, and it is the agent reaching the Windows
    // security screen. Constraint #5 wants privileged actions on the record.
    void audit("input.sas", session.id, {});
    void recordEvent(session, "sas.sent", "agent", {}, principal.userId);
  }

  if (msg.t === "agent.exec") {
    void relayExec(conn, session, msg, data, principal);
    return;
  }

  // Allow-list, not deny-list (audit 2026-10-05, F-05). Every other agent
  // message was handled above; only well-formed input is forwarded raw. Before
  // this, any unrecognised `agent.*` type reached the customer's applet
  // verbatim — including while the session was on hold, because the hold check
  // only knows the three remote-action types.
  if (msg.t !== "agent.input" || !INPUT_KINDS.has((msg as { kind?: unknown }).kind)) {
    sendError(conn.ws, "protocol", "Unknown or malformed agent message.");
    return;
  }

  // The first input a technician sends after connecting (or resuming, or
  // un-holding) is what "controlling" means. One transition, not one per event.
  if (session.lifecycle.phase === "CONNECTED") {
    setPhase(session, "CONTROLLING", { actor: "agent", actorUserId: principal.userId });
  }
  forward(session.hostWs, data, false);
}

const INPUT_KINDS = new Set<unknown>(["mouse", "key", "sas"]);

/**
 * Switch this session's video between every frame and keyframes only. Going
 * back to "full" replays the catch-up buffer first, so the technician sees the
 * exact current screen immediately rather than a picture up to 5 s old with
 * fresh rectangles painted over it.
 */
function setViewPriority(conn: Conn, session: Session, priority: "full" | "preview"): void {
  if (session.viewPriority === priority) return;
  session.viewPriority = priority;
  if (priority === "full" && session.state === "active") {
    session.videoBehind = false;
    for (const frame of catchUpFrames(session)) forward(conn.ws, frame, true);
  }
}

/** What the timeline and reports keep about a script: never its text. */
function scriptSummary(msg: AnyMessage): Record<string, unknown> {
  if (msg.t !== "agent.exec") return {};
  const script = typeof msg.script === "string" ? msg.script : "";
  return {
    execId: String(msg.id ?? "").slice(0, 64),
    shell: msg.shell,
    asSystem: msg.asSystem === true,
    scriptBytes: Buffer.byteLength(script, "utf8"),
    scriptSha256: createHash("sha256").update(script, "utf8").digest("hex"),
  };
}

/**
 * `agent.exec`. PLAN 1.6: the full script text is audited (JSONL) BEFORE the
 * process can start — and now the durable timeline entry must be written first
 * as well: a script that ran with no record of it having been requested is the
 * one gap this cannot have, so a failed write refuses the script.
 */
async function relayExec(conn: Conn, session: Session, msg: AnyMessage, data: RawData, principal: Principal): Promise<void> {
  if (msg.t !== "agent.exec") return;

  if (!principal.limits.allowScripts) {
    sendError(conn.ws, "not_permitted", "Your account is not allowed to run scripts.");
    void audit("exec.requested", session.id, {
      id: msg.id, shell: msg.shell, asSystem: msg.asSystem, script: msg.script, refused: "not_permitted",
    });
    void recordEvent(session, "script.refused", "agent", { reason: "not_permitted", ...scriptSummary(msg) }, principal.userId);
    return;
  }

  // Saved-library provenance (Platform 2.0). Verified, never trusted: only an
  // exact match of text, shell and privilege is recorded as the library script.
  let library: Record<string, unknown> = {};
  if (msg.libraryRef !== undefined) {
    try {
      const v = await verifyLibraryRun(session.orgId, msg.libraryRef, {
        shell: msg.shell, script: typeof msg.script === "string" ? msg.script : "", asSystem: msg.asSystem === true,
      });
      library = v.ok
        ? { libraryId: v.script.id, libraryVersion: v.script.version, libraryName: v.script.name }
        : { libraryMismatch: v.reason };
    } catch {
      library = { libraryMismatch: "unverified" };
    }
  }

  void audit("exec.requested", session.id, {
    id: msg.id,
    shell: msg.shell,
    asSystem: msg.asSystem,
    script: msg.script,
    ...library,
  });

  try {
    await recordEventStrict(session, "script.requested", "agent", { ...scriptSummary(msg), ...library }, principal.userId);
  } catch {
    sendError(conn.ws, "storage_unavailable", "The script was not run: its audit record could not be written.");
    return;
  }
  // Re-check after the await: the session may have ended, or been held.
  if (sessions.get(session.code) !== session || session.held) return;
  forward(session.hostWs, data, false);
}

/**
 * Put a live session on hold, or take it off hold (Feature Batch 1).
 *
 * Deliberately minimal: no socket is touched, no state moves off `active`, the
 * video stream keeps flowing and consent is untouched. Hold can only ever
 * *remove* the agent's ability to act, so there is nothing here to bypass.
 *
 * The frame is forwarded to the host so the applet can say so on the user's
 * session indicator (constraint #2). An applet that predates the message ignores
 * it, and the hold still holds, because the enforcement is above, not there.
 */
function setHold(session: Session, held: boolean, data: RawData, principal: Principal): void {
  if (session.held === held) return;  // no audit spam from a repeated click

  session.held = held;
  setPhase(session, held ? "ON_HOLD" : "CONNECTED", { actor: "agent", actorUserId: principal.userId });
  void audit(held ? "session.held" : "session.resumed", session.id, {
    machine: session.hostInfo?.machine ?? null,
  });
  void recordEvent(session, held ? "session.held" : "session.resumed", "agent", {}, principal.userId);

  forward(session.hostWs, data, false);
}

interface ChatFields {
  kind: ChatKind;
  text?: string;
  url?: string;
  label?: string;
  clientId: string;
}

/**
 * Persist, then dispatch, the canonical `chat.message` (Feature Batch 2 +
 * durable transcripts). The message is written to `chat_messages` FIRST; only
 * then is it forwarded to the peer and echoed to the sender, so the sender's
 * "sent" tick means "recorded". A failed write sends `chat_not_saved` for that
 * `clientId` and forwards nothing. A retry of an already-stored `clientId` is
 * answered from the stored row and never forwarded twice.
 *
 * `senderRole` comes from which socket the message arrived on, never from
 * anything the client sent. The id is `<session uuid>.<seq>` — the pairing code
 * no longer appears in it.
 */
async function persistAndDispatchChat(
  conn: Conn,
  session: Session,
  senderRole: Role,
  fields: ChatFields,
): Promise<void> {
  const peerWs = senderRole === "agent" ? session.hostWs : session.agentWs;
  let saved;
  try {
    saved = await saveChat(session, senderRole === "agent" ? "agent" : "customer",
      senderRole === "agent" ? conn.principal?.userId ?? null : null, fields);
  } catch {
    sendError(conn.ws, "chat_not_saved", "The message could not be saved, so it was not sent. Try again.", fields.clientId);
    return;
  }

  const canonical: ChatMessage = {
    t: "chat.message",
    id: `${session.id}.${saved.seq}`,
    senderRole,
    kind: saved.kind,
    ts: saved.createdAt.getTime(),
    clientId: fields.clientId,
    ...(saved.text !== null ? { text: saved.text } : {}),
    ...(saved.url !== null ? { url: saved.url } : {}),
    ...(saved.label !== null ? { label: saved.label } : {}),
  };

  if (fields.clientId !== "") {
    sessions.rememberChat(session, `${senderRole}:${fields.clientId}`, canonical);
  }
  if (!saved.duplicate) send(peerWs, canonical);
  send(conn.ws, canonical);

  // The security log gets who/what/when, never content (§11).
  if (saved.duplicate) return;
  if (saved.kind === "url" && saved.url !== null) {
    void audit("url.shared", session.id, { senderRole, domain: urlDomain(saved.url) });
    void recordEvent(session, "url.shared", "agent", { domain: urlDomain(saved.url) }, conn.principal?.userId ?? null);
  } else {
    void audit("chat.message", session.id, { senderRole, length: saved.text?.length ?? 0 });
  }
}

/** A resend of a clientId already handled: re-ack the sender only. True if handled. */
function reackRemembered(conn: Conn, session: Session, role: Role, clientId: string): boolean {
  const remembered = clientId !== "" ? session.recentChatByClientId.get(`${role}:${clientId}`) : undefined;
  if (!remembered) return false;
  send(conn.ws, remembered);
  return true;
}

/**
 * `agent.chat` — plain text or Send URL, technician → customer (Feature Batch
 * 2). Validated server-side regardless of what the console already checked:
 * this relay is the boundary that counts (§7A, §18).
 */
async function relayAgentChat(conn: Conn, session: Session, msg: AnyMessage): Promise<void> {
  if (msg.t !== "agent.chat") return;

  const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 100) : "";
  if (reackRemembered(conn, session, "agent", clientId)) return;

  // Per side (audit 2026-10-05, F-07): one shared bucket let a flooding
  // customer applet use up the technician's chat allowance, and vice versa.
  if (!sessions.chatLimiter.allow(`${session.code}:agent`)) {
    sendError(conn.ws, "chat_rate_limited", "Too many messages. Slow down a moment.", clientId);
    return;
  }

  if (msg.kind === "text") {
    if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > MAX_CHAT_TEXT_LENGTH) {
      sendError(conn.ws, "chat_too_long", "Message is empty or too long.", clientId);
      return;
    }
    await persistAndDispatchChat(conn, session, "agent", { kind: "text", text: msg.text, clientId });
    return;
  }

  if (msg.kind === "url") {
    if (!isValidHttpUrl(msg.url)) {
      sendError(conn.ws, "invalid_url", "Only http:// and https:// links can be shared.", clientId);
      return;
    }
    if (typeof msg.label === "string" && msg.label.length > MAX_CHAT_LABEL_LENGTH) {
      sendError(conn.ws, "chat_too_long", "Link label is too long.", clientId);
      return;
    }

    const hasLabel = typeof msg.label === "string" && msg.label.length > 0;
    await persistAndDispatchChat(conn, session, "agent", {
      kind: "url",
      url: msg.url,
      clientId,
      ...(hasLabel ? { label: msg.label as string } : {}),
    });
    return;
  }

  sendError(conn.ws, "protocol", "Unknown chat message kind.");
}

/** `host.chat` — plain text only, customer → technician (Feature Batch 2). */
async function relayHostChat(conn: Conn, session: Session, msg: AnyMessage): Promise<void> {
  if (msg.t !== "host.chat") return;

  const clientId = typeof msg.clientId === "string" ? msg.clientId.slice(0, 100) : "";
  if (reackRemembered(conn, session, "host", clientId)) return;

  if (!sessions.chatLimiter.allow(`${session.code}:host`)) {
    sendError(conn.ws, "chat_rate_limited", "Too many messages. Slow down a moment.", clientId);
    return;
  }

  if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > MAX_CHAT_TEXT_LENGTH) {
    sendError(conn.ws, "chat_too_long", "Message is empty or too long.", clientId);
    return;
  }

  await persistAndDispatchChat(conn, session, "host", { kind: "text", text: msg.text, clientId });
}

/**
 * `agent.notes.save` (Feature Batch 2). Kept for compatibility and the audit
 * trail: the note text never crosses this socket at all — only its length. The
 * console now stores the text itself through the authenticated notes API
 * (`POST /api/sessions/:id/notes`), which never touches the host socket, so notes
 * stay technician-private by construction.
 */
function handleNotesSave(conn: Conn, session: Session, msg: AnyMessage): void {
  if (msg.t !== "agent.notes.save") return;

  const length = msg.length;
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0 || length > MAX_NOTES_LENGTH) {
    sendError(conn.ws, "protocol", "Invalid notes length.");
    return;
  }

  void audit("notes.saved", session.id, { length });
}

/**
 * Elevation requests (PLAN 5.2c). The transport check and the rate limit live
 * here because the message crosses this relay from Phase 1 onward — leaving the
 * guard until Phase 5 would mean a window where a password relays unchecked.
 *
 * The password is never read, never re-serialised and never logged: the audit
 * record carries only the mode, username and outcome, and the frame is forwarded
 * exactly as received. The durable timeline entry is written best-effort and
 * NOT awaited: waiting on the database would mean the relay holding a
 * credential-bearing frame, which constraint #6 forbids.
 */
function relayElevation(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
): void {
  if (msg.t !== "agent.requestElevation") return;

  const credential = isCredentialElevation(msg);
  const detail = credential
    ? { mode: "credential", domain: msg.domain, username: msg.username }
    : { mode: "interactive" };
  // The timeline keeps the mode only — not even the account name.
  const timeline = { mode: credential ? "credential" : "interactive" };
  const userId = conn.principal?.userId ?? null;

  // BOTH legs must be TLS (audit 2026-10-05, F-02). The password crosses the
  // technician's connection AND the customer's; checking only the technician's
  // let it reach an applet that dialled plain ws:// in cleartext.
  const hostConn = session.hostWs !== null ? conns.get(session.hostWs) : undefined;
  const bothSecure = conn.secure && hostConn?.secure === true;
  if (credential && !bothSecure && !config.allowInsecureDev) {
    sendError(
      conn.ws,
      "insecure_transport",
      "Admin credentials cannot be sent over an unencrypted connection.",
    );
    void audit("elevation.requested", session.id, {
      ...detail,
      refused: "insecure_transport",
      leg: conn.secure ? "customer" : "technician",
    });
    void recordEvent(session, "elevation.refused", "agent", { ...timeline, reason: "insecure_transport" }, userId);
    return;
  }

  session.elevationAttempts += 1;
  if (session.elevationAttempts > config.elevationAttemptsPerSession) {
    sendError(
      conn.ws,
      "elevation_rate_limited",
      "Too many elevation attempts in this session.",
    );
    void audit("elevation.requested", session.id, {
      ...detail,
      refused: "elevation_rate_limited",
      attempt: session.elevationAttempts,
    });
    void recordEvent(session, "elevation.refused", "agent",
      { ...timeline, reason: "elevation_rate_limited", attempt: session.elevationAttempts }, userId);
    return;
  }

  void audit("elevation.requested", session.id, {
    ...detail,
    attempt: session.elevationAttempts,
  });

  forward(session.hostWs, data, false);
  void recordEvent(session, "elevation.requested", "agent", { ...timeline, attempt: session.elevationAttempts }, userId);
}

/* --------------------------------------------------------------------- host → agent */

function handleHostMessage(
  conn: Conn,
  session: Session,
  msg: AnyMessage,
  data: RawData,
  isBinary: boolean,
): void {
  if (msg.t === "host.consent") {
    handleConsent(conn, session, msg.accepted === true);
    return;
  }

  if (session.state !== "active") {
    sendError(conn.ws, "not_active", "The session is not active yet.");
    return;
  }

  // Platform 2.0 Phase 2b feature replies: accounted and recorded, then forwarded.
  if (handleHostFeature(featureIo(session, null, data), msg as unknown as Record<string, unknown>)) return;

  // Feature Batch 2. Handled here, not forwarded raw: like `agent.chat`, the
  // canonical envelope (id, ts, senderRole) is server-assigned, and chat is
  // deliberately reachable regardless of Hold (`shared/protocol.md` "agent.chat").
  if (msg.t === "host.chat") {
    void relayHostChat(conn, session, msg);
    return;
  }

  if (msg.t === "host.elevated") {
    if (msg.ok === true) session.elevated = true;
    void audit("elevation.result", session.id, { ok: msg.ok, error: msg.error ?? null });
    void recordEvent(session, "elevation.result", "customer", {
      ok: msg.ok === true,
      // A mapped, human-readable sentence from the applet — never a credential.
      error: typeof msg.error === "string" ? msg.error.slice(0, 300) : null,
    });
  } else if (msg.t === "host.execResult" && msg.partial !== true) {
    // Only the final result is audited; the partial chunks that stream before it
    // would otherwise write one audit record per 250ms of script output.
    void audit("exec.result", session.id, { id: msg.id, exitCode: msg.exitCode });
    // Output is shown to the technician live but not stored: it can contain
    // anything the script printed, secrets included.
    void recordEvent(session, "script.result", "customer", {
      execId: String(msg.id ?? "").slice(0, 64),
      exitCode: typeof msg.exitCode === "number" ? msg.exitCode : null,
    });
  } else if (msg.t === "host.desktopChanged") {
    if (msg.desktop === "Default" || msg.desktop === "Winlogon" || msg.desktop === "Screen-saver") session.desktop = msg.desktop;
    void recordEvent(session, "desktop.changed", "customer", { desktop: String(msg.desktop ?? "").slice(0, 32) });
  }

  forward(session.agentWs, data, isBinary);
}

function handleConsent(conn: Conn, session: Session, accepted: boolean): void {
  if (session.state !== "waiting_for_consent") {
    sendError(conn.ws, "protocol", "Consent was not expected at this point.");
    return;
  }

  void audit("session.consent", session.id, {
    accepted,
    machine: session.hostInfo?.machine ?? null,
    user: session.hostInfo?.user ?? null,
  });
  recordConsent(session, accepted);

  if (!accepted) {
    send(session.agentWs, { t: "consent.result", accepted });
    void teardown(session.code, "customer_declined", "host");
    return;
  }

  session.state = "active";
  session.consentedAt = Date.now();
  // As with peer.joined: the phase rides on consent.result, not a message of its own.
  setPhase(session, "CONNECTED", { actor: "customer", notify: false });
  send(session.agentWs, { t: "consent.result", accepted, phase: session.lifecycle.phase });
  measureLegs(session);
  // Platform 2.0 Phase 3: an applet that can resume gets its secret now, so a
  // dropped connection does not end a session the customer never ended.
  if (session.hostCaps.has("resume") && config.hostReconnectGraceMs > 0) {
    sendJson(session.hostWs, { t: "host.resumeToken", sessionId: session.id, resumeToken: sessions.issueHostResumeToken(session) });
  }
  send(session.hostWs, { t: "peer.joined", role: "agent" });
}

/**
 * Send one host video frame to the technician, with backpressure (audit
 * 2026-10-05, F-09). Over the high-water mark the frame is skipped; the first
 * frame sent after the buffer drains is preceded by the catch-up buffer
 * (keyframe + every rect since — which already includes this frame), so the
 * technician's picture is rebuilt exactly instead of missing regions.
 */
function relayVideo(session: Session, frame: Buffer): void {
  const ws = session.agentWs;
  if (ws === null || ws.readyState !== WebSocket.OPEN) return;
  const wanted = session.viewPriority === "full" || frame[0] === FRAME_FULL;
  if (!wanted) return;
  if (ws.bufferedAmount > VIDEO_HIGH_WATER_BYTES) {
    session.videoBehind = true;
    return;
  }
  if (session.videoBehind && frame[0] !== FRAME_FULL) {
    session.videoBehind = false;
    for (const f of catchUpFrames(session)) forward(ws, f, true);
    return;
  }
  session.videoBehind = false;
  forward(ws, frame, true);
}

/* ------------------------------------------------------------------ message dispatch */

function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
  const session = conn.code === null ? undefined : sessions.get(conn.code);

  if (isBinary) {
    // Only the host sends binary, and only once the user has consented.
    if (conn.role !== "host" || !session || session.state !== "active") {
      sendError(conn.ws, "not_active", "The session is not active yet.");
      return;
    }
    // Multi-session: every frame updates the catch-up buffer; a session the
    // technician is not looking at gets keyframes only. With no technician
    // attached (reconnect grace) nothing is sent anywhere.
    const frame = frameBuffer(data);
    noteFrame(session, frame);
    relayVideo(session, frame);
    return;
  }

  // Byte length, not string length: a cap counted in UTF-16 units lets a
  // multi-byte payload be three times the intended size.
  if (controlByteLength(data) > MAX_CONTROL_BYTES) {
    sendError(conn.ws, "protocol", "Control message too large.");
    conn.ws.close(1009, "control message too large");
    return;
  }

  const text = data.toString();
  let msg: AnyMessage;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    if (typeof (parsed as { t?: unknown }).t !== "string") throw new Error("no discriminator");
    msg = parsed as AnyMessage;
  } catch {
    sendError(conn.ws, "protocol", "Malformed message.");
    conn.ws.close(1002, "malformed message");
    return;
  }

  // The first message declares the role; anything else closes the socket.
  if (conn.role === null) {
    if (msg.t === "agent.create") {
      void handleAgentCreate(conn).catch((err: unknown) => {
        console.error("[ws] agent.create failed:", err instanceof Error ? err.message : err);
        sendError(conn.ws, "protocol", "The session could not be created.");
      });
    } else if (msg.t === "agent.resume") {
      void handleAgentResume(conn, msg).catch((err: unknown) => {
        console.error("[ws] agent.resume failed:", err instanceof Error ? err.message : err);
        sendError(conn.ws, "protocol", "The session could not be resumed.");
      });
    } else if (msg.t === "host.join") {
      handleHostJoin(conn, msg);
    } else if ((msg.t as string) === "host.resume") {
      handleHostResume(conn, msg as unknown as Record<string, unknown>);
    } else {
      sendError(conn.ws, "protocol", "First message must be agent.create, agent.resume, host.join or host.resume.");
      conn.ws.close(1002, "role not declared");
    }
    return;
  }

  if (!session) {
    sendError(conn.ws, "protocol", "This session has ended.");
    conn.ws.close(1000, "session ended");
    return;
  }

  if (conn.role === "agent") {
    if (!msg.t.startsWith("agent.") || msg.t === "agent.create" || msg.t === "agent.resume") {
      sendError(conn.ws, "protocol", `Unexpected ${msg.t} from an agent socket.`);
      return;
    }
    handleAgentMessage(conn, session, msg, data);
    return;
  }

  if (!msg.t.startsWith("host.") || msg.t === "host.join") {
    sendError(conn.ws, "protocol", `Unexpected ${msg.t} from a host socket.`);
    return;
  }
  handleHostMessage(conn, session, msg, data, isBinary);
}

/* ---------------------------------------------------------------- admin-side hooks */

/** A live session as the admin portal sees it — no code, no sockets. */
export interface LiveSessionView {
  id: string;
  orgId: string;
  agentUserId: string;
  teamId: string | null;
  agentName: string;
  agentCode: string | null;
  state: Session["state"];
  held: boolean;
  createdAt: number;
  consentedAt: number | null;
  customer: HostInfo | null;
  /** Multi-session: the technician socket is gone and the session is inside its reconnect grace. */
  reconnecting: boolean;
  reconnectCount: number;
  elevated: boolean;
  phase: SessionPhase;
  phaseSince: number;
  hostRttMs: number | null;
  customerReconnecting: boolean;
}

export function liveSessions(): LiveSessionView[] {
  return sessions.all().map((s) => ({
    id: s.id,
    orgId: s.orgId,
    agentUserId: s.agentUserId,
    teamId: s.teamId,
    agentName: s.agentName,
    agentCode: s.agentCode,
    state: s.state,
    held: s.held,
    createdAt: s.createdAt,
    consentedAt: s.consentedAt,
    customer: s.hostInfo,
    reconnecting: s.reconnect !== null,
    reconnectCount: s.reconnectCount,
    elevated: s.elevated,
    phase: s.lifecycle.phase,
    phaseSince: s.lifecycle.phaseSince,
    hostRttMs: s.hostRttMs,
    customerReconnecting: s.hostReconnect !== null,
  }));
}

/**
 * End a live session on an administrator's authority. The customer's applet sees
 * the session end exactly as if the technician had ended it — this is a stop
 * button, not a takeover: nothing is viewed or controlled by the administrator.
 */
export async function terminateSession(sessionId: string, by: Principal): Promise<boolean> {
  const session = sessions.byId(sessionId);
  if (!session || session.orgId !== by.orgId) return false;
  send(session.agentWs, { t: "error", code: "access_revoked", message: "An administrator ended this session." });
  void audit("session.terminated", session.id, { by: by.userId });
  await teardown(session.code, "terminated_by_admin", null, by.userId);
  return true;
}

/**
 * Apply an access change to a user's open sockets at once: refresh their limits,
 * or — when they are no longer active — end their sessions and close the
 * sockets. Called by the admin API after the change is committed.
 */
export function applyUserAccessChange(userId: string, next: Pick<Principal, "status" | "limits" | "teamId" | "agentCode"> | null): void {
  // Losing console access is a revocation for the relay, exactly like a
  // suspension (audit 2026-10-05, F-03): the user stays `active` for the admin
  // portal, but must not keep controlling a customer's machine.
  const revoked = next === null || next.status !== "active" || !next.limits.canUseConsole;
  for (const conn of conns.values()) {
    if (conn.principal?.userId !== userId) continue;
    if (revoked) {
      conn.principal = next === null
        ? { ...conn.principal, status: "suspended" }
        : { ...conn.principal, status: next.status, limits: next.limits };
      // Tell the console WHY before teardown closes the socket under it.
      sendError(conn.ws, "access_revoked", next !== null && next.status === "active"
        ? "Your access to the technician console has been removed."
        : "Your access to Helpdesk Anywhere has been suspended.");
      if (conn.code !== null) void teardown(conn.code, "agent_access_revoked", "agent");
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(4403, "access revoked");
      continue;
    }
    conn.principal = { ...conn.principal, limits: next.limits, teamId: next.teamId, agentCode: next.agentCode };
  }
  // A session inside its reconnect grace has no socket above, but it is still
  // the revoked user's: it must not wait out the grace to be resumed.
  if (revoked) {
    for (const s of sessions.forUser(userId)) {
      if (s.agentWs === null) void teardown(s.code, "agent_access_revoked", "agent");
    }
  }
}

/**
 * A browser sign-in was ended (sign-out). Every relay socket that was opened
 * with THAT sign-in loses its identity at once and its sessions end, instead
 * of driving customers' machines until the cookie's natural expiry (audit
 * 2026-10-05, F-04). Other tabs or devices the same technician signed in
 * separately are a different `sessionHash` and are untouched.
 */
export function revokeAuthSession(sessionHash: string): void {
  for (const conn of conns.values()) {
    if (conn.principal?.sessionHash !== sessionHash) continue;
    conn.principal = { ...conn.principal, status: "suspended" };
    sendError(conn.ws, "access_revoked", "You signed out, so this session was ended.");
    if (conn.code !== null) void teardown(conn.code, "agent_session_expired", "agent");
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(4403, "signed out");
  }
}

/** Graceful shutdown: end every live session as `server_shutdown` and wait for the records. */
export async function endAllSessions(): Promise<void> {
  await Promise.all(sessions.all().map((s) => teardown(s.code, "server_shutdown", null)));
}

/* ------------------------------------------------------------------------- lifecycle */

/** Open sockets from `ip` that carry no technician identity. */
function anonymousSocketsFrom(ip: string): number {
  let n = 0;
  for (const c of conns.values()) if (c.principal === null && c.ip === ip) n++;
  return n;
}

/** First byte of an RTT-measuring ping payload: `[0x52][f64 BE epoch ms]`. */
const PING_RTT_TAG = 0x52;

/** Send a stamped ping on each open leg of `session`; `notePong` records the answers. */
function measureLegs(session: Session): void {
  const stamp = Buffer.alloc(9);
  stamp[0] = PING_RTT_TAG;
  stamp.writeDoubleBE(Date.now(), 1);
  for (const ws of [session.hostWs, session.agentWs]) {
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.ping(stamp);
  }
}

/** Turn a stamped pong into the round trip for that leg of its session. */
function notePong(conn: Conn, payload: Buffer): void {
  if (payload.length !== 9 || payload[0] !== PING_RTT_TAG || conn.code === null) return;
  const rtt = Date.now() - payload.readDoubleBE(1);
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 120_000) return;
  const session = sessions.get(conn.code);
  if (!session) return;
  if (conn.role === "host" && session.hostWs === conn.ws) session.hostRttMs = Math.round(rtt);
  else if (conn.role === "agent" && session.agentWs === conn.ws) session.agentRttMs = Math.round(rtt);
}

export function attachSignaling(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 8 * 1024 * 1024,
    verifyClient: ({ origin, req }, done) => {
      if (!originAllowed(origin, req.headers.host)) {
        console.warn(`[ws] refused an upgrade from origin ${origin}`);
        done(false, 403, "Forbidden origin");
        return;
      }
      // Authorise the upgrade itself, not just the first message: a BROWSER
      // socket must carry a valid technician session. The applet sends no
      // Origin and no cookie and stays anonymous — it can only ever be a host.
      const isBrowser = origin !== undefined && origin !== "";
      // Anonymous sockets (customer applets) are bounded per IP (audit F-08).
      const admitAnonymous = (): void => {
        if (anonymousSocketsFrom(clientIp(req)) >= config.maxAnonymousSocketsPerIp) {
          done(false, 429, "Too many connections");
          return;
        }
        done(true);
      };
      principalFromRequest(req, "agent")
        .then((principal) => {
          if (principal !== null) upgradePrincipals.set(req, principal);
          if (isBrowser && principal === null) {
            done(false, 401, "Sign-in required");
            return;
          }
          if (principal === null) admitAnonymous();
          else done(true);
        })
        .catch((err: unknown) => {
          console.error("[ws] identity lookup failed:", err instanceof Error ? err.message : err);
          if (isBrowser) done(false, 503, "Identity service unavailable");
          else admitAnonymous();  // the customer path must not depend on the identity store
        });
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const conn: Conn = {
      ws,
      ip: clientIp(req),
      secure: isSecure(req),
      principal: upgradePrincipals.get(req) ?? null,
      role: null,
      code: null,
      alive: true,
    };
    upgradePrincipals.delete(req);
    conns.set(ws, conn);

    ws.on("pong", (payload: Buffer) => {
      conn.alive = true;
      notePong(conn, payload);
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (err) {
        // Never let one bad frame take the process down mid-session. The message
        // itself is not logged: it may be a credential-mode elevation.
        console.error("[ws] handler error:", err instanceof Error ? err.message : err);
        sendError(ws, "protocol", "Message could not be handled.");
      }
    });

    ws.on("close", (closeCode: number, reason: Buffer) => {
      conns.delete(ws);
      // PLAN 1.3: close both sides when either drops. The applet's End Session
      // button closes normally with this exact reason (AppletContext.Finish),
      // which is how "the customer ended it" differs from "the line dropped".
      if (conn.code === null) return;
      // Multi-session: a technician socket that drops without agent.end starts
      // the reconnect grace instead of ending the session — only if it is still
      // THE socket of that session (a resume elsewhere detaches it first).
      if (conn.role === "agent" && config.agentReconnectGraceMs > 0) {
        const session = sessions.get(conn.code);
        if (session && session.agentWs === ws && session.resumeIssued) {
          beginAgentGrace(session, closeCode === 1006 ? "connection_lost" : `closed_${closeCode}`);
          return;
        }
      }
      const customerEnded = conn.role === "host" && closeCode === 1000 && reason.toString() === "user ended the session";
      // Platform 2.0 Phase 3: a customer drop (not their End Session) on a
      // session whose applet can resume starts the customer's grace.
      if (conn.role === "host" && !customerEnded && config.hostReconnectGraceMs > 0) {
        const session = sessions.get(conn.code);
        if (session && session.hostWs === ws && session.state === "active" && session.hostResumeIssued) {
          beginHostGrace(session, closeCode === 1006 ? "connection_lost" : `closed_${closeCode}`);
          return;
        }
      }
      const why: EndReason =
        customerEnded ? "customer_ended"
          : conn.role === "host" ? "customer_disconnected"
            : "agent_disconnected";
      void teardown(conn.code, why, conn.role);
    });

    ws.on("error", (err) => {
      console.error("[ws] socket error:", err.message);
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => {
    // Safety net behind the per-session grace timer: no session may sit without
    // a technician for materially longer than the grace, whatever happened to
    // its timer.
    const overdue = Date.now() - config.agentReconnectGraceMs - 10_000;
    for (const s of sessions.all()) {
      if (s.reconnect !== null && s.reconnect.since < overdue) void teardown(s.code, "agent_disconnected", "agent");
    }
    const hostOverdue = Date.now() - config.hostReconnectGraceMs - 10_000;
    for (const s of sessions.all()) {
      if (s.hostReconnect !== null && s.hostReconnect.since < hostOverdue) void teardown(s.code, "customer_disconnected", "host");
    }
    for (const session of sessions.sweep()) {
      sendError(session.agentWs, "code_expired", "The session code expired unused.");
      setPhase(session, "EXPIRED");
      if (session.agentWs?.readyState === WebSocket.OPEN) {
        session.agentWs.close(1000, "code expired");
      }
      void audit("session.ended", session.id, { reason: "code expired unused", endReason: "code_expired" });
      void recordEnded(session, "code_expired");
    }
  }, SWEEP_MS);

  // Platform 2.0 connection health: measure both legs of every active session
  // and report to its technician. Stamped pings, separate from the liveness
  // heartbeat above (whose un-stamped pings `notePong` ignores).
  const health = setInterval(() => {
    for (const s of sessions.all()) {
      if (s.state !== "active") continue;
      measureLegs(s);
      send(s.agentWs, { t: "session.health", hostRttMs: s.hostRttMs, agentRttMs: s.agentRttMs });
    }
  }, HEALTH_MS);

  heartbeat.unref();
  sweeper.unref();
  health.unref();

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    clearInterval(health);
  });

  return wss;
}
