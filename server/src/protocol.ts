/**
 * Wire protocol — TypeScript mirror of `shared/protocol.md`.
 *
 * `shared/protocol.md` is the single source of truth; this file and
 * `windows/Shared/Protocol.cs` mirror it. CHANGE ALL THREE TOGETHER
 * (CLAUDE.md conventions).
 */

import type { SessionPhase } from "./lifecycle.js";

export type Role = "agent" | "host";

export type DesktopName = "Default" | "Winlogon" | "Screen-saver";

export type SessionState =
  | "waiting_for_host"
  | "waiting_for_consent"
  | "active"
  | "ended";

export type ErrorCode =
  | "bad_code"
  | "code_expired"
  | "rate_limited"
  | "not_active"
  | "insecure_transport"
  | "elevation_rate_limited"
  | "session_held"
  | "chat_too_long"
  | "chat_rate_limited"
  | "invalid_url"
  | "unauthorized"
  | "not_permitted"
  | "session_limit"
  | "storage_unavailable"
  | "chat_not_saved"
  | "access_revoked"
  | "resume_failed"
  | "not_supported"
  | "transfer_refused"
  | "protocol";

/** `agent.chat` / `host.chat` / `chat.message` share this discriminator (Feature Batch 2). */
export type ChatKind = "text" | "url";

/* ------------------------------------------------------------------ agent → server */

export interface AgentCreate {
  t: "agent.create";
}

export interface AgentMouseInput {
  t: "agent.input";
  kind: "mouse";
  /** Remote pixels in virtual-desktop space, not CSS pixels. */
  x: number;
  y: number;
  action: "move" | "down" | "up" | "wheel";
  /** 0 = left, 1 = middle, 2 = right. Null for move/wheel. */
  button: 0 | 1 | 2 | null;
  wheelDelta?: number;
}

export interface AgentKeyInput {
  t: "agent.input";
  kind: "key";
  /** DOM `event.code` (physical key), not `event.key`. */
  code: string;
  action: "down" | "up";
}

/**
 * Ctrl+Alt+Del (PLAN 4.3). Not a key chord: `SendInput` cannot produce a Secure
 * Attention Sequence, so the applet routes this to the elevated service's
 * `SendSAS()`. The console only enables it after `host.elevated { ok:true }`.
 */
export interface AgentSasInput {
  t: "agent.input";
  kind: "sas";
  /** Always "press"; present only because every agent.input carries an action. */
  action: "press";
}

export type AgentInput = AgentMouseInput | AgentKeyInput | AgentSasInput;

export interface AgentExec {
  t: "agent.exec";
  id: string;
  shell: "powershell" | "cmd";
  script: string;
  asSystem: boolean;
  /**
   * Platform 2.0: this is saved-library script `id` at `version`. The relay
   * verifies text, shell and privilege before recording it as such; the applet
   * ignores the field (unknown JSON members are skipped).
   */
  libraryRef?: { id: string; version: number };
}

export interface AgentRequestElevationInteractive {
  t: "agent.requestElevation";
  mode: "interactive";
}

export interface AgentRequestElevationCredential {
  t: "agent.requestElevation";
  mode: "credential";
  domain: string;
  username: string;
  /**
   * NEVER logged, persisted or buffered. Refused over non-wss:. Redacted by
   * `audit.ts` before anything reaches disk. See `shared/protocol.md`
   * "Credential handling" and PLAN 5.2c.
   */
  password: string;
}

export type AgentRequestElevation =
  | AgentRequestElevationInteractive
  | AgentRequestElevationCredential;

/**
 * Pause (`held: true`) or resume (`held: false`) technician control of a live
 * session, without ending it (Feature Batch 1).
 *
 * The session stays `active`: socket, applet, consent and video stream are
 * untouched. The relay enforces the hold — see `shared/protocol.md`
 * "agent.hold" — and forwards it to the host so the applet can surface it on the
 * user's session indicator.
 */
export interface AgentHold {
  t: "agent.hold";
  held: boolean;
}

/**
 * Plain-text chat (Feature Batch 2). No sender identity is carried here — the
 * relay assigns `senderRole` from which socket it arrived on, never from
 * anything the client sends, so it cannot be spoofed. `clientId` is opaque and
 * client-chosen; the relay only ever echoes it back for the sender's own
 * optimistic-bubble reconciliation and resend de-duplication, never for
 * ordering or identity. Not gated by Hold: pausing remote *actions* is not
 * pausing *communication* (`shared/protocol.md`).
 */
export interface AgentChatText {
  t: "agent.chat";
  kind: "text";
  text: string;
  clientId: string;
}

/** Send URL (Feature Batch 2) — a specialised chat item, technician → customer only. */
export interface AgentChatUrl {
  t: "agent.chat";
  kind: "url";
  url: string;
  label?: string;
  clientId: string;
}

export type AgentChat = AgentChatText | AgentChatUrl;

