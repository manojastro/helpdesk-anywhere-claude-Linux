/**
 * In-memory store of LIVE sessions (PLAN 1.2): the sockets, the pairing code and
 * the relay state. The durable record of every session — permanent UUID,
 * timeline, chat, notes — is in PostgreSQL (`records.ts`); this map only holds
 * what cannot outlive the process anyway, and a restart reconciles the rows it
 * leaves behind.
 *
 * Owns code generation, the single-use burn, TTL expiry and the `host.join`
 * rate limiter. It deliberately does *not* touch sockets beyond holding the
 * references: notifying peers and closing them is `signaling.ts`'s job, so
 * there is exactly one teardown path and no double-close.
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import type { WebSocket } from "ws";

import { config } from "./config.js";
import { newLifecycle, type Lifecycle } from "./lifecycle.js";
import {
  FRAME_FULL,
  type ChatMessage,
  type DesktopName,
  type ErrorCode,
  type HostInfo,
  type SessionState,
} from "./protocol.js";

/** The authenticated technician who owns a session — from the server-side identity, never the browser. */
export interface SessionOwner {
  orgId: string;
  userId: string;
  teamId: string | null;
  displayName: string;
  agentCode: string | null;
}

export interface Session {
  /** Permanent identifier (the `sessions.id` row). Never the pairing code. */
  id: string;
  /** Short-lived pairing secret, single-use; never stored or logged. */
  code: string;
  orgId: string;
  agentUserId: string;
  teamId: string | null;
  /** Verified display name the customer's consent dialog shows. */
  agentName: string;
  agentCode: string | null;
  state: SessionState;
  agentWs: WebSocket | null;
  hostWs: WebSocket | null;
  hostInfo: HostInfo | null;
  createdAt: number;
  consentedAt: number | null;
  /** Elevation attempts so far, all modes (PLAN 5.2c rule 6). */
  elevationAttempts: number;
  /**
   * True while the agent has put the session on hold (Feature Batch 1). The
   * session stays `active`; only the agent→host action channel is closed. Held
   * lives here, not in the browser, because a hold the relay does not enforce is
   * not a hold.
   */
  held: boolean;
  /** Monotonic per-session sequence, the basis of `chat.message`'s `id` (Feature Batch 2). */
  chatSeq: number;
  /**
   * Recently-seen `clientId`s → the canonical message they produced, bounded
   * (Feature Batch 2). A resend of the same `clientId` (a client-side retry
   * after a perceived failure) re-sends the stored ack to whichever side
   * resent it instead of forwarding a duplicate to the peer. Insertion order
   * doubles as recency for the eviction below — this is a POC de-dup window,
   * not a durable message store.
   */
  recentChatByClientId: Map<string, ChatMessage>;
  /** Timeline sequence, assigned synchronously as events are observed (`records.ts`). */
  eventSeq: number;
  /** Serialises this session's database writes so they commit in order. */
  writeChain: Promise<void>;
  /** Writes for this session that failed; > 0 marks the record incomplete. */
  persistFailures: number;

  /* ---------------------------------------------------- multi-session */

  /**
   * SHA-256 of the current resume token. The raw token exists only in the
   * owning technician's console; a leaked database, log or admin view cannot be
   * turned into a resume. Rotated on every successful `agent.resume`.
   */
  resumeTokenHash: Buffer;
  /**
   * True once a token has actually been sent to the technician. A socket that
   * drops before that (e.g. during the create's database insert) has nothing to
   * resume with, so its session ends at once instead of holding a slot.
   */
  resumeIssued: boolean;
  /**
   * Set while the technician socket is gone and the session is inside its
   * reconnect grace. `agentWs` is null throughout; the slot stays taken.
   */
  reconnect: { since: number; timer: NodeJS.Timeout } | null;
  /** Successful technician resumes so far. */
  reconnectCount: number;
  /** What the technician socket wants of the video: every frame, or keyframes only. */
  viewPriority: "full" | "preview";
  /** Last keyframe plus the dirty rectangles since — see `noteFrame`. */
  catchUp: CatchUp;
  /** True once the host has reported a successful elevation (drives the resumed console's UI). */
  elevated: boolean;
  /** Last desktop the host reported, so a resumed console shows the UAC banner if one is up. */
  desktop: DesktopName;
  /**
   * True while video frames are being skipped because the technician socket's
   * send buffer is over `VIDEO_HIGH_WATER_BYTES` (audit 2026-10-05, F-09). The
   * next frame sent after it drains replays the catch-up buffer, so the picture
   * is rebuilt rather than left with stale regions.
   */
  videoBehind: boolean;

