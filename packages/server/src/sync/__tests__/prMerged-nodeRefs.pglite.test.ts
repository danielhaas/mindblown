/**
 * A merged PR closes the node it names by id (`MindBlown: <id>`), on
 * PGlite: full id, 8-char prefix, the fleet worker's wording, a node on
 * a map bound to another repo (untouched), an ambiguous prefix, the
 * reference-only form, and a replay that writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, changeEvents } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { applyMergedPr } from '../prMerged.js';

const opts = { actorUserId: null, resolveForge: async () => null };

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'dan@example.com', name: 'Dan' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${Math.random()}`, ownerId: owner.id }).returning();
  const [map] = await db
    .insert(maps)
    .values({ workspaceId: ws.id, name: 'Avatar', createdBy: owner.id, githubRepoOwner: 'tracer', githubRepoName: 'avatar' })
    .returning();
  const [other] = await db
    .insert(maps)
    .values({ workspaceId: ws.id, name: 'Other', createdBy: owner.id, githubRepoOwner: 'acme', githubRepoName: 'other' })
    .returning();
  const leaf = async (mapId: string, over: Partial<typeof nodes.$inferInsert> = {}) => {
    const [n] = await db
      .insert(nodes)
      .values({ mapId, text: 'Ticket', createdBy: owner.id, status: 'in_progress', percentComplete: 40, claimedBySession: 'claudia:slot1:fleet-worker', claimedAt: new Date(), ...over })
      .returning();
    return n;
  };
  return { owner, map, other, leaf };
}

const pr = (body: string, over: Record<string, unknown> = {}) => ({
  number: 80, title: 'feat: avatar', body, merge_commit_sha: 'm80', html_url: 'https://git.project.li/tracer/avatar/pulls/80', ...over,
});

const read = async (id: string) => (await db.select().from(nodes).where(eq(nodes.id, id)))[0];
const prMergedEvents = (id: string) =>
  db.select().from(changeEvents).where(and(eq(changeEvents.nodeId, id), eq(changeEvents.eventType, 'node.pr_merged')));

describe('applyMergedPr — MindBlown node id refs', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('`MindBlown: <full id>` → done/100, claim released, merge on the trail', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id);

    const out = await applyMergedPr('tracer/avatar', pr(`Avatar upload.\n\nMindBlown: ${n.id}`), opts);

    expect(out).toEqual([{ externalId: `mindblown:${n.id}`, nodeId: n.id, status: 'transitioned', recorded: true }]);
    const after = await read(n.id);
    expect(after.status).toBe('done');
    expect(after.percentComplete).toBe(100);
    expect(after.claimedBySession).toBeNull();
    const ev = await prMergedEvents(n.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].newValue).toMatchObject({ prNumber: 80, repo: 'tracer/avatar', mergeCommitSha: 'm80', alreadyDone: false, url: 'https://git.project.li/tracer/avatar/pulls/80' });
  });

  it('an 8-char prefix and the fleet wording close it too; the forge link gets the merge stamped', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id, {
      externalLinks: [{ provider: 'gitea', externalId: 'tracer/avatar#9', url: 'u', syncEnabled: true, lastSyncedAt: null }],
    });

    const out = await applyMergedPr('Tracer/Avatar', pr(`Worked by fleet-worker for MindBlown node \`${n.id.slice(0, 8)}\`.`), opts);

    expect(out).toMatchObject([{ nodeId: n.id, status: 'transitioned', recorded: true }]);
    const after = await read(n.id);
    expect(after.status).toBe('done');
    expect((after.externalLinks as Array<{ mergeCommitSha?: string; mergedPrNumber?: number }>)[0]).toMatchObject({ mergeCommitSha: 'm80', mergedPrNumber: 80 });
  });

  it("a node on a map bound to another repo is not touched", async () => {
    const s = await seed();
    const n = await s.leaf(s.other.id);

    const out = await applyMergedPr('tracer/avatar', pr(`MindBlown: ${n.id}`), opts);

    expect(out).toEqual([{ externalId: `mindblown:${n.id}`, nodeId: '', status: 'not_linked' }]);
    expect((await read(n.id)).status).toBe('in_progress');
    expect(await prMergedEvents(n.id)).toHaveLength(0);
  });

  it('an ambiguous prefix is not_linked', async () => {
    const s = await seed();
    const a = await s.leaf(s.map.id, { id: 'abcdef12-0000-4000-8000-000000000001' });
    const b = await s.leaf(s.map.id, { id: 'abcdef12-0000-4000-8000-000000000002' });

    const out = await applyMergedPr('tracer/avatar', pr('MindBlown: abcdef12'), opts);

    expect(out).toEqual([{ externalId: 'mindblown:abcdef12', nodeId: '', status: 'not_linked' }]);
    expect((await read(a.id)).status).toBe('in_progress');
    expect((await read(b.id)).status).toBe('in_progress');
  });

  it('a replay writes nothing', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id);
    await applyMergedPr('tracer/avatar', pr(`MindBlown: ${n.id}`), opts);
    const first = await read(n.id);

    const out = await applyMergedPr('tracer/avatar', pr(`MindBlown: ${n.id}`), opts);

    expect(out).toEqual([{ externalId: `mindblown:${n.id}`, nodeId: n.id, status: 'already_done', recorded: false }]);
    expect((await read(n.id)).updatedAt).toEqual(first.updatedAt);
    expect(await prMergedEvents(n.id)).toHaveLength(1);
  });

  it('an already-done node gets the merge recorded once', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id, { status: 'done', percentComplete: 100, claimedBySession: null, claimedAt: null });

    const out = await applyMergedPr('tracer/avatar', pr(`MindBlown: ${n.id}`), opts);

    expect(out).toMatchObject([{ nodeId: n.id, status: 'already_done', recorded: true }]);
    expect((await prMergedEvents(n.id))[0].newValue).toMatchObject({ alreadyDone: true });
  });

  it('`MindBlown refs: <id>` attributes the PR without a status change', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id);

    const out = await applyMergedPr('tracer/avatar', pr(`MindBlown refs: ${n.id}`), opts);

    expect(out).toMatchObject([{ nodeId: n.id, status: 'referenced', recorded: true }]);
    expect((await read(n.id)).status).toBe('in_progress');
    expect(await prMergedEvents(n.id)).toHaveLength(1);
  });

  it('a node a `Closes #N` of the same PR already handled is not handled twice', async () => {
    const s = await seed();
    const n = await s.leaf(s.map.id, {
      externalLinks: [{ provider: 'gitea', externalId: 'tracer/avatar#9', url: 'u', syncEnabled: true, lastSyncedAt: null }],
    });

    const out = await applyMergedPr('tracer/avatar', pr(`Closes #9\n\nMindBlown: ${n.id}`), opts);

    expect(out).toMatchObject([{ externalId: 'tracer/avatar#9', nodeId: n.id, status: 'transitioned' }]);
    await vi.waitFor(async () => expect(await prMergedEvents(n.id)).toHaveLength(1));
  });
});