/**
 * Record that technician notes were saved (Feature Batch 2). The note text
 * itself is never sent here — notes are technician-private, kept only in the
 * console's own page state, with no path that could forward them to the host
 * socket. `length` exists solely so the save is auditable (constraint #5)
 * without the content ever reaching a log.
 */
export interface AgentNotesSave {
  t: "agent.notes.save";
  length: number;
}

export interface AgentEnd {
  t: "agent.end";
}

/**
 * Multi-session: pick a live session back up on a NEW technician socket after
 * the old one dropped (network blip, page reload). Only valid as the first
 * message on a socket, and only for the same signed-in technician who owns the
 * session AND presents the session's current resume token — `sessionId` alone
 * is never enough (it appears in history, reports and the admin portal).
 */
export interface AgentResume {
  t: "agent.resume";
  sessionId: string;
  resumeToken: string;
}

/**
 * Multi-session: how much of the host's video this socket wants. "full" (the
 * default) relays every frame; "preview" — a session the technician is not
 * looking at — relays keyframes only (the applet sends one at least every 5 s)
 * and keeps the dirty rectangles since the last keyframe server-side, so that
 * switching back to "full" is replayed to an exact, current picture. Consumed
 * by the relay; never forwarded to the host.
 */
export interface AgentView {
  t: "agent.view";
  priority: "full" | "preview";
}

export type AgentMessage =
  | AgentCreate
  | AgentInput
  | AgentExec
  | AgentRequestElevation
  | AgentHold
  | AgentChat
  | AgentNotesSave
  | AgentEnd
  | AgentResume
  | AgentView;

/* ------------------------------------------------------------------- host → server */

export interface HostJoin {
  t: "host.join";
  code: string;
  machine: string;
  user: string;
  os: string;
  /**
   * Platform 2.0: absent on applets built before it (treated as 1). Version 2
   * adds `capabilities`, the optional features this applet implements.
   */
  protocolVersion?: number;
  capabilities?: string[];
}

export interface HostConsent {
  t: "host.consent";
  accepted: boolean;
}

export interface HostDesktopChanged {
  t: "host.desktopChanged";
  desktop: DesktopName;
}

export interface HostElevated {
  t: "host.elevated";
  ok: boolean;
  /** A mapped, human-readable message — never a raw credential. */
  error?: string;
}

export interface HostExecResult {
  t: "host.execResult";
  id: string;
  /** Meaningless (-1) while `partial` is true. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True for an incremental chunk streamed while the script is still running.
   * Only the final, non-partial result is audited. See `shared/protocol.md`
   * "host.execResult streaming".
   */
  partial?: boolean;
}

/** Plain-text chat from the customer (Feature Batch 2). See `AgentChatText`. */
export interface HostChat {
  t: "host.chat";
  text: string;
  clientId: string;
}

export type HostMessage =
  | HostJoin
  | HostConsent
  | HostDesktopChanged
  | HostElevated
  | HostExecResult
  | HostChat;

/* ------------------------------------------------------------------ server → peers */

export interface SessionCreated {
  t: "session.created";
  /** Short-lived pairing secret for the customer. Not an identifier; never stored. */
  code: string;
  /** Permanent session id (UUID) — what history, notes and reports use. */
  sessionId: string;
  /**
   * Multi-session: the secret that lets THIS technician resume the session on
   * a new socket (`agent.resume`). Random, per session, rotated on every
   * resume, stored server-side only as a hash, never logged or persisted.
   */
  resumeToken: string;
  /** Platform 2.0: epoch ms at which the unused code expires. */
  expiresAt: number;
  /** The same as a duration from now, so a console with a skewed clock still counts down correctly. */
  expiresInMs: number;
  /** Platform 2.0: lifecycle phase at creation (`WAITING`). */
  phase: SessionPhase;
}

/**
 * Multi-session: the answer to a successful `agent.resume` — everything the
 * console needs to rebuild that one session's view. Followed by the relay's
 * catch-up frames (the last keyframe and the dirty rectangles since) and a
 * `chat.history`.
 */
export interface SessionResumed {
  t: "session.resumed";
  sessionId: string;
  /** Rotated: the previous token is no longer valid. */
  resumeToken: string;
  state: SessionState;
  /** Present only while the code is still waiting for a customer. */
  code?: string;
  host: HostInfo | null;
  held: boolean;
  elevated: boolean;
  desktop: DesktopName;
  createdAt: number;
  consentedAt: number | null;
  reconnectCount: number;
  /** Platform 2.0: the phase the session resumed into, and since when. */
  phase: SessionPhase;
  phaseSince: number;
  /** Platform 2.0: what the customer's applet supports (empty before it joined, or for an old applet). */
  capabilities: string[];
  /** Present with `code`: epoch ms at which it expires, and ms from now. */
  expiresAt?: number;
  expiresInMs?: number;
}

/**
 * Platform 2.0: the session's lifecycle phase changed (`server/src/lifecycle.ts`).
 * Relay → technician only; the applet never sees it.
 */
export interface SessionPhaseChanged {
  t: "session.phase";
  phase: SessionPhase;
  /** Epoch ms of the change. */
  since: number;
}

