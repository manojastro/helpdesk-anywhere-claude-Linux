/**
 * Report exports: a human-readable PDF for one session, and a filtered CSV
 * summary of many.
 *
 * Lifecycle (`report_exports`): the API inserts a `pending` row and audits the
 * request; generation runs in the background and stores the file in the row
 * (`ready`) or the error (`failed`). The file can be downloaded only by the
 * person who requested it, only until `expires_at` (REPORT_TTL_MINUTES), and
 * every download is audited. The retention sweep then erases the bytes.
 *
 * What a report never contains: the pairing code (not stored), credentials (not
 * stored), script bodies or output (not stored), tokens or cookies. Chat and
 * notes are included only when the requester's role allows them AND they asked.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

import type { Principal } from "./auth/permissions.js";
import { config } from "./config.js";
import { query } from "./db/pool.js";
import {
  SESSION_LIST_COLUMNS,
  buildSessionWhere,
  getScopedSession,
  type SessionFilters,
  type SessionListRow,
} from "./sessionQueries.js";

/** Hard cap on CSV rows — a summary, not a database dump. */
const MAX_CSV_ROWS = 50_000;

export const END_REASON_LABELS: Record<string, string> = {
  agent_ended: "Ended by technician",
  customer_ended: "Ended by customer",
  customer_declined: "Customer declined consent",
  agent_disconnected: "Technician disconnected",
  customer_disconnected: "Customer disconnected",
  code_expired: "Code expired unused",
  terminated_by_admin: "Terminated by administrator",
  agent_access_revoked: "Technician access revoked",
  agent_session_expired: "Technician sign-in expired",
  storage_unavailable: "Record could not be written",
  server_shutdown: "Server shut down",
  server_restart: "Interrupted by server restart",
};

/* ------------------------------------------------------------------------ CSV */

/**
 * RFC 4180 quoting plus formula-injection defence: a cell a spreadsheet would
 * evaluate (=, +, -, @, tab, CR) is prefixed with an apostrophe. Customer
 * machine and user names are attacker-influenced text.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function buildSummaryCsv(p: Principal, filters: SessionFilters): Promise<Buffer> {
  const { where, params, order } = buildSessionWhere(p, filters);
  const { rows } = await query<SessionListRow>(
    `SELECT ${SESSION_LIST_COLUMNS}
       FROM sessions s LEFT JOIN teams t ON t.id = s.team_id AND t.org_id = s.org_id
      WHERE ${where} ORDER BY ${order} LIMIT ${MAX_CSV_ROWS}`,
    params,
  );
  const header = [
    "session_id", "created_at", "agent", "agent_id", "team", "status", "end_reason", "consent",
    "customer_machine", "customer_user", "customer_os", "active_at", "ended_at", "duration_seconds", "record_complete",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, r.created_at, r.agent_display_name, r.agent_code, r.team_name, r.status, r.end_reason,
      r.consent_decision, r.customer_machine, r.customer_user, r.customer_os, r.active_at, r.ended_at,
      r.duration_seconds, r.record_complete ? "yes" : "NO",
    ].map(csvCell).join(","));
  }
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

/* ------------------------------------------------------------------------ PDF */

/**
 * Report fonts (OFL, `server/assets/fonts/`). The PDF standard fonts only encode
 * Windows-1252, which turned Tamil chat into "?"; these are embedded TrueType
 * fonts, so pdfkit subsets them into the file and fontkit's OpenType Indic
 * shaper handles Tamil vowel-sign reordering and conjuncts.
 */
const FONT_DIR = process.env["REPORT_FONT_DIR"] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
const FONT_FILES = {
  latin: { regular: "NotoSans-Regular.ttf", bold: "NotoSans-Bold.ttf" },
  tamil: { regular: "NotoSansTamil-Regular.ttf", bold: "NotoSansTamil-Bold.ttf" },
} as const;
type Script = keyof typeof FONT_FILES;

let coverage: Record<Script, fontkit.Font> | null = null;

/** fontkit handles on the regular faces, used only to ask "does this font have a glyph for X". */
function fontCoverage(): Record<Script, fontkit.Font> {
  coverage ??= {
    latin: fontkit.openSync(path.join(FONT_DIR, FONT_FILES.latin.regular)) as fontkit.Font,
    tamil: fontkit.openSync(path.join(FONT_DIR, FONT_FILES.tamil.regular)) as fontkit.Font,
  };
  return coverage;
}

