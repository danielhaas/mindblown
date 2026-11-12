/**
 * One github_installations row per (user, installation): the status refresh
 * upserts on that pair, so the migration drops old duplicates and adds the
 * unique index the upsert's ON CONFLICT needs.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pgliteDb.js';
import { runDdl } from '../migrate.js';
import { githubInstallations, users } from '../schema.js';

describe('github_installations uniqueness (PGlite)', () => {
  it('a re-run keeps the newest of old duplicates and upserts hit the unique index', async () => {
    const { db, client } = await createPgliteDb();
    try {
      const [user] = await db.insert(users).values({ email: 'a@example.com', name: 'A' }).returning();
      // A database from before the index, holding a duplicate.
      await db.execute(sql`DROP INDEX uq_github_installations_user_installation`);
      const row = { userId: user.id, installationId: '111', accountType: 'Organization', accountId: '5' };
      await db.insert(githubInstallations).values({ ...row, accountLogin: 'old', updatedAt: new Date('2026-01-01') });
      await db.insert(githubInstallations).values({ ...row, accountLogin: 'new', updatedAt: new Date('2026-02-01') });

      await runDdl(db);
      expect((await db.select().from(githubInstallations)).map((r) => r.accountLogin)).toEqual(['new']);

      await db.insert(githubInstallations).values({ ...row, accountLogin: 'renamed' }).onConflictDoUpdate({
        target: [githubInstallations.userId, githubInstallations.installationId],
        set: { accountLogin: 'renamed' },
      });
      expect((await db.select().from(githubInstallations)).map((r) => r.accountLogin)).toEqual(['renamed']);
    } finally {
      await client.close();
    }
  });
});
