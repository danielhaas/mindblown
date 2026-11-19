/**
 * runStaleClaimSweep on a real Postgres (#452) — the parts a drizzle stub
 * can only pretend: the conditional clearing UPDATE (session + claimedAt
 * at ms precision, even when claimed_at carries microseconds from SQL
 * now()), the change-log clock and the rollup read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () => (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
// The activity read runs between the sweeper's SELECT and its UPDATE — a
// hook here can re-claim the node in that window.
const hooks = vi.hoisted(() => ({ duringActivityRead: null as null | (() => Promise<void>) }));
vi.mock('../../db/events.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../db/events.js')>();
  return {
    ...orig,
    lastChangeAtByNode: async (ids: string[]) => {
      if (hooks.duringActivityRead) await hooks.duringActivityRead();
      return orig.lastChangeAtByNode(ids);
    },
  };
});

import { db } from '../../db/connection.js';
import { changeEvents, fleets, fleetStatus, maps, nodes, users, workspaces } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { runStaleClaimSweep } from '../staleClaimSweeper.js';

const SESSION = 'gamora:slot1:default';
let mapId: string;
let userId: string;

beforeEach(async () => {
  hooks.duringActivityRead = null;
  await truncateAll(db);
  const [u] = await db.insert(users).values({ email: 'sweeper@test.invalid', name: 'T' }).returning();
  const [w] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: u.id }).returning();
  const [m] = await db.insert(maps).values({ name: 'M', createdBy: u.id, workspaceId: w.id }).returning();
  userId = u.id;
  mapId = m.id;
});

/**
 * A node claimed `hoursAgo`, written in SQL with sub-ms digits — what a
 * `now()` on real Postgres stores (PGlite's own clock is ms-only).
 */
async function claimedNode(hoursAgo: number, session = SESSION): Promise<string> {
  const [n] = await db.insert(nodes).values({ mapId, text: 'T', createdBy: userId }).returning();
  await db
    .update(nodes)
    .set({
      claimedBySession: session,
      claimedAt: sql`date_trunc('milliseconds', now()) - make_interval(secs => ${hoursAgo * 3600}) + interval '437 microseconds'`,
    })
    .where(eq(nodes.id, n.id));
  return n.id;
}

async function claimOf(id: string) {
  const [n] = await db.select({ s: nodes.claimedBySession }).from(nodes).where(eq(nodes.id, id));
  return n.s;
}

describe('runStaleClaimSweep (PGlite)', () => {
  it('clears an old, quiet claim even though claimed_at has microseconds', async () => {
    const id = await claimedNode(5);
    const { rows } = await db.execute<{ us: number }>(
      sql`SELECT extract(microseconds FROM claimed_at)::int % 1000 AS us FROM nodes WHERE id = ${id}`,
    );
    // Guard the premise: the stored value is finer than a JS Date.
    expect(rows[0].us).not.toBe(0);

    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 1, errors: [] });
    expect(await claimOf(id)).toBeNull();
  });

  it.each([
    ['another session', 'gamora:slot2:default', 5],
    ['the same session, fresh claimedAt', SESSION, 0],
  ])('leaves a claim alone that was re-claimed by %s after the sweep read it', async (_why, session, hoursAgo) => {
    const id = await claimedNode(5);
    hooks.duringActivityRead = async () => {
      await db
        .update(nodes)
        .set({ claimedBySession: session, claimedAt: sql`now() - make_interval(secs => ${hoursAgo * 3600 + 1})` })
        .where(eq(nodes.id, id));
    };

    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 0, errors: [] });
    expect(await claimOf(id)).toBe(session);
  });

  it('keeps an old claim whose node changed an hour ago', async () => {
    const id = await claimedNode(5);
    await db.insert(changeEvents).values({
      mapId,
      nodeId: id,
      eventType: 'node.field_changed',
      createdAt: sql`now() - interval '1 hour'` as unknown as Date,
    });

    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 0 });
    expect(await claimOf(id)).toBe(SESSION);
  });

  it('keeps an old, quiet claim a live worker reports under the same session', async () => {
    const id = await claimedNode(5);
    const [f] = await db.insert(fleets).values({ name: 'gamora', ownerId: userId }).returning();
    const at = new Date().toISOString();
    await db.insert(fleetStatus).values({
      fleetId: f.id,
      host: 'gamora',
      generatedAt: new Date(at),
      payload: {
        v: 2,
        host: 'gamora',
        generated_at: at,
        maps: [mapId],
        workers: [{ session: SESSION, state: 'working', last_activity: at, claim: { mapId, nodeId: id } }],
      },
    });

    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 0 });
    expect(await claimOf(id)).toBe(SESSION);
  });
});
