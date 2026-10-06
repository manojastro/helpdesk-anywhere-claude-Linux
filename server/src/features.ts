/**
 * Platform 2.0, Phase 2b — the relay half of file transfer, the remote file
 * manager, clipboard text, system information and script cancel.
 *
 * The relay still never touches a desktop or a file: everything here validates,
 * authorises, accounts and records, then forwards the frame verbatim. In
 * particular it NEVER stores or logs file contents or clipboard text — chunks and
 * text pass through, and only names, sizes, paths, hashes and outcomes are kept.
 *
 * Rules, all enforced here regardless of what a console does:
 *   - a feature is only offered to an applet that declared it at join
 *     (`capabilities`); older applets get `not_supported`, never a hang;
 *   - files need the technician's `allowFileTransfer` limit;
 *   - starting anything is a remote action — refused while the session is held;
 *     continuing or cancelling a transfer already running is not;
 *   - every transfer is accounted: declared size ≤ MAX_FILE_TRANSFER_BYTES,
 *     chunks in order, bytes never beyond the declared size, at most
 *     MAX_TRANSFERS_PER_SESSION at once, and each chunk ≤ 48 KiB decoded;
 *   - a transfer dies with the technician's socket (reconnect grace) or the
 *     session, and is recorded as cancelled.
 */

import { randomUUID } from "node:crypto";

import { audit } from "./audit.js";
import type { Principal } from "./auth/permissions.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import { count } from "./observability.js";
import { recordEvent, recordWrite } from "./records.js";
import type { Session } from "./sessions.js";

export const PROTOCOL_VERSION = 2;
export const CAPABILITIES = ["files", "clipboard", "sysinfo", "execCancel", "resume", "transfer", "quality", "monitors"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Raw chunk payload bound: 48 KiB of file data = 65 536 base64 characters. */
export const CHUNK_BYTES = 48 * 1024;
const MAX_CHUNK_B64 = 65_536;
/** Bounded so even 3-byte UTF-8 text stays well inside the 256 KB control-frame cap. */
export const MAX_CLIPBOARD_CHARS = 60_000;
const MAX_PATH = 1024;
const MAX_NAME = 255;

/** Agent messages this module owns, and the applet capability each needs. */
export const AGENT_FEATURES: Readonly<Record<string, Capability>> = {
  "agent.fs.list": "files",
  "agent.fs.mkdir": "files",
  "agent.fs.rename": "files",
  "agent.fs.delete": "files",
  "agent.file.put": "files",
  "agent.file.chunk": "files",
  "agent.file.end": "files",
  "agent.file.get": "files",
  "agent.file.ack": "files",
  "agent.file.cancel": "files",
  "agent.clipboard.set": "clipboard",
  "agent.clipboard.get": "clipboard",
  "agent.sysinfo.get": "sysinfo",
  "agent.exec.cancel": "execCancel",
  "agent.quality": "quality",
};

/** Host messages this module owns. */
export const HOST_FEATURES: ReadonlySet<string> = new Set([
  "host.fs.result", "host.file.ready", "host.file.ack", "host.file.meta", "host.file.chunk",
  "host.file.done", "host.file.error", "host.clipboard.result", "host.sysinfo",
  "host.quality", "host.monitors",
]);

/**
 * Allowed while held: continuations of something already authorised, and a
 * frame-rate change, which acts on nothing on the customer's computer.
 */
const CONTINUATIONS: ReadonlySet<string> = new Set([
  "agent.file.chunk", "agent.file.end", "agent.file.ack", "agent.file.cancel", "agent.exec.cancel",
  "agent.quality",
]);

/** Stream quality profiles and the frame rate each delivers (the applet's FrameRateLimiter). */
export const QUALITY_FPS: Readonly<Record<string, number>> = { high: 10, balanced: 5, low: 2 };
export type QualityProfile = "high" | "balanced" | "low";
const isProfile = (v: unknown): v is QualityProfile => typeof v === "string" && Object.hasOwn(QUALITY_FPS, v);

/** Bounds for a monitor layout: Windows' virtual screen is at most 32 767 px a side. */
const MAX_MONITORS = 16;
const MAX_SCREEN_PX = 32_767;

export interface MonitorRect { index: number; primary: boolean; x: number; y: number; width: number; height: number }
export interface MonitorLayout { width: number; height: number; monitors: MonitorRect[] }

/**
 * A `host.monitors` layout rebuilt field by field, or null. Every rectangle must
 * lie inside the virtual screen it is reported against, so a console can frame
 * it without further checks.
 */
export function parseMonitors(msg: Record<string, unknown>): MonitorLayout | null {
  const int = (v: unknown, min: number, max: number): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
  const width = int(msg["width"], 1, MAX_SCREEN_PX);
  const height = int(msg["height"], 1, MAX_SCREEN_PX);
  const list = msg["monitors"];
  if (width === null || height === null || !Array.isArray(list) || list.length < 1 || list.length > MAX_MONITORS) return null;
  const monitors: MonitorRect[] = [];
  for (const [i, raw] of list.entries()) {
    if (typeof raw !== "object" || raw === null) return null;
    const m = raw as Record<string, unknown>;
    const x = int(m["x"], 0, width - 1);
    const y = int(m["y"], 0, height - 1);
    const w = int(m["width"], 1, MAX_SCREEN_PX);
    const h = int(m["height"], 1, MAX_SCREEN_PX);
    if (x === null || y === null || w === null || h === null || x + w > width || y + h > height) return null;
    monitors.push({ index: i + 1, primary: m["primary"] === true, x, y, width: w, height: h });
  }
  return { width, height, monitors };
}

export interface Transfer {
  id: string;
  direction: "upload" | "download";
  name: string;
  path: string | null;
  size: number;
  bytes: number;
  seq: number;
  state: "requested" | "active";
  userId: string | null;
  startedAt: number;
}

/** What the relay gives this module: sockets stay in signaling.ts. */
export interface FeatureIo {
  session: Session;
  principal: Principal | null;
  /** Forward the original frame, untouched. */
  forwardToHost(): void;
  forwardToAgent(): void;
  /** Send relay-originated JSON. */
  toAgent(msg: Record<string, unknown>): void;
  toHost(msg: Record<string, unknown>): void;
}

/* ------------------------------------------------------------------- validation */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL_RE.test(v) ? v : null;
}