/**
 * Platform 2.0: connection health, measured by the relay with WebSocket
 * ping/pong on each leg of an active session (no applet change: every
 * WebSocket client answers a ping). Relay → technician only. Null until the
 * first measurement on that leg.
 */
export interface SessionHealth {
  t: "session.health";
  /** Relay ↔ customer applet round trip, ms. */
  hostRttMs: number | null;
  /** Relay ↔ this console round trip, ms. */
  agentRttMs: number | null;
}

/** Multi-session: the stored transcript of one session, sent after `session.resumed`. */
export interface ChatHistory {
  t: "chat.history";
  messages: ChatMessage[];
}

export interface HostConnectRequest {
  t: "host.connectRequest";
  agentName: string;
}

export interface ConsentResult {
  t: "consent.result";
  accepted: boolean;
  /** Platform 2.0 (to the technician only): the phase after an acceptance. */
  phase?: SessionPhase;
}

export interface HostInfo {
  machine: string;
  user: string;
  os: string;
}

export interface PeerJoined {
  t: "peer.joined";
  role: Role;
  info?: HostInfo;
  /** Platform 2.0 (to the technician only): what the customer's applet supports. */
  capabilities?: string[];
  protocolVersion?: number;
  /** Platform 2.0 (to the technician only): the phase after the customer joined. */
  phase?: SessionPhase;
}

export interface PeerLeft {
  t: "peer.left";
  role: Role;
}

export interface ProtocolError {
  t: "error";
  code: ErrorCode;
  message: string;
  /** Platform 2.0: the transfer (`tid`) or request (`rid`) a feature refusal is about. */
  tid?: string;
  rid?: string;
  /**
   * Feature Batch 2: for a chat-specific refusal (`chat_too_long`,
   * `chat_rate_limited`, `invalid_url`), the `clientId` of the message that was
   * refused, so the sender's UI can mark that exact pending bubble failed
   * instead of guessing which one. Absent for every other error code.
   */
  clientId?: string;
  /** `session_limit` only: the technician's effective limit and their live-session count. */
  maxSessions?: number;
  activeSessions?: number;
}

/**
 * The canonical chat record (Feature Batch 2), server-assigned and sent to
 * both the peer and back to the sender — only AFTER it has been stored in the
 * session transcript. `id` is `"<session uuid>.<seq>"`, monotonic per session,
 * so it also serves as an ordering/de-dup key on the receiving end.
 */
export interface ChatMessage {
  t: "chat.message";
  id: string;
  senderRole: Role;
  kind: ChatKind;
  text?: string;
  url?: string;
  label?: string;
  ts: number;
  clientId?: string;
}

export type ServerMessage =
  | SessionCreated
  | SessionResumed
  | SessionPhaseChanged
  | SessionHealth
  | ChatHistory
  | HostConnectRequest
  | ConsentResult
  | PeerJoined
  | PeerLeft
  | ChatMessage
  | ProtocolError;

export type AnyMessage = AgentMessage | HostMessage | ServerMessage;

/* ------------------------------------------------------------------- binary frames */

/** `[0x01][jpeg bytes]` — full frame. */
export const FRAME_FULL = 0x01;

/** `[0x02][x:u16][y:u16][w:u16][h:u16][jpeg bytes]` — dirty rect (Phase 3.3). */
export const FRAME_DIRTY_RECT = 0x02;

/** Byte length of the `[0x02]` header, big-endian, tag byte included. */
export const DIRTY_RECT_HEADER_BYTES = 9;

/* ------------------------------------------------------------------------ narrowing */

export function isAgentMessage(m: AnyMessage): m is AgentMessage {
  return m.t.startsWith("agent.");
}

export function isHostMessage(m: AnyMessage): m is HostMessage {
  return m.t.startsWith("host.") && m.t !== "host.connectRequest";
}

/** Actions that change the customer's machine, and so are gated by Hold. */
export function isRemoteAction(m: AnyMessage): boolean {
  return m.t === "agent.input" || m.t === "agent.exec" || m.t === "agent.requestElevation";
}

export function isCredentialElevation(
  m: AnyMessage,
): m is AgentRequestElevationCredential {
  return m.t === "agent.requestElevation" && m.mode === "credential";
}

/* --------------------------------------------------------------- chat (Feature Batch 2) */

export const MAX_CHAT_TEXT_LENGTH = 4000;
export const MAX_CHAT_URL_LENGTH = 2000;
export const MAX_CHAT_LABEL_LENGTH = 200;
export const MAX_NOTES_LENGTH = 10_000;

/**
 * `http:`/`https:` only, parsed with `URL` rather than a regex — a scheme like
 * `javascript:`, `data:`, `file:` or `vbscript:` is refused outright (§7A).
 * Never used to decide whether to open anything: the customer always clicks it
 * themselves.
 */
export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CHAT_URL_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** The registrable host only — never the path or query string (audit "without unnecessary message content"). */
export function urlDomain(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
