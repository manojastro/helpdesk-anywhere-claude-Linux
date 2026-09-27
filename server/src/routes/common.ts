/** Small helpers shared by the agent and admin API routers. */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Principal } from "../auth/permissions.js";
import { RateLimiter } from "../sessions.js";

/** Wrap an async handler so a rejection becomes a 500 JSON, never an unhandled rejection. */
export function route(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction): void => {
    fn(req, res).catch((err: unknown) => {
      // Message only: never the request body (chat, notes) or headers (cookies).
      console.error(`[api] ${req.method} ${req.path} failed:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
  };
}

/** The principal on an authenticated route (requireApi ran first). */
export function me(req: Request): Principal {
  const p = req.principal;
  if (!p) throw new Error("route reached without a principal");
  return p;
}

/** Per-user limiter for state-changing requests. */
export function perUserLimit(limiter: RateLimiter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (p && !limiter.allow(p.userId)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}

export function pageParams(q: Record<string, unknown>, maxSize = 100): { page: number; pageSize: number } {
  const n = (v: unknown, d: number): number => {
    const x = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return { page: Math.min(n(q["page"], 1), 10_000), pageSize: Math.min(n(q["pageSize"], 25), maxSize) };
}

export function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}
