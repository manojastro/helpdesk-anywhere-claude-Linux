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

import { randomInt, randomUUID } from "node:crypto";

import type { WebSocket } from "ws";

import { config } from "./config.js";
import type { ChatMessage, ErrorCode, HostInfo, SessionState } from "./protocol.js";

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

  /** Live sessions owned by one technician, for the concurrent-session limit. */
  countForUser(userId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.agentUserId === userId) n++;
    return n;
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
    this.sessions.delete(code);
    return session;
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
        this.sessions.delete(session.code);
        expired.push(session);
      }
    }

    this.joinLimiter.sweep(now);
    this.createLimiter.sweep(now);
    this.chatLimiter.sweep(now);
    return expired;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessions = new SessionStore();
