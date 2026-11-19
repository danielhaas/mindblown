/**
 * Ready work outside the dispatch gate is never silent (Navy, 19.11.2026):
 * an `empty` pull names what the gate keeps out (gatedOut), and a new leaf
 * in a map whose gate names versions gets the active version by default —
 * on PGlite with the production DDL, through the real createNode and pull.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, versions } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { getNextTicket } from '../orchestration.js';
import { createNode, versionDefaultOf } from '../../db/nodes.js';

const APPROVED = { state: 'approved' };
const brief = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'do it' }] }] };

async function seed(gate: string[], opts: { active?: boolean } = {}) {
  const [user] = await db.insert(users).values({ email: 'a@example.com', name: 'Dan Haas' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'Navy App', createdBy: user.id, maxActiveClaims: 2 }).returning();
  const [v1] = await db.insert(versions).values({ workspaceId: ws.id, mapId: map.id, name: 'V1', status: opts.active === false ? 'planning' : 'active', sortOrder: 1 }).returning();
  const [v3] = await db.insert(versions).values({ workspaceId: ws.id, mapId: map.id, name: 'V3', status: 'planning', sortOrder: 3 }).returning();
  const resolved = gate.map((g) => g.replace('V1', v1.id).replace('V3', v3.id));
  await db.update(maps).set({ dispatchGate: resolved }).where(eq(maps.id, map.id));
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: user.id }).returning();
  const leaf = async (text: string, versionId: string | null, extra: Record<string, unknown> = {}) => {
    const [n] = await db
      .insert(nodes)
      .values({ mapId: map.id, parentId: root.id, text, createdBy: user.id, status: 'todo', approval: APPROVED, description: brief, versionId, ...extra })
      .returning();
    return n;
  };
  return { map, user, root, v1, v3, leaf };
}

describe('an empty pull names the ready work outside the gate', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('empty + ready outside the gate → gatedOut {count, unversioned}', async () => {
    const { map, v3, leaf } = await seed(['type:bug|version:V1']);
    await leaf('TeamSnap OAuth', null);
    await leaf('Lineup insert', null);
    await leaf('Recruits QR', v3.id);
    await leaf('Decision for Dan', null, { tags: ['needs-human'] }); // a person's — not gated-out work
    const r = await getNextTicket(map.id, 'session-1');
    expect(r).toMatchObject({ granted: false, reason: 'empty', gatedOut: { count: 3, unversioned: 2 } });
  });

  it('nothing outside the gate → no gatedOut', async () => {
    const { map } = await seed(['version:V1']);
    const r = await getNextTicket(map.id, 'session-1');
    expect(r.reason).toBe('empty');
    expect(r.gatedOut).toBeUndefined();
  });
});

describe('a new leaf in a version-gated map gets the active version', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('no versionId → the active version, and the answer says so', async () => {
    const { map, user, root, v1 } = await seed(['type:bug|version:V1']);
    const n = await createNode({ mapId: map.id, parentId: root.id, text: 'TeamSnap OAuth', createdBy: user.id });
    expect(n.versionId).toBe(v1.id);
    expect(versionDefaultOf(n)).toEqual({ id: v1.id, name: 'V1' });
  });

  it('an explicit null stays unversioned; an explicit version is kept', async () => {
    const { map, user, root, v3 } = await seed(['version:V1']);
    const none = await createNode({ mapId: map.id, parentId: root.id, text: 'later', createdBy: user.id, versionId: null });
    expect(none.versionId).toBeNull();
    expect(versionDefaultOf(none)).toBeNull();
    const own = await createNode({ mapId: map.id, parentId: root.id, text: 'v3', createdBy: user.id, versionId: v3.id });
    expect(own.versionId).toBe(v3.id);
    expect(versionDefaultOf(own)).toBeNull();
  });

  it('under a versioned parent it inherits — no default', async () => {
    const { map, user, v3, leaf } = await seed(['version:V1']);
    const epic = await leaf('epic', v3.id);
    const n = await createNode({ mapId: map.id, parentId: epic.id, text: 'child', createdBy: user.id });
    expect(n.versionId).toBeNull();
  });

  it('a map without a gate, a gate without a version, or no active version → unchanged', async () => {
    for (const [gate, active] of [[[], true], [['type:bug'], true], [['version:V1'], false]] as const) {
      await truncateAll(db);
      const { map, user, root } = await seed([...gate], { active });
      const n = await createNode({ mapId: map.id, parentId: root.id, text: 'x', createdBy: user.id });
      expect(n.versionId).toBeNull();
      expect(versionDefaultOf(n)).toBeNull();
    }
  });
});