  /* ------------------------------------------------- platform 2.0 */

  /** Validated lifecycle phase (`lifecycle.ts`). Changed only through `signaling.ts setPhase`. */
  lifecycle: Lifecycle;
  /** Latest relay ↔ applet WebSocket round trip, ms (null until measured). */
  hostRttMs: number | null;
  /** Latest relay ↔ technician-console round trip, ms (null until measured). */
  agentRttMs: number | null;
}

/**
 * Bytes queued on a technician socket above which video frames are skipped
 * rather than queued. Without a bound, a slow technician link makes the relay
 * buffer every frame the applet sends, without limit, in server memory.
 */
export const VIDEO_HIGH_WATER_BYTES = 4 * 1024 * 1024;

/**
 * The frames a technician would need to rebuild the CURRENT picture from
 * nothing: the most recent full keyframe and every dirty rectangle after it,
 * in order. Replaying them is idempotent — each rect replaces its region — so
 * sending them to a console that already has some of them is harmless.
 *
 * Buffers are the relay's own references to frames it was forwarding anyway;
 * nothing is copied or decoded. Bounded: past `CATCH_UP_MAX_BYTES` the rects
 * are dropped and the keyframe alone is replayed, which heals at the applet's
 * next keyframe (at most 5 s away, `ScreenStreamer.KeyframeInterval`).
 */
export interface CatchUp {
  keyframe: Buffer | null;
  rects: Buffer[];
  bytes: number;
  overflowed: boolean;
}

/** Per-session bound on the catch-up buffer (keyframe + rects). */
export const CATCH_UP_MAX_BYTES = 3 * 1024 * 1024;

/** Record one host video frame in the session's catch-up buffer. */
export function noteFrame(session: Session, frame: Buffer): void {
  const c = session.catchUp;
  if (frame.length === 0) return;
  if (frame[0] === FRAME_FULL) {
    c.keyframe = frame;
    c.rects = [];
    c.bytes = frame.length;
    c.overflowed = false;
    return;
  }
  // A rect with no keyframe under it cannot rebuild anything; nor can one
  // after the buffer already gave up until the next keyframe.
  if (c.keyframe === null || c.overflowed) return;
  if (c.bytes + frame.length > CATCH_UP_MAX_BYTES) {
    c.rects = [];
    c.bytes = c.keyframe.length;
    c.overflowed = true;
    return;
  }
  c.rects.push(frame);
  c.bytes += frame.length;
}

