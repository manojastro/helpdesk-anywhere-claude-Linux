/**
 * Append-only JSONL audit log (PLAN 1.6, CLAUDE.md constraint #5).
 *
 * Records session lifecycle, consent decisions, elevation attempts and every
 * executed script. Written to a mounted volume so it survives container restarts.
 *
 * SECURITY: `redact()` below is the single choke point that keeps credentials out
 * of the log (CLAUDE.md constraint #6, PLAN 5.2c rule 2). Every write goes through
 * it, so a future verbose-logging change cannot leak a password by accident.
 */

import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";

export type AuditEvent =
  | "session.created"
  | "session.joined"
  | "session.consent"
  | "session.ended"
  | "join.rejected"
  | "elevation.requested"
  | "elevation.result"
  | "input.sas"
  | "exec.requested"
  | "exec.result";

/** Field names whose values must never reach disk, matched case-insensitively. */
const REDACTED_KEYS = new Set(["password", "pass", "pwd", "secret", "credential"]);

const REDACTED = "[redacted]";

/**
 * Deep-copy `value`, replacing any property whose key is credential-ish with a
 * placeholder. Applied to every audit record before serialisation.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v);
  }
  return out;
}

let ready: Promise<void> | undefined;

function ensureDir(): Promise<void> {
  ready ??= mkdir(config.auditDir, { recursive: true }).then(() => undefined);
  return ready;
}

function logPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(config.auditDir, `audit-${day}.jsonl`);
}

/**
 * Prove at startup that the audit log is actually writable.
 *
 * CLAUDE.md constraint #5 makes the audit log non-negotiable, and a tool that
 * silently cannot audit is worse than one that refuses to start: the operator
 * believes there is a record and there is not. This was not theoretical — the
 * first containerised run wrote nothing at all, because the bind-mounted host
 * directory belonged to a different uid than the container user, and the only
 * evidence was one line on stderr among the startup noise.
 *
 * Throws if the directory cannot be written; `index.ts` exits on that.
 */
export async function verifyAuditWritable(): Promise<void> {
  await ensureDir();
  const probe = path.join(config.auditDir, ".write-probe");
  await appendFile(probe, "", "utf8");
  await rm(probe, { force: true });
}

/**
 * Append one audit record. Never throws — an audit failure must not take the
 * session down, but it is surfaced on stderr so it cannot pass unnoticed.
 */
export async function audit(
  event: AuditEvent,
  code: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const record = {
    ts: new Date().toISOString(),
    event,
    code,
    ...(redact(detail) as Record<string, unknown>),
  };

  try {
    await ensureDir();
    await appendFile(logPath(), `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error("[audit] write failed:", err instanceof Error ? err.message : err);
  }
}
