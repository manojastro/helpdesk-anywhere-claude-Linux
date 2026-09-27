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
 * The built-in PDF fonts only encode Windows-1252. Anything outside it would
 * render as garbage, so it is replaced visibly instead (docs: "PDF character
 * set"). Control characters are dropped.
 */
function pdfText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = v instanceof Date ? v.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : String(v);
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/[^\n\t -ÿ–—‘’“”•…€]/g, "?");
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
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const heading = (t: string): void => {
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor("#1f3a8a").text(pdfText(t));
    doc.moveDown(0.3).font("Helvetica").fontSize(10).fillColor("#111111");
  };
  const row = (k: string, v: unknown): void => {
    doc.font("Helvetica-Bold").text(`${pdfText(k)}: `, { continued: true }).font("Helvetica").text(pdfText(v));
  };

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text("Helpdesk Anywhere — Session report");
  doc.font("Helvetica").fontSize(9).fillColor("#555555")
    .text(pdfText(`Generated ${new Date().toISOString()} by ${p.displayName}. Confidential: contains customer support data.`));

  if (!s.record_complete) {
    doc.moveDown(0.5).font("Helvetica-Bold").fontSize(10).fillColor("#b91c1c")
      .text("WARNING: some events for this session could not be stored. This record is incomplete.");
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
  if (timeline.length === 0) doc.text("No events recorded.");
  for (const e of timeline) {
    const who = e.actor_name ? `${e.actor_role} (${e.actor_name})` : e.actor_role;
    const extra = detailText(e.detail);
    doc.font("Helvetica-Bold").text(pdfText(`#${e.seq}  ${pdfText(e.at)}  `), { continued: true })
      .font("Helvetica").text(pdfText(`${EVENT_TITLES[e.type] ?? e.type} — ${who}${extra ? ` — ${extra}` : ""}`));
  }

  heading("Chat transcript");
  if (!include.chat) doc.text("Not included in this report.");
  else if (s.transcript_purged_at) doc.text(pdfText(`Deleted by the retention policy on ${pdfText(s.transcript_purged_at)}.`));
  else if (chat.length === 0) doc.text("No chat messages.");
  for (const m of chat) {
    const who = m.sender_role === "agent" ? `Technician${m.sender_name ? ` (${m.sender_name})` : ""}` : "Customer";
    const body = m.kind === "url" ? `[link] ${m.label ? `${m.label} — ` : ""}${m.url ?? ""}` : m.body ?? "";
    doc.font("Helvetica-Bold").text(pdfText(`${pdfText(m.created_at)}  ${who}: `), { continued: true })
      .font("Helvetica").text(pdfText(body));
  }

  heading("Technician notes (private — never shown to the customer)");
  if (!include.notes) doc.text("Not included in this report.");
  else if (s.transcript_purged_at) doc.text("Deleted by the retention policy.");
  else if (notes.length === 0) doc.text("No notes.");
  notes.forEach((n, i) => {
    doc.font("Helvetica-Bold").text(pdfText(`Revision ${i + 1} — ${pdfText(n.created_at)} — ${n.author_name ?? "unknown"}`));
    doc.font("Helvetica").text(pdfText(n.body)).moveDown(0.3);
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
