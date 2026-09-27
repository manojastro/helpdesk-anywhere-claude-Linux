/**
 * PostgreSQL connection pool — the system of record for sessions, timelines,
 * chat, notes, agents, reports and the administrative audit trail.
 *
 * Live WebSocket state stays in memory (`sessions.ts`); this is what survives a
 * restart. Nothing here logs query parameters: several of them are chat text,
 * notes, or hashes of browser session cookies.
 */

import pg from "pg";

import { config } from "../config.js";

// timestamptz → Date is the pg default; bigint (int8, e.g. COUNT(*)) would come
// back as a string. Every count this app reads fits comfortably in a double.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/** Last connection-level error, surfaced on the admin dashboard and /healthz. */
export const dbHealth = { ok: true, lastError: null as string | null, at: null as Date | null };

pool.on("error", (err) => {
  // An idle client died (server restart, network blip). pg reconnects on the
  // next checkout; record it so the failure is visible rather than silent.
  dbHealth.ok = false;
  dbHealth.lastError = err.message;
  dbHealth.at = new Date();
  console.error("[db] idle client error:", err.message);
});

export type Queryable = Pick<pg.PoolClient, "query">;

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<pg.QueryResult<R>> {
  try {
    const result = await client.query<R>(text, params);
    dbHealth.ok = true;
    return result;
  } catch (err) {
    if (isConnectionError(err)) {
      dbHealth.ok = false;
      dbHealth.lastError = err instanceof Error ? err.message : String(err);
      dbHealth.at = new Date();
    }
    throw err;
  }
}

/** Run `fn` in a transaction; rolled back on any throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return true;  // socket-level failure
  // Class 08 = connection exception, 57P = operator intervention (shutdown).
  return code.startsWith("08") || code.startsWith("57P");
}
