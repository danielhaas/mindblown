/**
 * The daily self-check end to end on PGlite: a seeded map with one finding
 * per category → the safe fixes applied, the person-needed findings on the
 * Questions card once (the same rows the next day while unchanged, an
 * answered one not again), the hygiene line built; archived maps skipped;
 * autoFix off → asks instead of fixes. Only the forge and the socket are
 * stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: vi.fn(async () => {}) }));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
  getForgeContextForMap: vi.fn(async () => null),
  getForgeBindingForMap: vi.fn(async () => null),
}));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets, changeEvents, lintRuns } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { runDailyLint } from '../daily.js';
import { derivedAskRows, openDerivedAsks } from '../../services/derivedAsks.js';
import { answerAsk } from '../../services/asks.js';
import { hygieneLines } from '../../services/digestMail.js';
import { lintAskId, lintDigestLine } from '@mindblown/core';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-20T05:30:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

async function seed() {
  const [user] = await db.insert(users).values({ email: 'dan@example.com', name: 'Dan Haas' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: user.id }).returning();
  const newMap = async (name: string, extra: Partial<typeof maps.$inferInsert> = {}) => {
    const [map] = await db
      .insert(maps)
      .values({ workspaceId: ws.id, name, createdBy: user.id, fleetId: fleet.id, maxActiveClaims: 2, ...extra })
      .returning();
    const [root] = await db.insert(nodes).values({ mapId: map.id, text: name, createdBy: user.id }).returning();
    await db.update(maps).set({ rootNodeId: root.id }).where(eq(maps.id, map.id));
    const add = async (text: string, fields: Partial<typeof nodes.$inferInsert> = {}) => {
      const [n] = await db.insert(nodes).values({ mapId: map.id, parentId: root.id, text, createdBy: user.id, status: 'todo', updatedAt: ago(1), ...fields }).returning();
      await db.update(nodes).set({ childrenOrder: sql`children_order || ${JSON.stringify([n.id])}::jsonb` }).where(eq(nodes.id, root.id));
      return n;
    };
    return { map, root, add };
  };

  // Navy: one finding per category. A repo named but nothing binds it → broken-repo-connection.
  const navy = await newMap('Navy App', { githubRepoOwner: 'o', githubRepoName: 'r' });
  const doneLow = await navy.add('Done at 60 %', { status: 'done', percentComplete: 60, effortEstimate: 1 });
  const workerNote = await navy.add('Done, worker note left', {
    status: 'done', percentComplete: 100, effortEstimate: 1, blockedReason: 'Fleet worker w1: CI failed on PR #9',
  });
  const merged = await navy.add('Stalled, PR merged', {
    status: 'in_progress', percentComplete: 50, effortEstimate: 1, updatedAt: ago(3),
    externalLinks: [{ provider: 'github', externalId: 'o/r#12', url: 'https://github.com/o/r/issues/12', syncEnabled: false, lastSyncedAt: null, mergedPrNumber: 13 }],
  });
  const orphan = await navy.add('Stalled, worker gone', { status: 'in_progress', percentComplete: 40, effortEstimate: 1, updatedAt: ago(30) });
  await db.insert(changeEvents).values({ mapId: navy.map.id, nodeId: orphan.id, eventType: 'node.released', oldValue: 'w2', newValue: { session: 'w2', reason: 'swept' }, createdAt: ago(30) });
  const issueOpen = await navy.add('Done, issue still open', {
    status: 'done', percentComplete: 100, effortEstimate: 1,
    externalLinks: [{ provider: 'github', externalId: 'o/r#5', url: 'https://github.com/o/r/issues/5', syncEnabled: false, lastSyncedAt: null, state: 'open' }],
  });
  const child = async (parentId: string, text: string) => {
    const [c] = await db.insert(nodes).values({ mapId: navy.map.id, parentId, text, createdBy: user.id, status: 'todo', percentComplete: 0 }).returning();
    await db.update(nodes).set({ childrenOrder: [c.id] }).where(eq(nodes.id, parentId));
  };
  const heldParent = await navy.add('Payments', { blockedReason: 'Waiting for legal' });
  await child(heldParent.id, 'Card form');
  const doneParent = await navy.add('Onboarding', { status: 'done' });
  await child(doneParent.id, 'Welcome mail');

  const archived = await newMap('Old', { archivedAt: ago(100) });
  const archivedLeaf = await archived.add('Done at 10 %', { status: 'done', percentComplete: 10 });

  const manual = await newMap('Manual', { lintAutoFix: { 'status-progress-mismatch': false } });
  const manualLeaf = await manual.add('Done at 70 %', { status: 'done', percentComplete: 70, effortEstimate: 1 });

  return { user, fleet, navy, doneLow, workerNote, merged, orphan, issueOpen, heldParent, doneParent, archived, archivedLeaf, manual, manualLeaf };
}

async function node(id: string) {
  const [r] = await db.select().from(nodes).where(eq(nodes.id, id));
  return r;
}

describe('daily self-check', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
  });

  it('applies the safe fixes, asks the rest once, counts hygiene; skips archived maps; autoFix off asks', async () => {
    const s = await seed();
    const day1 = await runDailyLint({ now: NOW, day: '2026-11-20' });

    // Archived map: no run, node untouched.
    expect(day1.runs.map((r) => r.mapName).sort()).toEqual(['Manual', 'Navy App']);
    expect((await node(s.archivedLeaf.id)).percentComplete).toBe(10);
    expect(await db.select().from(lintRuns).where(eq(lintRuns.mapId, s.archived.map.id))).toEqual([]);

    const navy = day1.runs.find((r) => r.mapName === 'Navy App')!;
    expect(navy.error).toBeNull();
    // Auto: each applied fix listed.
    const fixed = navy.fixed.map((f) => `${f.ruleId}:${f.action}:${f.nodeText}:${f.ok}`).sort();
    expect(fixed).toEqual([
      'stale-blocked-reason:clear-blocker:Done, worker note left:true',
      'stalled-unclaimed:mark-done:Stalled, PR merged:true',
      'stalled-unclaimed:requeue:Stalled, worker gone:true',
      'status-progress-mismatch:mark-done:Done at 60 %:true',
    ]);
    expect((await node(s.doneLow.id)).percentComplete).toBe(100);
    expect((await node(s.workerNote.id)).blockedReason).toBeNull();
    expect((await node(s.merged.id))).toMatchObject({ status: 'done', percentComplete: 100 });
    expect((await node(s.orphan.id))).toMatchObject({ status: 'todo', percentComplete: 40 });

    // Ask: the person-needed findings, map-level ones on the root.
    const asked = navy.asked.map((a) => `${a.ruleId}:${a.nodeText}`).sort();
    expect(asked).toEqual([
      'blocker-without-question:Payments',
      'broken-repo-connection:Navy App',
      'done-parent-open-child:Onboarding',
      'issue-state-mismatch:Done, issue still open',
    ]);
    // Digest: the hygiene counts and the mail's line.
    expect(navy.digest['unestimated-leaf']).toBe(2);
    expect(lintDigestLine(navy.digest)).toBe('2 without estimate');
    const lines = hygieneLines([navy], new Map([[s.navy.map.id, 'Navy App']]), NOW);
    expect(lines).toEqual([{ mapId: s.navy.map.id, mapName: 'Navy App', line: '2 without estimate', url: expect.stringContaining(`map=${s.navy.map.id}&lint=1`) }]);

    // autoFix off for the rule → asked, not fixed.
    const manual = day1.runs.find((r) => r.mapName === 'Manual')!;
    expect(manual.fixed).toEqual([]);
    expect(manual.asked.map((a) => a.ruleId)).toEqual(['status-progress-mismatch']);
    expect((await node(s.manualLeaf.id)).percentComplete).toBe(70);

    // On the Questions card: one row per finding, options from its fixes.
    const scope = { fleetId: s.fleet.id, mapId: s.navy.map.id };
    const rows = (await openDerivedAsks(scope, [s.navy.map.id], NOW)).filter((r) => r.ask.id.startsWith('lint-'));
    expect(rows.map((r) => r.ask.id).sort()).toEqual(
      [
        lintAskId('blocker-without-question', s.heldParent.id),
        lintAskId('broken-repo-connection', s.navy.root.id),
        lintAskId('done-parent-open-child', s.doneParent.id),
        lintAskId('issue-state-mismatch', s.issueOpen.id),
      ].sort(),
    );
    const issueAsk = rows.find((r) => r.ask.id === lintAskId('issue-state-mismatch', s.issueOpen.id))!;
    expect(issueAsk.ask.options).toEqual(['Close the issue', 'Reopen the node (todo, 0 %)', 'Leave it']);
    expect(issueAsk.ask.answerer).toBe('Dan');

    // "Leave it" is recorded and nothing changes.
    await answerAsk({ fleetId: s.fleet.id, mapId: s.navy.map.id, askId: issueAsk.ask.id }, { action: 'answered', decision: 'Leave it', by: 'Dan' }, s.user.id);
    expect((await node(s.issueOpen.id)).status).toBe('done');
    // An option runs the fix: the done parent is reopened.
    await answerAsk(
      { fleetId: s.fleet.id, mapId: s.navy.map.id, askId: lintAskId('done-parent-open-child', s.doneParent.id) },
      { action: 'answered', decision: 'Reopen the node (todo, 0 %)', by: 'Dan' },
      s.user.id,
    );
    expect((await node(s.doneParent.id)).status).toBe('todo');

    // Next day: nothing left to fix; the unchanged findings are the same rows
    // (first seen yesterday), the answered one not asked again.
    const day2 = await runDailyLint({ now: new Date(NOW.getTime() + 24 * HOUR), day: '2026-11-21' });
    const navy2 = day2.runs.find((r) => r.mapName === 'Navy App')!;
    expect(navy2.fixed).toEqual([]);
    const held = navy2.asked.find((a) => a.ruleId === 'blocker-without-question')!;
    expect(held.firstSeenAt).toBe(NOW.toISOString());
    expect(navy2.asked.some((a) => a.ruleId === 'done-parent-open-child')).toBe(false);
    const open2 = (await openDerivedAsks(scope, [s.navy.map.id], new Date(NOW.getTime() + 24 * HOUR))).map((r) => r.ask.id);
    expect(open2).toContain(lintAskId('blocker-without-question', s.heldParent.id));
    expect(open2).not.toContain(lintAskId('issue-state-mismatch', s.issueOpen.id));

    // A second tick the same day does nothing; on demand (force) runs again.
    expect((await runDailyLint({ now: new Date(NOW.getTime() + 25 * HOUR), day: '2026-11-21' })).runs).toEqual([]);
    expect((await runDailyLint({ now: new Date(NOW.getTime() + 25 * HOUR), day: '2026-11-21', force: true })).runs).toHaveLength(2);
  });

  it('a node that already has a row on the card gets no lint row', async () => {
    const s = await seed();
    // A leaf blocker is its own blocker-<node> row — blocker-without-question must not ask twice.
    const leaf = await s.navy.add('Blocked leaf', { blockedReason: 'Waiting for the keys', effortEstimate: 1 });
    await runDailyLint({ now: NOW, day: '2026-11-20' });
    const rows = await derivedAskRows([s.navy.map.id], NOW);
    expect(rows.filter((r) => r.ask.unblocks.node_id === leaf.id).map((r) => r.ask.id)).toEqual([`blocker-${leaf.id}`]);
  });
});