function rid(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

function decodedLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/* ---------------------------------------------------------------------- records */

function startRow(s: Session, t: Transfer): void {
  recordWrite(s, "file transfer row", () => query(
    `INSERT INTO file_transfers (id, org_id, session_id, user_id, direction, file_name, remote_path, size_bytes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')`,
    [t.id, s.orgId, s.id, t.userId, t.direction, t.name, t.path, t.size],
  ));
}

/**
 * End a transfer once: drop it from the session, update its row, put it on the
 * timeline and in the security log. Names, sizes, paths and hashes only.
 */
export function finishTransfer(
  s: Session,
  id: string,
  status: "completed" | "failed" | "cancelled",
  detail: { error?: string; sha256?: string } = {},
): void {
  const t = s.transfers.get(id);
  if (!t) return;
  s.transfers.delete(id);
  count("hda_file_transfers_total", { direction: t.direction, status });
  const error = detail.error?.slice(0, 300) ?? null;
  const sha256 = detail.sha256 && /^[0-9a-f]{64}$/.test(detail.sha256) ? detail.sha256 : null;
  if (t.state === "active" || t.direction === "upload") {
    recordWrite(s, "file transfer end", () => query(
      `UPDATE file_transfers SET status = $3, bytes_done = $4, error = $5, sha256 = $6, ended_at = now(),
              remote_path = COALESCE($7, remote_path), size_bytes = $8
        WHERE id = $1 AND org_id = $2`,
      [t.id, s.orgId, status, t.bytes, error, sha256, t.path, t.size],
    ));
  }
  const event = { direction: t.direction, name: t.name, size: t.size, status, path: t.path, ...(error ? { error } : {}), ...(sha256 ? { sha256 } : {}) };
  void recordEvent(s, "file.transfer", t.direction === "upload" ? "agent" : "customer", event, t.userId);
  void audit("file.transfer", s.id, { transferId: t.id, ...event, bytes: t.bytes, user: t.userId });
}

/** The technician socket went away, or the session is ending: nothing in flight survives it. */
export function cancelAllTransfers(io: Pick<FeatureIo, "session" | "toHost">, reason: string): void {
  for (const t of [...io.session.transfers.values()]) {
    io.toHost({ t: "agent.file.cancel", tid: t.id });
    finishTransfer(io.session, t.id, "cancelled", { error: reason });
  }
}

/* ----------------------------------------------------------------- agent → host */

/**
 * Handle one feature message from the technician. Returns true if it was a
 * feature message (handled, forwarded or refused); false if not ours.
 */
export function handleAgentFeature(io: FeatureIo, msg: Record<string, unknown>): boolean {
  const type = String(msg["t"]);
  const cap = AGENT_FEATURES[type];
  if (cap === undefined) return false;
  const s = io.session;
  const p = io.principal;
  const refuse = (code: string, message: string): true => {
    io.toAgent({ t: "error", code, message, ...(typeof msg["tid"] === "string" ? { tid: msg["tid"] } : {}),
      ...(typeof msg["rid"] === "string" ? { rid: msg["rid"] } : {}), ...(typeof msg["id"] === "string" ? { rid: msg["id"] } : {}) });
    return true;
  };

  if (cap === "files" && !config.enableFileManager) {
    return refuse("feature_disabled", "File transfer is switched off on this server.");
  }
  if (!s.hostCaps.has(cap)) {
    return refuse("not_supported", "The customer's Helpdesk Anywhere app does not support this yet. Ask them to download it again from the join link.");
  }
  if (s.held && !CONTINUATIONS.has(type)) {
    return refuse("session_held", "The session is on hold. Resume it first.");
  }
  if (cap === "files" && !p?.limits.allowFileTransfer) {
    void audit("fs.changed", s.id, { op: type, refused: "not_permitted", user: p?.userId ?? null });
    return refuse("not_permitted", "Your account is not allowed to transfer or manage files.");
  }

  switch (type) {
    case "agent.fs.list": {
      const path = msg["path"] === "" ? "" : text(msg["path"], MAX_PATH);
      if (!rid(msg["rid"]) || path === null) return refuse("protocol", "Invalid folder request.");
      void audit("fs.list", s.id, { path, user: p?.userId ?? null });
      io.forwardToHost();
      return true;
    }
    case "agent.fs.mkdir":
    case "agent.fs.delete": {
      const path = text(msg["path"], MAX_PATH);
      if (!rid(msg["rid"]) || path === null) return refuse("protocol", "Invalid path.");
      io.forwardToHost();
      return true;
    }
    case "agent.fs.rename": {
      const path = text(msg["path"], MAX_PATH);
      const newName = text(msg["newName"], MAX_NAME);
      if (!rid(msg["rid"]) || path === null || newName === null || /[\\/]/.test(newName)) return refuse("protocol", "Invalid rename.");
      io.forwardToHost();
      return true;
    }

    case "agent.file.put": {
      const id = typeof msg["tid"] === "string" && UUID_RE.test(msg["tid"]) ? msg["tid"] : null;
      const name = text(msg["name"], MAX_NAME);
      const size = msg["size"];
      const dir = msg["dir"] === undefined || msg["dir"] === "" ? "" : text(msg["dir"], MAX_PATH);
      if (!id || !name || /[\\/]/.test(name) || dir === null || typeof size !== "number" || !Number.isInteger(size) || size < 0) {
        return refuse("protocol", "Invalid upload.");
      }
      if (s.transfers.has(id)) return refuse("protocol", "Duplicate transfer id.");
      if (size > config.maxFileTransferBytes) {
        return refuse("transfer_refused", `Files over ${Math.floor(config.maxFileTransferBytes / 1048576)} MB cannot be transferred.`);
      }
      if (s.transfers.size >= config.maxTransfersPerSession) {
        return refuse("transfer_refused", `At most ${config.maxTransfersPerSession} transfers can run at once in a session.`);
      }
      const t: Transfer = { id, direction: "upload", name, path: dir || null, size, bytes: 0, seq: 0, state: "requested", userId: p?.userId ?? null, startedAt: Date.now() };
      s.transfers.set(id, t);
      startRow(s, t);
      io.forwardToHost();
      return true;
    }
    case "agent.file.chunk": {
      const t = typeof msg["tid"] === "string" ? s.transfers.get(msg["tid"]) : undefined;
      const data = msg["data"];
      if (!t || t.direction !== "upload" || t.state !== "active") return refuse("protocol", "Unknown or inactive upload.");
      if (typeof data !== "string" || data.length > MAX_CHUNK_B64 || data.length % 4 !== 0 || !B64_RE.test(data) || msg["seq"] !== t.seq + 1) {
        io.toHost({ t: "agent.file.cancel", tid: t.id });
        finishTransfer(s, t.id, "failed", { error: "malformed or out-of-order chunk" });
        return refuse("protocol", "Malformed or out-of-order chunk; the upload was stopped.");
      }
      const n = decodedLength(data);
      if (t.bytes + n > t.size) {
        io.toHost({ t: "agent.file.cancel", tid: t.id });
        finishTransfer(s, t.id, "failed", { error: "more data than declared" });
        return refuse("protocol", "More data than declared; the upload was stopped.");
      }
      t.bytes += n;
      t.seq += 1;
      io.forwardToHost();
      return true;
    }
    case "agent.file.end": {
      const t = typeof msg["tid"] === "string" ? s.transfers.get(msg["tid"]) : undefined;
      if (!t || t.direction !== "upload" || t.state !== "active") return refuse("protocol", "Unknown or inactive upload.");
      if (t.bytes !== t.size) {
        io.toHost({ t: "agent.file.cancel", tid: t.id });
        finishTransfer(s, t.id, "failed", { error: "fewer bytes than declared" });
        return refuse("protocol", "The upload ended early and was stopped.");
      }
      io.forwardToHost();
      return true;
    }
    case "agent.file.get": {
      const id = typeof msg["tid"] === "string" && UUID_RE.test(msg["tid"]) ? msg["tid"] : null;
      const path = text(msg["path"], MAX_PATH);
      if (!id || path === null) return refuse("protocol", "Invalid download.");
      if (s.transfers.has(id)) return refuse("protocol", "Duplicate transfer id.");
      if (s.transfers.size >= config.maxTransfersPerSession) {
        return refuse("transfer_refused", `At most ${config.maxTransfersPerSession} transfers can run at once in a session.`);
      }
      const name = path.split(/[\\/]/).pop() || path;
      const t: Transfer = { id, direction: "download", name: name.slice(0, MAX_NAME), path, size: 0, bytes: 0, seq: 0, state: "requested", userId: p?.userId ?? null, startedAt: Date.now() };
      s.transfers.set(id, t);
      io.forwardToHost();
      return true;
    }
    case "agent.file.ack": {
      const t = typeof msg["tid"] === "string" ? s.transfers.get(msg["tid"]) : undefined;
      if (!t || t.direction !== "download") return true;  // a late ack after the end is harmless
      io.forwardToHost();
      return true;
    }
    case "agent.file.cancel": {
      const id = typeof msg["tid"] === "string" ? msg["tid"] : "";
      if (s.transfers.has(id)) {
        io.forwardToHost();
        finishTransfer(s, id, "cancelled", { error: "cancelled by technician" });
      }
      return true;
    }

    case "agent.clipboard.set": {
      const value = msg["text"];
      if (!rid(msg["rid"]) || typeof value !== "string" || value.length > MAX_CLIPBOARD_CHARS) {
        return refuse("protocol", `Clipboard text must be at most ${MAX_CLIPBOARD_CHARS} characters.`);
      }
      // The length only — clipboard text is never logged or stored (it can be a password).
      void audit("clipboard.sent", s.id, { length: value.length, user: p?.userId ?? null });
      void recordEvent(s, "clipboard.sent", "agent", { length: value.length }, p?.userId ?? null);
      io.forwardToHost();
      return true;
    }
    case "agent.clipboard.get":
    case "agent.sysinfo.get": {
      if (!rid(msg["rid"])) return refuse("protocol", "Invalid request.");
      io.forwardToHost();
      return true;
    }
    case "agent.quality": {
      if (!isProfile(msg["profile"])) return refuse("protocol", "Unknown stream quality profile.");
      io.toHost({ t: "agent.quality", profile: msg["profile"] });
      return true;
    }
    case "agent.exec.cancel": {
      if (typeof msg["id"] !== "string" || msg["id"].length > 64) return refuse("protocol", "Invalid script id.");
      void audit("exec.cancel", s.id, { id: msg["id"], user: p?.userId ?? null });
      void recordEvent(s, "script.cancelled", "agent", { execId: msg["id"].slice(0, 64) }, p?.userId ?? null);
      io.forwardToHost();
      return true;
    }
  }
  return false;
}

/* ----------------------------------------------------------------- host → agent */

/** Handle one feature message from the applet. Returns true if it was ours. */
export function handleHostFeature(io: FeatureIo, msg: Record<string, unknown>): boolean {
  const type = String(msg["t"]);
  if (!HOST_FEATURES.has(type)) return false;
  const s = io.session;
  const transfer = typeof msg["tid"] === "string" ? s.transfers.get(msg["tid"]) : undefined;

  switch (type) {
    case "host.fs.result": {
      // Record changes the technician made, with the applet's verdict.
      const op = msg["op"];
      if (op === "mkdir" || op === "rename" || op === "delete") {
        const detail = {
          op, ok: msg["ok"] === true,
          path: typeof msg["path"] === "string" ? msg["path"].slice(0, MAX_PATH) : null,
          ...(typeof msg["newName"] === "string" ? { newName: msg["newName"].slice(0, MAX_NAME) } : {}),
          ...(typeof msg["error"] === "string" ? { error: msg["error"].slice(0, 300) } : {}),
        };
        void recordEvent(s, "fs.changed", "agent", detail, s.agentUserId);
        void audit("fs.changed", s.id, detail);
      }
      io.forwardToAgent();
      return true;
    }
    case "host.file.ready": {
      if (!transfer || transfer.direction !== "upload" || transfer.state !== "requested") return true;
      transfer.state = "active";
      if (typeof msg["path"] === "string") transfer.path = msg["path"].slice(0, MAX_PATH);
      io.forwardToAgent();
      return true;
    }
    case "host.file.ack": {
      if (transfer) io.forwardToAgent();
      return true;
    }
    case "host.file.meta": {
      if (!transfer || transfer.direction !== "download" || transfer.state !== "requested") return true;
      const size = msg["size"];
      if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > config.maxFileTransferBytes) {
        io.toHost({ t: "agent.file.cancel", tid: transfer.id });
        io.toAgent({ t: "error", code: "transfer_refused", tid: transfer.id,
          message: `Files over ${Math.floor(config.maxFileTransferBytes / 1048576)} MB cannot be transferred.` });
        s.transfers.delete(transfer.id);
        return true;
      }
      transfer.size = size;
      transfer.state = "active";
      if (typeof msg["name"] === "string" && msg["name"].length > 0) transfer.name = msg["name"].slice(0, MAX_NAME);
      startRow(s, transfer);
      io.forwardToAgent();
      return true;
    }
    case "host.file.chunk": {
      if (!transfer || transfer.direction !== "download" || transfer.state !== "active") return true;
      const data = msg["data"];
      if (typeof data !== "string" || data.length > MAX_CHUNK_B64 || data.length % 4 !== 0 || msg["seq"] !== transfer.seq + 1
          || transfer.bytes + decodedLength(data) > transfer.size) {
        io.toHost({ t: "agent.file.cancel", tid: transfer.id });
        io.toAgent({ t: "host.file.error", tid: transfer.id, error: "The download was malformed and has been stopped." });
        finishTransfer(s, transfer.id, "failed", { error: "malformed download chunk" });
        return true;
      }
      transfer.bytes += decodedLength(data);
      transfer.seq += 1;
      io.forwardToAgent();
      return true;
    }
    case "host.file.done": {
      if (!transfer || transfer.state !== "active") return true;
      if (transfer.bytes !== transfer.size) {
        io.toAgent({ t: "host.file.error", tid: transfer.id, error: "The transfer ended with the wrong size." });
        finishTransfer(s, transfer.id, "failed", { error: "size mismatch" });
        return true;
      }
      io.forwardToAgent();
      finishTransfer(s, transfer.id, "completed", typeof msg["sha256"] === "string" ? { sha256: msg["sha256"].toLowerCase() } : {});
      return true;
    }
    case "host.file.error": {
      if (!transfer) return true;
      io.forwardToAgent();
      finishTransfer(s, transfer.id, "failed", { error: typeof msg["error"] === "string" ? msg["error"] : "failed on the remote computer" });
      return true;
    }
    case "host.clipboard.result": {
      if (msg["op"] === "get" && msg["ok"] === true) {
        const length = typeof msg["text"] === "string" ? msg["text"].length : 0;
        void audit("clipboard.read", s.id, { length });
        void recordEvent(s, "clipboard.read", "agent", { length }, s.agentUserId);
      }
      io.forwardToAgent();
      return true;
    }
    case "host.sysinfo": {
      void recordEvent(s, "sysinfo.collected", "agent", {}, s.agentUserId);
      io.forwardToAgent();
      return true;
    }
    // Kept on the session so a technician who reconnects, or takes the session
    // over, gets them in `session.resumed`. Rebuilt, never forwarded raw.
    case "host.quality": {
      if (!isProfile(msg["profile"])) return true;
      const changed = s.quality?.profile !== msg["profile"];
      s.quality = { profile: msg["profile"], fps: QUALITY_FPS[msg["profile"]] ?? 10 };
      if (changed) void recordEvent(s, "stream.quality", "agent", { ...s.quality }, s.agentUserId);
      io.toAgent({ t: "host.quality", ...s.quality });
      return true;
    }
    case "host.monitors": {
      const layout = parseMonitors(msg);
      if (!layout) return true;
      s.monitors = layout;
      io.toAgent({ t: "host.monitors", ...layout });
      return true;
    }
  }
  return false;
}

/** The capabilities an applet declared, kept only if known. */
export function parseCapabilities(version: unknown, caps: unknown): { version: number; caps: Set<string> } {
  const v = typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= 100 ? version : 1;
  const known = new Set<string>(CAPABILITIES);
  const set = new Set<string>(v >= 2 && Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string" && known.has(c)) : []);
  return { version: v, caps: set };
}

/** For tests and diagnostics: a fresh transfer id. */
export const newTransferId = (): string => randomUUID();