/** Throws at startup rather than at the first export if a font file is missing. */
export function verifyReportFonts(): void {
  const c = fontCoverage();
  if (!c.latin.hasGlyphForCodePoint(0x41) || !c.tamil.hasGlyphForCodePoint(0x0b95)) {
    throw new Error(`report fonts in ${FONT_DIR} do not cover Latin and Tamil`);
  }
}

const isTamil = (cp: number): boolean => cp >= 0x0b80 && cp <= 0x0bff;
/** Joiners and combining marks belong to the run of the character before them. */
const isJoining = (cp: number): boolean => cp === 0x200c || cp === 0x200d || /\p{M}/u.test(String.fromCodePoint(cp));

/** Display form of a value: dates in UTC, control characters dropped, empty → "—". */
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = v instanceof Date ? v.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : String(v);
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/**
 * Split text into runs that one font can draw. Tamil goes to Noto Sans Tamil;
 * spaces, digits and punctuation stay in the current run when its font has
 * them (so a Tamil sentence is shaped as one run); anything neither font has
 * (e.g. emoji, CJK) is shown as "?" rather than an invisible .notdef box.
 */
export function scriptRuns(text: string): Array<{ script: Script; text: string }> {
  const fonts = fontCoverage();
  const runs: Array<{ script: Script; text: string }> = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    const prev = runs[runs.length - 1];
    let script: Script;
    let out = ch;
    if (isTamil(cp)) script = "tamil";
    else if (prev && (isJoining(cp) || (/[\s\p{P}\p{N}]/u.test(ch) && fonts[prev.script].hasGlyphForCodePoint(cp)))) script = prev.script;
    else if (fonts.latin.hasGlyphForCodePoint(cp)) script = "latin";
    else if (fonts.tamil.hasGlyphForCodePoint(cp)) script = "tamil";
    else { script = prev?.script ?? "latin"; out = "?"; }
    if (prev && prev.script === script) prev.text += out;
    else runs.push({ script, text: out });
  }
  return runs.length > 0 ? runs : [{ script: "latin", text: "" }];
}

