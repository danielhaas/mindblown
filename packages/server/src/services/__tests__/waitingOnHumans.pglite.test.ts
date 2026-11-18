/**
 * waiting_on_humans and the fleet.waiting_on_human webhook on PGlite:
 * real asks, rollups, proposed tickets and subscriptions; delivery through
 * a stubbed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { replaceAsks } from '../../db/asks.js';
import { upsertRollup } from '../../db/fleet.js';
import { createWebhook, resetWebhooksForTests, runWaitingOnHumanSweep, startWebhooks } from '../webhooks.js';
import { readFleetWaiting, waitingOnHumansForUser } from '../waitingOnHumans.js';
import type { Ask, FleetRollup, FleetWorkerStatus } from '@mindblown/core';

interface Sent {
  headers: Record<string, string>;
  body: string;
  json: { event: string; mapId: string; data: Record<string, unknown> & { top: Record<string, Array<{ ref: string }>> } };
}
let sent: Sent[] = [];
const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
  sent.push({ headers: init.headers, body: init.body, json: JSON.parse(init.body) });
  return new Response('', { status: 200 });
});

const T0 = new Date('2026-11-18T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function ask(id: string, over: Partial<Ask> = {}): Ask {
  return {
    id, ticket: null, requirement: null, title: `Ask ${id}`, url: null, sources: ['fleet-worker'], question: 'Which?', question_author: 'worker',
    options: [], answerer: 'Dan', hint: 'decision', priority: null, milestone: null, needs_version: false, idle_hours: null, moot: false,
    unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
    ...over,
  };
}

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'r@example.com', name: 'Rita Muster' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${Math.random()}`, ownerId: owner.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'claudia', ownerId: owner.id }).returning();
  const [map] = await db
    .insert(maps)
    .values({ workspaceId: ws.id, name: 'M', createdBy: owner.id, fleetId: fleet.id, githubRepoOwner: 'acme', githubRepoName: 'app' })
    .returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: owner.id }).returning();
  const leaf = async (over: Partial<typeof nodes.$inferInsert> = {}) => {
    const [n] = await db.insert(nodes).values({ mapId: map.id, parentId: root.id, text: 'leaf', createdBy: owner.id, status: 'todo', ...over }).returning();
    return n;
  };
  const prNode = await leaf({ text: 'PR ticket' });
  const proposed = await leaf({ text: 'Proposed ticket', approval: { state: 'proposed', merge: 'manual', by: null, at: null } });
  await replaceAsks(fleet.id, map.id, [
    { ask: ask('#1', { unblocks: { ...ask('x').unblocks, node_id: prNode.id } }), mapId: map.id },
    { ask: ask('#2'), mapId: map.id },
    { ask: ask('#3', { hint: 'ops-task' }), mapId: map.id },
    { ask: ask('#4', { moot: true }), mapId: map.id },
  ], {} as never);
  return { owner, ws, fleet, map, prNode, proposed, leaf };
}

async function report(fleetId: string, mapId: string, workers: Partial<FleetWorkerStatus>[], claims: FleetRollup['claims'], when: Date) {
  const g = when.toISOString();
  const rollup: FleetRollup = {
    v: 2, host: 'claudia', generated_at: g, maps: [mapId], claims,
    workers: workers.map((w, i) => ({ session: `s${i}`, state: 'parked', state_since: '2026-11-18T11:00:00Z', ...w })),
  };
  await upsertRollup(fleetId, rollup, null);
}

describe('waiting on humans', () => {
  beforeEach(async () => {
    await truncateAll(db);
    resetWebhooksForTests();
    startWebhooks({ sweepMs: 0 });
    sent = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetWebhooksForTests();
  });

  it('counts per person: asks by answerer, PR merges and approvals for the map owner; idle since the last worker parked', async () => {
    const { owner, fleet, map, prNode, proposed } = await seed();
    await report(fleet.id, map.id, [{ state: 'parked' }, { state: 'auth-parked', state_since: '2026-11-18T11:30:00Z' }], [
      { nodeId: prNode.id, mapId: map.id, phase: 'pr', ci: 'manual', pr_number: 42, phase_since: '2026-11-18T10:00:00Z' },
    ], T0);

    const { summary } = await readFleetWaiting({ fleetId: fleet.id, fleetName: 'claudia', mapIds: [map.id], fleetLevel: true }, T0);
    expect(summary).toMatchObject({ idle: true, idleSince: '2026-11-18T11:30:00.000Z', activeClaims: 0, workers: { total: 2, working: 0, waiting: 2 } });
    const byPerson = Object.fromEntries(summary.people.map((p) => [p.person, p]));
    expect(byPerson.Dan).toMatchObject({ decisions: 2, steps: 1, prs: 0, approvals: 0 });
    expect(byPerson.Rita).toMatchObject({ decisions: 0, steps: 0, prs: 1, approvals: 1, unblocks: 2 });
    expect(byPerson.Rita.top.prs[0]).toMatchObject({ ref: 'acme/app#42', nodeId: prNode.id });
    expect(byPerson.Rita.top.approvals[0]).toMatchObject({ ref: proposed.id });
    // #1 and the PR unblock the same ticket.
    expect(summary.total).toMatchObject({ decisions: 2, steps: 1, prs: 1, approvals: 1, unblocks: 4 });

    // Through the reader's scope (the REST / MCP path).
    const all = await waitingOnHumansForUser(owner.id);
    expect(Array.isArray(all) && all[0].total.decisions).toBe(2);
  });

  it('fires one signed event per person when the fleet goes idle; nothing while workers work or claims are active', async () => {
    const { owner, fleet, map, leaf } = await seed();
    const sub = await createWebhook(map.id, { url: 'https://hub.example/tracer', events: ['fleet.waiting_on_human'] }, owner.id);

    // Working: no event.
    await report(fleet.id, map.id, [{ state: 'working', last_activity: T0.toISOString() }], [], T0);
    expect(await runWaitingOnHumanSweep(T0)).toBe(0);

    // Parked, but a claim is still active: no event.
    const claimed = await leaf({ claimedBySession: 's0', claimedAt: T0 });
    await report(fleet.id, map.id, [{ state: 'parked' }], [], T0);
    expect(await runWaitingOnHumanSweep(T0)).toBe(0);
    expect(sent).toHaveLength(0);

    // Idle: one event for Dan (the asks), one for Rita (the approval).
    await db.update(nodes).set({ claimedBySession: null, claimedAt: null }).where(eq(nodes.id, claimed.id));
    expect(await runWaitingOnHumanSweep(T0)).toBe(2);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const dan = sent.find((s) => s.json.data.person === 'Dan')!;
    expect(dan.json).toMatchObject({ event: 'fleet.waiting_on_human', mapId: map.id, data: { fleetId: fleet.id, fleetName: 'claudia', decisions: 2, steps: 1 } });
    expect(dan.json.data.top.decisions.map((i) => i.ref)).toEqual(['#1', '#2']);
    const ts = dan.headers['x-mindblown-timestamp'];
    expect(dan.headers['x-mindblown-signature']).toBe(`sha256=${createHmac('sha256', sub.secret).update(`${ts}.${dan.body}`).digest('hex')}`);
  });

  it('throttles: once per idle stretch, again when counts grow but not within 2 h', async () => {
    const { owner, fleet, map } = await seed();
    await createWebhook(map.id, { url: 'https://hub.example/tracer', events: ['fleet.waiting_on_human'] }, owner.id);
    await report(fleet.id, map.id, [{ state: 'parked' }], [], T0);
    expect(await runWaitingOnHumanSweep(T0)).toBe(2);

    // Same counts later: nothing.
    vi.setSystemTime(at(30));
    await report(fleet.id, map.id, [{ state: 'parked' }], [], at(30));
    expect(await runWaitingOnHumanSweep(at(30))).toBe(0);

    // A new decision for Dan within 2 h: held back …
    await replaceAsks(fleet.id, map.id, [
      { ask: ask('#1'), mapId: map.id }, { ask: ask('#2'), mapId: map.id }, { ask: ask('#3', { hint: 'ops-task' }), mapId: map.id }, { ask: ask('#5'), mapId: map.id },
    ], {} as never);
    expect(await runWaitingOnHumanSweep(at(30))).toBe(0);

    // … and sent once the 2 h are up — Dan only, Rita's count did not grow.
    vi.setSystemTime(at(121));
    await report(fleet.id, map.id, [{ state: 'parked' }], [], at(121));
    sent = [];
    expect(await runWaitingOnHumanSweep(at(121))).toBe(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].json.data).toMatchObject({ person: 'Dan', decisions: 3 });
  });
});
