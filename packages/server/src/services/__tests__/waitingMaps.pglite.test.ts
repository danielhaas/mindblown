/**
 * Archived maps stay out of every "waiting on a person" list over several
 * maps — prs_waiting, approvals, asks, waiting_on_humans, the digest mail —
 * and still answer when the map is named (lib/waitingMaps). On PGlite: one
 * live and one archived map in the same fleet, each with an open PR mirror,
 * a proposed ticket and an ask.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../lib/githubContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/githubContext.js')>()),
  getGitHubContextForMap: vi.fn(async () => null),
}));

import type { Ask, LinkedPrState } from '@mindblown/core';
import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { replaceAsks } from '../../db/asks.js';
import { prsWaiting } from '../prMerge.js';
import { listPendingApprovals } from '../approvals.js';
import { fleetInbox, mapInbox } from '../asksInbox.js';
import { waitingOnHumansForUser } from '../waitingOnHumans.js';
import { openItemsForUser } from '../digestMail.js';

const pr = (n: number): LinkedPrState => ({
  number: n, repo: 'o/r', url: `https://github.com/o/r/pull/${n}`, head: `fleet/${n}`, base: 'main', author: 'fleet-bot',
  draft: false, state: 'open', mergeable: true, changedFiles: ['a.ts'], reviews: [],
  checks: { state: 'success', failures: [] }, lastSyncedAt: '2026-11-18T07:00:00Z',
});

function ask(id: string): Ask {
  return {
    id, ticket: null, requirement: null, title: `Ask ${id}`, url: null, sources: ['fleet-worker'], question: 'Which?', question_author: 'worker',
    options: [], answerer: 'Dan', hint: 'decision', priority: null, milestone: null, needs_version: false, idle_hours: null, moot: false,
    unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
  };
}

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'dan@example.com', name: 'Dan' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${Math.random()}`, ownerId: owner.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: owner.id }).returning();
  const mapWith = async (name: string, archivedAt: Date | null, prNumber: number) => {
    const [map] = await db.insert(maps).values({ workspaceId: ws.id, name, createdBy: owner.id, fleetId: fleet.id, archivedAt }).returning();
    const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: owner.id }).returning();
    await db.insert(nodes).values([
      { mapId: map.id, parentId: root.id, text: `${name} PR`, createdBy: owner.id, status: 'in_progress', linkedPr: pr(prNumber) },
      { mapId: map.id, parentId: root.id, text: `${name} proposed`, createdBy: owner.id, status: 'todo', approval: { state: 'proposed', merge: 'manual', by: null, at: null } },
    ]);
    await replaceAsks(fleet.id, map.id, [{ ask: ask(`#${prNumber}`), mapId: map.id }], {} as never);
    return map;
  };
  const live = await mapWith('Navy App', null, 1);
  const archived = await mapWith('Fulcrum CRM Roadmap', new Date('2026-09-26T00:00:00Z'), 2);
  return { owner, fleet, live, archived };
}

const mapIdsOf = (out: unknown) => [...new Set((out as { items: Array<{ mapId?: string | null }> }).items.map((i) => i.mapId))];

describe('archived maps in "waiting on a person" lists', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    await truncateAll(db);
    s = await seed();
  });

  it('prs_waiting: unscoped and fleet leave the archived map out; naming it answers, marked [ARCHIVED]', async () => {
    expect(mapIdsOf(await prsWaiting(s.owner.id, {}))).toEqual([s.live.id]);
    expect(mapIdsOf(await prsWaiting(s.owner.id, { fleetId: s.fleet.id }))).toEqual([s.live.id]);

    const named = await prsWaiting(s.owner.id, { mapId: s.archived.id });
    expect(named).toMatchObject({ items: [{ mapId: s.archived.id, number: 2, mapArchived: true }] });

    const liveNamed = await prsWaiting(s.owner.id, { mapId: s.live.id });
    expect((liveNamed as { items: Array<{ mapArchived?: boolean }> }).items[0].mapArchived).toBeUndefined();
  });

  it('approvals: unscoped (page, header badge) and fleet leave the archived map out; naming it answers', async () => {
    expect(mapIdsOf(await listPendingApprovals(s.owner.id, {}))).toEqual([s.live.id]);
    expect(mapIdsOf(await listPendingApprovals(s.owner.id, { fleetId: s.fleet.id }))).toEqual([s.live.id]);
    expect(mapIdsOf(await listPendingApprovals(s.owner.id, { mapId: s.archived.id }))).toEqual([s.archived.id]);
  });

  it("asks: the fleet inbox leaves the archived map's asks out; the map's own inbox has them", async () => {
    const fleet = await fleetInbox(s.owner.id, s.fleet.id, { status: 'open' });
    expect(mapIdsOf(fleet)).toEqual([s.live.id]);
    expect((fleet as { maps: Array<{ id: string }> }).maps.map((m) => m.id)).toEqual([s.live.id]);
    expect(mapIdsOf(await mapInbox(s.owner.id, s.archived.id, { status: 'open' }))).toEqual([s.archived.id]);
  });

  it('waiting_on_humans counts only the live map', async () => {
    const out = await waitingOnHumansForUser(s.owner.id);
    const json = JSON.stringify(out);
    expect(json).toContain(s.live.id);
    expect(json).not.toContain(s.archived.id);
  });

  it('the digest mail leaves the archived map out', async () => {
    const items = await openItemsForUser(s.owner.id, new Date('2026-11-19T06:00:00Z'));
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.groupName)).not.toContain('Fulcrum CRM Roadmap');
  });
});
