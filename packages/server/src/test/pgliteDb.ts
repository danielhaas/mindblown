/**
 * A real Postgres for DB-layer tests (#452): PGlite — Postgres compiled to
 * WASM, in-process, no Docker — with the production DDL from migrate.ts
 * applied. Use it where correctness lives in SQL (jsonb filters, advisory
 * locks, conditional UPDATEs, the migrations themselves) and a drizzle stub
 * could only pretend.
 *
 * Swap it in for the app's connection with a hoisted mock:
 *
 *   vi.mock('../../db/connection.js', async () =>
 *     (await import('../../test/pgliteDb.js')).pgliteConnection());
 *
 * then `import { db } from '../../db/connection.js'` to seed and assert —
 * the code under test and the test share the one in-memory database.
 * Each test file gets its own instance (vitest isolates modules per file).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { runDdl } from '../db/migrate.js';

export async function createPgliteDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await runDdl(db);
  return { client, db };
}

/** Module shape of `db/connection.ts`, backed by a fresh migrated PGlite. */
export async function pgliteConnection() {
  const { client, db } = await createPgliteDb();
  return { db, pool: client, DATABASE_URL: 'pglite://memory' };
}

/** Empty every table, keeping the schema — for a clean slate per test. */
export async function truncateAll(db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) {
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      SELECT string_agg(quote_ident(tablename), ', ') INTO t
        FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'data_migrations';
      IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' CASCADE'; END IF;
    END $$;
  `);
}
