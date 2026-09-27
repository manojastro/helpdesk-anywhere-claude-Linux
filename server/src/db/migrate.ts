/**
 * Minimal forward-only migration runner.
 *
 * Files in `server/migrations/NNN_name.sql` are applied in lexical order, each in
 * its own transaction, and recorded in `schema_migrations`. An advisory lock
 * makes concurrent starts safe. There are no down-migrations: restore from a
 * backup instead (docs/ADMIN_PORTAL.md "Backup and restore").
 *
 * Run standalone with `node dist/db/migrate.js` (the `migrate` npm script), or
 * automatically at startup when DB_MIGRATE_ON_START is on (the default).
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./pool.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Arbitrary constant shared by every process running migrations. */
const LOCK_KEY = 0x4844_4100;

export async function migrate(log: (line: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
      log(`[db] applied migration ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

// `node dist/db/migrate.js` — the deploy-time entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then((applied) => {
      console.log(applied.length === 0 ? "[db] schema is up to date" : `[db] ${applied.length} migration(s) applied`);
      return pool.end();
    })
    .catch((err: unknown) => {
      console.error("[db] FATAL:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