/** The frames to replay, oldest first: keyframe, then rects. Empty before the first keyframe. */
export function catchUpFrames(session: Session): Buffer[] {
  const c = session.catchUp;
  return c.keyframe === null ? [] : [c.keyframe, ...c.rects];
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Bound on `Session.recentChatByClientId` — a small window, not a transcript. */
const MAX_RECENT_CHAT_IDS = 20;

/** Why a `host.join` was refused. Mirrors `shared/protocol.md` error codes. */
export type ClaimError = Extract<ErrorCode, "bad_code" | "code_expired">;

/** Thrown by `create()` when the live-session ceiling is reached. */
export class SessionCapacityError extends Error {
  constructor() {
    super("session capacity reached");
    this.name = "SessionCapacityError";
  }
}

export type ClaimResult =
  | { ok: true; session: Session }
  | { ok: false; error: ClaimError };

/** Codes are 6 digits including leading zeros, so the full 1e6 space is usable. */
const CODE_SPACE = 1_000_000;
const CODE_DIGITS = 6;

/** Give up rather than spin if the space is somehow saturated. */
const MAX_CODE_ATTEMPTS = 100;

/**
 * Sliding-window counter, keyed by client IP.
 *
 * A refused attempt is *not* recorded, so a caller that keeps hammering stays
 * refused until the window slides rather than extending its own ban forever.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True if this attempt is allowed (and counted); false if rate-limited. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop keys with no hits left in the window. Called from the 60s sweep. */
  sweep(now: number = Date.now()): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /** `host.join` attempts per IP per minute (PLAN 1.2). */
  readonly joinLimiter = new RateLimiter(config.joinAttemptsPerMinute, 60_000);

  /**
   * `agent.create` calls per IP per minute (security review, 2026-09-03).
   *
   * Every create writes an audit record and holds a code until it expires, so an
   * unlimited create is an unbounded write to both the session map and the audit
   * file — reachable by anyone at all whenever CONSOLE_PASSWORD is unset.
   */
  readonly createLimiter = new RateLimiter(config.createAttemptsPerMinute, 60_000);

  /**
   * Chat messages allowed per session per 10s window (Feature Batch 2).
   * Generous for a human typing, tight enough to stop a flood: chat is not
   * gated by Hold, so this is the only thing standing between an unbounded
   * client and an unbounded number of forwarded frames and audit writes.
   */
  readonly chatLimiter = new RateLimiter(30, 10_000);

  /**
   * `agent.resume` attempts per technician per minute (keyed by user id: every
   * resume is already signed in, and technicians often share an office IP). The
   * token is 256 bits, so this is not what stops guessing; it keeps a
   * misbehaving console from spinning.
   */
  readonly resumeLimiter = new RateLimiter(config.resumeAttemptsPerMinute, 60_000);

  /**
   * Allocate a session with a fresh 6-digit code from `crypto.randomInt`,
   * retrying on collision.
   */
  create(agentWs: WebSocket, owner: SessionOwner, now: number = Date.now()): Session {
    if (this.sessions.size >= config.maxLiveSessions) {
      throw new SessionCapacityError();
    }
    const code = this.allocateCode();

    const session: Session = {
      id: randomUUID(),
      code,
      orgId: owner.orgId,
      agentUserId: owner.userId,
      teamId: owner.teamId,
      agentName: owner.displayName,
      agentCode: owner.agentCode,
      state: "waiting_for_host",
      agentWs,
      hostWs: null,
      hostInfo: null,
      createdAt: now,
      consentedAt: null,
      elevationAttempts: 0,
      held: false,
      chatSeq: 0,
      recentChatByClientId: new Map(),
      eventSeq: 0,
      writeChain: Promise.resolve(),
      persistFailures: 0,
      resumeTokenHash: Buffer.alloc(32),
      resumeIssued: false,
      reconnect: null,
      reconnectCount: 0,
      viewPriority: "full",
      catchUp: { keyframe: null, rects: [], bytes: 0, overflowed: false },
      elevated: false,
      desktop: "Default",
      videoBehind: false,
      lifecycle: newLifecycle(now),
      hostRttMs: null,
      agentRttMs: null,
    };

    this.sessions.set(code, session);
    return session;
  }

  private allocateCode(): string {
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const code = String(randomInt(0, CODE_SPACE)).padStart(CODE_DIGITS, "0");
      if (!this.sessions.has(code)) return code;
    }
    throw new Error("could not allocate a free session code");
  }

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  /** Look a live session up by its permanent id (admin actions never see codes). */
  byId(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  /** Every live session — for the admin "live sessions" view and shutdown. */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Live sessions owned by one technician, for the concurrent-session limit.
   *
   * Every entry in the map counts — waiting for a customer, waiting for
   * consent, active, and inside the technician-reconnect grace. Ended, declined
   * and expired sessions have already left the map (`end`, `sweep`), so they
   * never do. Callers MUST compare and `create()` in the same synchronous turn
   * (no `await` between): Node runs one message handler at a time, so two
   * simultaneous requests can never both see "3 of 4" and both become the
   * fourth. `signaling.ts handleAgentCreate` relies on exactly that.
   */
  countForUser(userId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.agentUserId === userId) n++;
    return n;
  }

  /** Every live session one technician owns. */
  forUser(userId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.agentUserId === userId);
  }

  /** Issue a fresh resume token for `session`, replacing any previous one. Returns the raw token. */
  issueResumeToken(session: Session): string {
    const token = randomBytes(32).toString("base64url");
    session.resumeTokenHash = hashToken(token);
    session.resumeIssued = true;
    return token;
  }

  /** Constant-time check of a presented resume token. */
  resumeTokenMatches(session: Session, token: unknown): boolean {
    if (!session.resumeIssued || typeof token !== "string" || token.length === 0 || token.length > 128) return false;
    return timingSafeEqual(hashToken(token), session.resumeTokenHash);
  }

  /**
   * Record the canonical message a `clientId` produced, evicting the oldest
   * entry once the window is full (Feature Batch 2). `Map` preserves
   * insertion order, so the first key is always the oldest.
   */
  rememberChat(session: Session, clientId: string, message: ChatMessage): void {
    session.recentChatByClientId.set(clientId, message);
    if (session.recentChatByClientId.size > MAX_RECENT_CHAT_IDS) {
      const oldest = session.recentChatByClientId.keys().next().value;
      if (oldest !== undefined) session.recentChatByClientId.delete(oldest);
    }
  }

  /**
   * Burn the code (single-use) and attach the host socket.
   *
   * A code is claimable exactly once: any later `host.join` with the same code
   * sees a session that has left `waiting_for_host` and is refused `bad_code`,
   * which is also what an unknown code returns — a guesser learns nothing.
   */
  claim(
    code: string,
    hostWs: WebSocket,
    info: HostInfo,
    now: number = Date.now(),
  ): ClaimResult {
    const session = this.sessions.get(code);

    if (!session || session.state !== "waiting_for_host") {
      return { ok: false, error: "bad_code" };
    }
    if (this.isExpired(session, now)) {
      return { ok: false, error: "code_expired" };
    }

    session.state = "waiting_for_consent";
    session.hostWs = hostWs;
    session.hostInfo = info;
    return { ok: true, session };
  }

  /** Only an *unused* code expires; a paired session lives until it ends. */
  private isExpired(session: Session, now: number): boolean {
    return (
      session.state === "waiting_for_host" &&
      now - session.createdAt > config.sessionCodeTtlMs
    );
  }

  /**
   * Mark the session ended and drop it from the map. Returns the session so the
   * caller can notify and close the sockets; returns undefined if it was already
   * gone, which makes teardown idempotent.
   */
  end(code: string): Session | undefined {
    const session = this.sessions.get(code);
    if (!session) return undefined;

    session.state = "ended";
    this.clearReconnect(session);
    // Drop the frame references now rather than when the object is collected.
    session.catchUp = { keyframe: null, rects: [], bytes: 0, overflowed: false };
    this.sessions.delete(code);
    return session;
  }

  /** Cancel a pending reconnect-grace timer, if any. */
  clearReconnect(session: Session): void {
    if (session.reconnect !== null) {
      clearTimeout(session.reconnect.timer);
      session.reconnect = null;
    }
  }

  /**
   * Sweep expired and ended sessions (PLAN 1.2, 60s timer). Returns the sessions
   * whose codes timed out so the caller can tell the waiting agent why.
   */
  sweep(now: number = Date.now()): Session[] {
    const expired: Session[] = [];

    for (const session of [...this.sessions.values()]) {
      if (session.state === "ended") {
        this.sessions.delete(session.code);
      } else if (this.isExpired(session, now)) {
        session.state = "ended";
        this.clearReconnect(session);
        this.sessions.delete(session.code);
        expired.push(session);
      }
    }

    this.joinLimiter.sweep(now);
    this.createLimiter.sweep(now);
    this.chatLimiter.sweep(now);
    this.resumeLimiter.sweep(now);
    return expired;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessions = new SessionStore();