function duration(seconds: number | null): string {
  if (seconds === null) return "Never became active";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

interface TimelineRow { seq: number; type: string; at: Date; actor_role: string; actor_name: string | null; detail: Record<string, unknown> }
interface ChatRow { seq: number; sender_role: string; sender_name: string | null; kind: string; body: string | null; url: string | null; label: string | null; created_at: Date }
interface NoteRow { author_name: string | null; body: string; created_at: Date }

export async function loadTimeline(orgId: string, sessionId: string): Promise<TimelineRow[]> {
  const { rows } = await query<TimelineRow>(
    `SELECT e.seq, e.type, e.at, e.actor_role, u.display_name AS actor_name, e.detail
       FROM session_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.org_id = $1 AND e.session_id = $2 ORDER BY e.seq`,
    [orgId, sessionId],
  );
  return rows;
}

export async function loadTranscript(orgId: string, sessionId: string): Promise<ChatRow[]> {
  const { rows } = await query<ChatRow>(
    `SELECT c.seq, c.sender_role, u.display_name AS sender_name, c.kind, c.body, c.url, c.label, c.created_at
       FROM chat_messages c LEFT JOIN users u ON u.id = c.sender_user_id
      WHERE c.org_id = $1 AND c.session_id = $2 ORDER BY c.seq`,
    [orgId, sessionId],
  );
  return rows;
}

export async function loadNotes(orgId: string, sessionId: string): Promise<NoteRow[]> {
  const { rows } = await query<NoteRow>(
    `SELECT u.display_name AS author_name, n.body, n.created_at
       FROM session_notes n LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.org_id = $1 AND n.session_id = $2 ORDER BY n.created_at`,
    [orgId, sessionId],
  );
  return rows;
}


/** Short titles for timeline event types; unknown types fall back to the raw type. */
export const EVENT_TITLES: Record<string, string> = {
  "session.created": "Session created, code issued",
  "customer.joined": "Customer joined",
  "consent.requested": "Consent requested",
  "consent.accepted": "Consent accepted",
  "consent.declined": "Consent declined",
  "session.active": "Session active",
  "session.held": "On hold",
  "session.resumed": "Resumed",
  "session.phase": "State changed",
  "screenshot.taken": "Screenshot captured",
  "file.transfer": "File transfer",
  "fs.changed": "File changed on remote computer",
  "clipboard.sent": "Text sent to remote clipboard",
  "clipboard.read": "Remote clipboard read",
  "sysinfo.collected": "System information collected",
  "script.cancelled": "Script stopped by technician",
  "desktop.changed": "Desktop changed",
  "elevation.requested": "Elevation requested",
  "elevation.refused": "Elevation refused",
  "elevation.result": "Elevation result",
  "script.requested": "Script requested",
  "script.refused": "Script refused",
  "script.result": "Script finished",
  "sas.sent": "Ctrl+Alt+Del sent",
  "url.shared": "Link shared",
  "notes.saved": "Notes saved",
  "agent.disconnected": "Technician disconnected",
  "agent.reconnecting": "Technician connection lost — reconnecting",
  "agent.reconnected": "Technician reconnected",
  "agent.reconnect_expired": "Technician did not reconnect in time",
  "customer.disconnected": "Customer disconnected",
  "session.terminated": "Terminated by administrator",
  "session.interrupted": "Interrupted",
  "session.ended": "Session ended",
};

/**
 * Timeline detail keys that may be shown in the UI and in reports. Anything not
 * listed is omitted, so a future event carrying something sensitive does not
 * leak into a report by default.
 */
const DETAIL_KEYS = [
  "reason", "mode", "attempt", "ok", "error", "execId", "shell", "asSystem", "scriptBytes", "scriptSha256",
  "exitCode", "desktop", "domain", "length", "machine", "os", "codeTtlSeconds", "durationMs", "note", "agentName",
  "reconnectCount", "downtimeMs", "graceSeconds", "from", "to", "deferred",
  "libraryId", "libraryVersion", "libraryName", "libraryMismatch", "machineName",
  "direction", "name", "size", "status", "path", "newName", "op", "sha256",
];

export function safeDetail(detail: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of DETAIL_KEYS) {
    const v = detail[k];
    if (v === undefined) continue;
    if (k === "reason" && typeof v === "string" && END_REASON_LABELS[v]) out[k] = END_REASON_LABELS[v];
    else if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

export function detailText(detail: Record<string, unknown>): string {
  return Object.entries(safeDetail(detail)).map(([k, v]) => `${k}: ${String(v)}`).join("; ");
}

export interface PdfInclude { chat: boolean; notes: boolean }

export async function buildSessionPdf(p: Principal, sessionId: string, include: PdfInclude): Promise<Buffer> {
  const s = await getScopedSession(p, sessionId);
  if (!s) throw new Error("session not found in scope");
  const timeline = await loadTimeline(p.orgId, s.id);
  const chat = include.chat && s.transcript_purged_at === null ? await loadTranscript(p.orgId, s.id) : [];
  const notes = include.notes && s.transcript_purged_at === null ? await loadNotes(p.orgId, s.id) : [];

  const doc = new PDFDocument({
    size: "A4", margin: 50,
    info: { Title: `Helpdesk Anywhere session ${s.id}`, Author: "Helpdesk Anywhere", Creator: "Helpdesk Anywhere" },
  });
  for (const script of Object.keys(FONT_FILES) as Script[]) {
    doc.registerFont(`${script}-regular`, path.join(FONT_DIR, FONT_FILES[script].regular));
    doc.registerFont(`${script}-bold`, path.join(FONT_DIR, FONT_FILES[script].bold));
  }
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Every run sits on the LATIN font's baseline. pdfkit's default aligns each run
  // by its own font's ascender, and Noto Sans Tamil's is taller, so mixed lines
  // came out stepped. A numeric `baseline` fixes the offset for all fonts alike.
  const latin = fontCoverage().latin;
  let size = 10;
  const setSize = (n: number): void => {
    size = n;
    doc.fontSize(n);
  };

  /** Write text in the right font per script run. `continued` chains onto the next write. */
  const write = (text: unknown, { bold = false, continued = false } = {}): void => {
    const runs = scriptRuns(fmt(text));
    const baseline = -(latin.ascent / latin.unitsPerEm) * size;
    runs.forEach((r, i) => {
      doc.font(`${r.script}-${bold ? "bold" : "regular"}`)
        .text(r.text, { continued: continued || i < runs.length - 1, baseline });
    });
  };
  const heading = (t: string): void => {
    doc.moveDown(0.8).fillColor("#1f3a8a");
    setSize(13);
    write(t, { bold: true });
    doc.moveDown(0.3).fillColor("#111111");
    setSize(10);
  };
  const row = (k: string, v: unknown): void => {
    write(`${k}: `, { bold: true, continued: true });
    write(v);
  };

  doc.fillColor("#111111");
  setSize(18);
  write("Helpdesk Anywhere — Session report", { bold: true });
  doc.fillColor("#555555");
  setSize(9);
  write(`Generated ${new Date().toISOString()} by ${p.displayName}. Confidential: contains customer support data.`);
  doc.fillColor("#111111");
  setSize(10);

  if (!s.record_complete) {
    doc.moveDown(0.5).fillColor("#b91c1c");
    write("WARNING: some events for this session could not be stored. This record is incomplete.", { bold: true });
    doc.fillColor("#111111");
  }

  heading("Session");
  row("Session ID", s.id);
  row("Status", s.status);
  row("End reason", s.end_reason ? END_REASON_LABELS[s.end_reason] ?? s.end_reason : null);
  row("Created", s.created_at);
  row("Customer joined", s.customer_joined_at ?? "Never joined");
  row("Active from", s.active_at);
  row("Ended", s.ended_at);
  row("Duration (active)", duration(s.duration_seconds));
  row("Consent", s.consent_decision ?? "Never decided");

  heading("Technician");
  row("Name", s.agent_display_name);
  row("Agent ID", s.agent_code);
  row("Team", s.team_name);

  heading("Customer device (as reported by the applet)");
  row("Machine", s.customer_machine ?? "Not captured");
  row("Windows user", s.customer_user ?? "Not captured");
  row("OS", s.customer_os ?? "Not captured");

  heading("Timeline");
  if (timeline.length === 0) write("No events recorded.");
  for (const e of timeline) {
    const who = e.actor_name ? `${e.actor_role} (${e.actor_name})` : e.actor_role;
    const extra = detailText(e.detail);
    write(`#${e.seq}  ${fmt(e.at)}  `, { bold: true, continued: true });
    write(`${EVENT_TITLES[e.type] ?? e.type} — ${who}${extra ? ` — ${extra}` : ""}`);
  }

  heading("Chat transcript");
  if (!include.chat) write("Not included in this report.");
  else if (s.transcript_purged_at) write(`Deleted by the retention policy on ${fmt(s.transcript_purged_at)}.`);
  else if (chat.length === 0) write("No chat messages.");
  for (const m of chat) {
    const who = m.sender_role === "agent" ? `Technician${m.sender_name ? ` (${m.sender_name})` : ""}` : "Customer";
    const body = m.kind === "url" ? `[link] ${m.label ? `${m.label} — ` : ""}${m.url ?? ""}` : m.body ?? "";
    write(`${fmt(m.created_at)}  ${who}: `, { bold: true, continued: true });
    write(body);
  }

  heading("Technician notes (private — never shown to the customer)");
  if (!include.notes) write("Not included in this report.");
  else if (s.transcript_purged_at) write("Deleted by the retention policy.");
  else if (notes.length === 0) write("No notes.");
  notes.forEach((n, i) => {
    write(`Revision ${i + 1} — ${fmt(n.created_at)} — ${n.author_name ?? "unknown"}`, { bold: true });
    write(n.body);
    doc.moveDown(0.3);
  });

  doc.end();
  return done;
}

/* --------------------------------------------------------------- export lifecycle */

export type ExportRequest =
  | { kind: "session_pdf"; sessionId: string; include: PdfInclude }
  | { kind: "summary_csv"; filters: SessionFilters };

/** Insert the pending row; the caller audits it; generation runs detached. */
export async function createExport(p: Principal, req: ExportRequest): Promise<string> {
  const id = randomUUID();
  const expires = new Date(Date.now() + config.reportTtlMinutes * 60_000);
  await query(
    `INSERT INTO report_exports (id, org_id, requested_by, kind, session_id, params, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, p.orgId, p.userId, req.kind, req.kind === "session_pdf" ? req.sessionId : null,
      JSON.stringify(req.kind === "session_pdf" ? { include: req.include } : { filters: req.filters }), expires],
  );
  void generate(p, id, req);
  return id;
}

async function generate(p: Principal, id: string, req: ExportRequest): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const [content, type, filename] =
      req.kind === "session_pdf"
        ? [await buildSessionPdf(p, req.sessionId, req.include), "application/pdf", `session-${req.sessionId}.pdf`]
        : [await buildSummaryCsv(p, req.filters), "text/csv; charset=utf-8", `sessions-summary-${stamp}.csv`];
    await query(
      `UPDATE report_exports SET status = 'ready', content = $2, content_type = $3, filename = $4,
              byte_size = $5, ready_at = now() WHERE id = $1 AND status = 'pending'`,
      [id, content, type, filename, content.length],
    );
  } catch (err) {
    console.error(`[reports] export ${id} failed:`, err instanceof Error ? err.message : err);
    await query(`UPDATE report_exports SET status = 'failed', error = $2 WHERE id = $1`, [id, "Report generation failed."])
      .catch(() => undefined);
  }
}
