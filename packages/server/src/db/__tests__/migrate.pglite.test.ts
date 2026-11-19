/**
 * migrate.ts on a real Postgres (#452): every API start re-runs the whole
 * DDL against a live database, so a second run over a migrated schema must
 * be a no-op, not an error.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pgliteDb.js';
import { runDdl } from '../migrate.js';

describe('runDdl on Postgres (PGlite)', () => {
  it('applies cleanly and is idempotent on a second run', async () => {
    const { db, client } = await createPgliteDb();
    try {
      await expect(runDdl(db)).resolves.toBeUndefined();
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users', 'maps', 'nodes', 'fleets')`,
      );
      expect(rows[0].n).toBe(4);
    } finally {
      await client.close();
    }
  });

  it('gives a new fleet auto-check blockers on, also on a schema that had the old default', async () => {
    const { db, client } = await createPgliteDb();
    try {
      await runDdl(db);
      // A database migrated before 12.11.2026 carries DEFAULT false.
      await db.execute(sql`ALTER TABLE fleets ALTER COLUMN auto_check_blockers SET DEFAULT false`);
      await runDdl(db);
      const { rows } = await db.execute<{ d: string }>(
        sql`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'fleets' AND column_name = 'auto_check_blockers'`,
      );
      expect(rows[0].d).toBe('true');
    } finally {
      await client.close();
    }
  });
});
