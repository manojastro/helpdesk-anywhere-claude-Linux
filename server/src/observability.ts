/**
 * Platform 2.0 observability (brief §49): request ids, structured access logs,
 * and a small Prometheus-format metrics endpoint.
 *
 * What is logged is metadata only — method, route path (no query string),
 * status, duration, the technician's id and the request id. Never bodies,
 * headers, cookies or query strings (search text can name a customer).
 */

import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { config } from "./config.js";

/* ------------------------------------------------------------------ request id */

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Every request gets an id: the caller's `X-Request-Id` if it is well-formed
 * (so a proxy's id carries through), otherwise a fresh UUID. It is echoed back
 * and written on the access log line, so a user's error report can be matched
 * to the server's record of it.
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get("x-request-id");
    const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.locals["requestId"] = id;
    res.setHeader("X-Request-Id", id);
    next();
  };
}

/** One JSON line per API/auth request, after it finished. Static files are not logged. */
export function accessLog(app: "agent" | "admin"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/auth/")) {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    // Captured now: routers rewrite req.path to their own mount point.
    const routePath = req.path.slice(0, 200);
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      count("http_requests_total", { app, status: String(Math.floor(res.statusCode / 100)) + "xx" });
      if (!config.accessLog) return;
      process.stdout.write(`${JSON.stringify({
        ts: new Date().toISOString(), level: res.statusCode >= 500 ? "error" : "info", msg: "http", app,
        request_id: res.locals["requestId"] ?? null, method: req.method,
        // The route path only: ids in it are UUIDs, never secrets; no query string.
        path: routePath, status: res.statusCode, ms: Math.round(ms * 10) / 10,
        technician_id: req.principal?.userId ?? null,
      })}\n`);
    });
    next();
  };
}

/* --------------------------------------------------------------------- metrics */

const counters = new Map<string, number>();

function key(name: string, labels: Record<string, string> = {}): string {
  const l = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",");
  return l ? `${name}{${l}}` : name;
}

/** Increment a counter. Names are fixed in code; label values come from fixed sets. */
export function count(name: string, labels: Record<string, string> = {}, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

const HELP: Record<string, string> = {
  hda_sessions: "Live sessions by lifecycle phase.",
  hda_ws_connections: "Open WebSocket connections by kind.",
  hda_sessions_created_total: "Sessions created since the server started.",
  hda_sessions_ended_total: "Sessions ended since the server started, by end reason.",
  hda_reconnects_total: "Successful reconnects since start, by side.",
  hda_file_transfers_total: "File transfers finished since start, by direction and status.",
  hda_session_transfers_total: "Session transfers finished since start, by status.",
  hda_scripts_total: "Scripts requested since start, by outcome.",
  http_requests_total: "API/auth HTTP requests since start, by app and status class.",
};

/**
 * Prometheus text exposition. `gauges` are computed by the caller at scrape
 * time from live state; counters accumulate here.
 */
export function renderMetrics(gauges: Array<{ name: string; labels?: Record<string, string>; value: number }>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const emit = (name: string, kind: "gauge" | "counter", k: string, v: number): void => {
    const base = name.replace(/\{.*$/, "");
    if (!seen.has(base)) {
      seen.add(base);
      if (HELP[base]) lines.push(`# HELP ${base} ${HELP[base]}`);
      lines.push(`# TYPE ${base} ${kind}`);
    }
    lines.push(`${k} ${v}`);
  };
  for (const g of gauges) emit(g.name, "gauge", key(g.name, g.labels), g.value);
  for (const [k, v] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) emit(k, "counter", k, v);
  return `${lines.join("\n")}\n`;
}

/**
 * Guard for `/metrics`: off unless METRICS_TOKEN is set, then a bearer token
 * compared in constant time. Metrics carry counts only, but they still say how
 * busy a support desk is, so they are not public.
 */
export function metricsAuthorised(req: Request): boolean {
  const token = config.metricsToken;
  if (!token) return false;
  const got = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
