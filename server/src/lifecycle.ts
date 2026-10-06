/**
 * Server-side session lifecycle (Technician Platform 2.0, Phase 1).
 *
 * The relay's `Session.state` (`waiting_for_host → waiting_for_consent → active
 * → ended`) is what the consent gate and every relay rule key off, and it is
 * deliberately left exactly as it was. Hold, technician reconnect and "the
 * technician is actually driving" used to live beside it as separate flags with
 * no single name for where a session is. This module gives every session one
 * explicit, validated PHASE on top of those, so the technician console, the
 * admin portal and the stored record all agree on a single answer.
 *
 * Rules:
 *   * Every change goes through `transition()`, which checks the table below.
 *     An invalid transition is refused (the phase does not change), logged and
 *     audited — it can only come from a relay bug, never from a client, because
 *     no client message names a phase.
 *   * `RECONNECTING` remembers the phase it interrupted. Things that happen while
 *     the technician is away (the customer consenting, say) move that remembered
 *     phase, validated against the same table, and the session returns to it when
 *     the technician resumes.
 *   * Terminal phases (`ENDED`, `EXPIRED`, `DECLINED`, `FAILED`) are final.
 *
 * Phases from the 2.0 brief deliberately not used yet: `CONNECTING` (the relay
 * cannot observe a gap between the applet's `host.join` and the consent prompt —
 * it sends the prompt in the same turn), `DISCONNECTED` (customer-side network
 * recovery, Phase 3) and `TRANSFERRED` (Phase 5). Adding one is a row in
 * `TRANSITIONS` plus the migration's CHECK constraint.
 */

export const PHASES = [
  "CREATED",
  "WAITING",
  "CONSENT_PENDING",
  "CONNECTED",
  "CONTROLLING",
  "ON_HOLD",
  "RECONNECTING",
  "ENDED",
  "EXPIRED",
  "DECLINED",
  "FAILED",
] as const;

export type SessionPhase = (typeof PHASES)[number];

export const TERMINAL_PHASES: ReadonlySet<SessionPhase> = new Set(["ENDED", "EXPIRED", "DECLINED", "FAILED"]);

/** Allowed next phases. Anything absent is an invalid transition. */
export const TRANSITIONS: Readonly<Record<SessionPhase, readonly SessionPhase[]>> = {
  CREATED: ["WAITING", "FAILED", "ENDED"],
  WAITING: ["CONSENT_PENDING", "RECONNECTING", "EXPIRED", "ENDED", "FAILED"],
  CONSENT_PENDING: ["CONNECTED", "DECLINED", "RECONNECTING", "ENDED"],
  CONNECTED: ["CONTROLLING", "ON_HOLD", "RECONNECTING", "ENDED"],
  CONTROLLING: ["ON_HOLD", "RECONNECTING", "ENDED"],
  ON_HOLD: ["CONNECTED", "RECONNECTING", "ENDED"],
  // Leaving RECONNECTING returns to the remembered phase (see `resume`), or ends.
  RECONNECTING: ["WAITING", "CONSENT_PENDING", "CONNECTED", "ON_HOLD", "ENDED", "EXPIRED", "DECLINED", "FAILED"],
  ENDED: [],
  EXPIRED: [],
  DECLINED: [],
  FAILED: [],
};

/** The lifecycle fields a session carries. */
export interface Lifecycle {
  phase: SessionPhase;
  /** Epoch ms of the last phase change. */
  phaseSince: number;
  /** While `RECONNECTING`: the phase the session returns to on resume. */
  resumePhase: SessionPhase | null;
}

export function newLifecycle(now: number = Date.now()): Lifecycle {
  return { phase: "CREATED", phaseSince: now, resumePhase: null };
}

export function isAllowed(from: SessionPhase, to: SessionPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; from: SessionPhase; to: SessionPhase; deferred: boolean }
  | { ok: false; from: SessionPhase; to: SessionPhase; reason: "same" | "invalid" };

/**
 * Move `lc` to `to` if the table allows it.
 *
 * While `RECONNECTING`, a non-terminal target updates the remembered phase
 * instead (`deferred: true`); the visible phase stays `RECONNECTING`. A terminal
 * target ends the session from wherever it is.
 */
export function transition(lc: Lifecycle, to: SessionPhase, now: number = Date.now()): TransitionResult {
  const from = lc.phase;

  if (from === "RECONNECTING" && to !== "RECONNECTING" && !TERMINAL_PHASES.has(to)) {
    const inner = lc.resumePhase ?? "WAITING";
    if (inner === to) return { ok: false, from: inner, to, reason: "same" };
    if (!isAllowed(inner, to) || to === "CONTROLLING") return { ok: false, from: inner, to, reason: "invalid" };
    lc.resumePhase = to;
    return { ok: true, from: inner, to, deferred: true };
  }

  if (from === to) return { ok: false, from, to, reason: "same" };
  if (!isAllowed(from, to)) return { ok: false, from, to, reason: "invalid" };

  if (to === "RECONNECTING") lc.resumePhase = from === "CONTROLLING" ? "CONNECTED" : from;
  else lc.resumePhase = null;
  lc.phase = to;
  lc.phaseSince = now;
  return { ok: true, from, to, deferred: false };
}

/**
 * Leave `RECONNECTING` for the remembered phase. A technician who comes back is
 * not "controlling" until they next send input, so `CONTROLLING` resumes as
 * `CONNECTED` (`transition` already stored it that way).
 */
export function resume(lc: Lifecycle, now: number = Date.now()): TransitionResult {
  if (lc.phase !== "RECONNECTING") return { ok: false, from: lc.phase, to: lc.phase, reason: "same" };
  const to = lc.resumePhase ?? "WAITING";
  lc.phase = to;
  lc.phaseSince = now;
  lc.resumePhase = null;
  return { ok: true, from: "RECONNECTING", to, deferred: false };
}

/** The terminal phase an end reason maps to. */
export function terminalPhaseFor(reason: string): SessionPhase {
  switch (reason) {
    case "customer_declined": return "DECLINED";
    case "code_expired": return "EXPIRED";
    case "storage_unavailable": return "FAILED";
    default: return "ENDED";
  }
}

/** Short, human labels for UIs and reports. */
export const PHASE_LABELS: Readonly<Record<SessionPhase, string>> = {
  CREATED: "Created",
  WAITING: "Waiting for customer",
  CONSENT_PENDING: "Waiting for consent",
  CONNECTED: "Connected",
  CONTROLLING: "Controlling",
  ON_HOLD: "On hold",
  RECONNECTING: "Reconnecting",
  ENDED: "Ended",
  EXPIRED: "Expired",
  DECLINED: "Declined",
  FAILED: "Failed",
};
