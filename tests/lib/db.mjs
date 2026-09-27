/**
 * Direct database access for the test suite (never used by the product).
 *
 *   node tests/lib/db.mjs ping    exit 0 when the test PostgreSQL answers
 *   node tests/lib/db.mjs reset   drop and recreate the test database
 *
 * Imported by blocks that need to inspect or sabotage the database (e.g. to
 * prove a failed write is visible rather than silent).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pg = createRequire(`${REPO}/server/package.json`)("pg");

const ADMIN_URL = process.env.HDA_TEST_PG_ADMIN_URL ?? "postgres://postgres:hdatest@127.0.0.1:55432/postgres";
export const DATABASE_URL = process.env.HDA_TEST_DATABASE_URL ?? "postgres://postgres:hdatest@127.0.0.1:55432/hda_test";
const DB_NAME = process.env.HDA_TEST_DB ?? "hda_test";

/** Run one query against the test database and close. */
export async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function admin(fn) {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  try {
    if (cmd === "ping") await admin((c) => c.query("SELECT 1"));
    else if (cmd === "reset") {
      if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) throw new Error("bad test database name");
      await admin(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${DB_NAME}`);
      });
    } else throw new Error(`unknown command ${cmd}`);
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
