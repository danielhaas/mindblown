/**
 * getNextTicket end to end against a real Postgres (#452): the read →
 * sort → grant → advance loop runs its actual SQL — advisory lock,
 * conditional claim UPDATE, the persisted mix:bugs phase — on PGlite with
 * the production DDL. Only the websocket fan-out is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { getNextTicket } from '../orchestration.js';

const APPROVED = { state: 'approved' };

async function seedMap(opts: { cap: number; policy: string[] }) {
  const [user] = await db.insert(users).values({ email: 'a@example.com', name: 'A' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [map] = await db
    .insert(maps)
    .values({ workspaceId: ws.id, name: 'M', createdBy: user.id, maxActiveClaims: opts.cap, dispatchPolicy: opts.policy })
    .returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: user.id }).returning();
  const leaf = async (text: string, tags: string[], createdAt: string) => {
    const [n] = await db
      .insert(nodes)
      .values({
        mapId: map.id,
        parentId: root.id,
        text,
        createdBy: user.id,
        tags,
        status: 'todo',
        approval: APPROVED,
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `do ${text}` }] }] },
        createdAt: new Date(createdAt),
      })
      .returning();
    return n;
  };
  return { map, user, leaf };
}

describe('getNextTicket on Postgres (PGlite)', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('two pulls against a cap of 2, a third is refused; mix:bugs weaves and persists its phase', async () => {
    const { map, leaf } = await seedMap({ cap: 2, policy: ['mix:bugs=50', 'age'] });
    const feature = await leaf('feature', [], '2026-01-01T00:00:00Z');
    const bug = await leaf('bug', ['bug'], '2026-01-02T00:00:00Z');
    await leaf('feature 2', [], '2026-01-03T00:00:00Z');

    // Phase 0, N=50: slot 1 → 50, no crossing → the non-bug class.
    const first = await getNextTicket(map.id, 'session-1');
    expect(first.granted).toBe(true);
    expect(first.ticket?.id).toBe(feature.id);
    expect(first.active).toBe(1);
    let [row] = await db.select().from(maps).where(eq(maps.id, map.id));
    expect(row.dispatchMixAcc).toBe(50);

    // Phase 50 read back from the row: 50+50 crosses → the bug, paid back to 0.
    const second = await getNextTicket(map.id, 'session-2');
    expect(second.granted).toBe(true);
    expect(second.ticket?.id).toBe(bug.id);
    expect(second.active).toBe(2);
    [row] = await db.select().from(maps).where(eq(maps.id, map.id));
    expect(row.dispatchMixAcc).toBe(0);

    // Both claims are on the rows, so the cap holds.
    const claimed = await db.select().from(nodes).where(eq(nodes.mapId, map.id));
    expect(claimed.filter((n) => n.claimedBySession !== null).map((n) => [n.id, n.claimedBySession])).toEqual(
      expect.arrayContaining([
        [feature.id, 'session-1'],
        [bug.id, 'session-2'],
      ]),
    );
    const third = await getNextTicket(map.id, 'session-3');
    expect(third).toMatchObject({ granted: false, reason: 'cap', active: 2, cap: 2 });
    [row] = await db.select().from(maps).where(eq(maps.id, map.id));
    expect(row.dispatchMixAcc).toBe(0); // no grant, no advance
  });

  it('a cap of 0 holds the map', async () => {
    const { map, leaf } = await seedMap({ cap: 0, policy: [] });
    await leaf('feature', [], '2026-01-01T00:00:00Z');
    const r = await getNextTicket(map.id, 'session-1');
    expect(r).toMatchObject({ granted: false, reason: 'hold' });
  });
});
