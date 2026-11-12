/**
 * lastChangeAtByNode on a real Postgres (#452): the stale-claim sweeper's
 * activity clock. Pins that `max(created_at)` comes back as a Date per node,
 * across maps, and that nodes without events are absent (not epoch).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../test/pgliteDb.js')).pgliteConnection());

import { db } from '../connection.js';
import { changeEvents, maps, users, workspaces } from '../schema.js';
import { lastChangeAtByNode } from '../events.js';

const N1 = '00000000-0000-4000-8000-000000000001';
const N2 = '00000000-0000-4000-8000-000000000002';
const N3 = '00000000-0000-4000-8000-000000000003';

describe('lastChangeAtByNode (PGlite)', () => {
  it('returns the newest event per node as a Date, across maps', async () => {
    const [u] = await db.insert(users).values({ email: 'sweeper@test.invalid', name: 'T' }).returning();
    const [w] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: u.id }).returning();
    const [m1] = await db.insert(maps).values({ name: 'A', createdBy: u.id, workspaceId: w.id }).returning();
    const [m2] = await db.insert(maps).values({ name: 'B', createdBy: u.id, workspaceId: w.id }).returning();
    const at = (iso: string) => new Date(iso);
    await db.insert(changeEvents).values([
      { mapId: m1.id, nodeId: N1, eventType: 'node.claimed', createdAt: at('2026-11-12T01:00:00Z') },
      { mapId: m1.id, nodeId: N1, eventType: 'node.field_changed', createdAt: at('2026-11-12T03:00:00Z') },
      { mapId: m2.id, nodeId: N2, eventType: 'node.field_changed', createdAt: at('2026-11-12T02:00:00Z') },
      { mapId: m1.id, nodeId: null, eventType: 'map.field_changed', createdAt: at('2026-11-12T04:00:00Z') },
    ]);

    const out = await lastChangeAtByNode([N1, N2, N3]);

    expect(out.get(N1)).toBeInstanceOf(Date);
    expect(out.get(N1)?.toISOString()).toBe('2026-11-12T03:00:00.000Z');
    expect(out.get(N2)?.toISOString()).toBe('2026-11-12T02:00:00.000Z');
    expect(out.has(N3)).toBe(false);
    expect(await lastChangeAtByNode([])).toEqual(new Map());
  });
});
