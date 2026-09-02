/**
 * In-memory session store (PLAN 1.2). No database for the POC.
 *
 * Owns code generation, the single-use burn, TTL expiry and the `host.join`
 * rate limiter. It deliberately does *not* touch sockets beyond holding the
 * references: notifying peers and closing them is `signaling.ts`'s job, so
 * there is exactly one teardown path and no double-close.
 */

import { randomInt } from "node:crypto";

import type { WebSocket } from "ws";

import { config } from "./config.js";
import type { ErrorCode, HostInfo, SessionState } from "./protocol.js";

export interface Session {
  code: string;
  state: SessionState;
  agentWs: WebSocket | null;
  hostWs: WebSocket | null;
  hostInfo: HostInfo | null;
  createdAt: number;
  consentedAt: number | null;
  /** Elevation attempts so far, all modes (PLAN 5.2c rule 6). */
  elevationAttempts: number;
}

/** Why a `host.join` was refused. Mirrors `shared/protocol.md` error codes. */
export type ClaimError = Extract<ErrorCode, "bad_code" | "code_expired">;

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
   * Allocate a session with a fresh 6-digit code from `crypto.randomInt`,
   * retrying on collision.
   */
  create(agentWs: WebSocket, now: number = Date.now()): Session {
    const code = this.allocateCode();

    const session: Session = {
      code,
      state: "waiting_for_host",
      agentWs,
      hostWs: null,
      hostInfo: null,
      createdAt: now,
      consentedAt: null,
      elevationAttempts: 0,
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
    return expired;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessions = new SessionStore();
