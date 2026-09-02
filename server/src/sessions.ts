/**
 * In-memory session store (PLAN 1.2). No database for the POC.
 *
 * Phase 0 scaffold: types and the store shell. The pairing logic — code
 * generation with collision retry, single-use burn on host join, TTL expiry,
 * join rate limiting and the 60s sweep — lands in Phase 1.2.
 */

import type { WebSocket } from "ws";

import type { HostInfo, SessionState } from "./protocol.js";

export interface Session {
  code: string;
  state: SessionState;
  agentWs: WebSocket | null;
  hostWs: WebSocket | null;
  hostInfo: HostInfo | null;
  createdAt: number;
  consentedAt: number | null;
  /** Credential-mode elevation attempts so far (PLAN 5.2c rule 6). */
  elevationAttempts: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /** Phase 1.2: 6-digit code from `crypto.randomInt`, retry on collision. */
  create(_agentWs: WebSocket): Session {
    throw new Error("SessionStore.create: not implemented until Phase 1.2");
  }

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  /** Phase 1.2: burn the code (single-use) and attach the host socket. */
  claim(_code: string, _hostWs: WebSocket, _info: HostInfo): Session {
    throw new Error("SessionStore.claim: not implemented until Phase 1.2");
  }

  /** Phase 1.2: mark ended, close both sockets, drop from the map. */
  end(_code: string, _reason: string): void {
    throw new Error("SessionStore.end: not implemented until Phase 1.2");
  }

  /** Phase 1.2: sweep expired and ended sessions on a 60s timer. */
  sweep(_now: number = Date.now()): void {
    throw new Error("SessionStore.sweep: not implemented until Phase 1.2");
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessions = new SessionStore();
