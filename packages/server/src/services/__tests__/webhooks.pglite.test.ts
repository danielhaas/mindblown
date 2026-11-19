/**
 * Outgoing webhooks end to end on PGlite: subscriptions in the real table,
 * events from the real sources (a node:updated broadcast, getNextTicket's
 * pull, replaceAsks' push, the behind sweep), delivery through a stubbed
 * fetch — signature, event filter, scope, retries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets, webhookSent, webhookSubscriptions } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import { dbNodeToCore } from '../../db/helpers.js';
import { replaceAsks, setAnswer } from '../../db/asks.js';
import { claimSends } from '../../db/webhooks.js';
import { getNextTicket } from '../orchestration.js';
import {
  createWebhook,
  deleteWebhook,
  emitOpenedAsks,
  forgetAnswered,
  getWebhookForMap,
  handleBroadcast,
  listWebhooks,
  resetWebhooksForTests,
  runBehindSweep,
  startWebhooks,
  updateWebhook,
  webhookStats,
  WebhookForbiddenError,
  WebhookValidationError,
  RETRY_DELAYS_MS,
} from '../webhooks.js';
import type { Ask, Node as CoreNode } from '@mindblown/core';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: { id: string; event: string; mapId: string; workspaceId: string; data: Record<string, unknown> };
}
let sent: Sent[] = [];
let status = 200;
const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
  sent.push({ url, headers: init.headers, body: init.body, json: JSON.parse(init.body) });
  return new Response('', { status });
});

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'o@example.com', name: 'Owner' }).returning();
  const [other] = await db.insert(users).values({ email: 'x@example.com', name: 'Other' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: `w-${Math.random()}`, ownerId: owner.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'M', createdBy: owner.id, maxActiveClaims: 5 }).returning();
  const [map2] = await db.insert(maps).values({ workspaceId: ws.id, name: 'M2', createdBy: owner.id }).returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: owner.id }).returning();
  const leaf = async (over: Partial<typeof nodes.$inferInsert> = {}) => {
    const [n] = await db
      .insert(nodes)
      .values({ mapId: map.id, parentId: root.id, text: 'leaf', createdBy: owner.id, status: 'todo', ...over })
      .returning();
    return dbNodeToCore(n as unknown as Record<string, unknown>);
  };
  return { owner, other, ws, map, map2, leaf };
}

const settle = () => vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

describe('outgoing webhooks', () => {
  beforeEach(async () => {
    await truncateAll(db);
    resetWebhooksForTests();
    startWebhooks({ sweepMs: 0 });
    sent = [];
    status = 200;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetWebhooksForTests();
  });

  it('subscribes, signs a node.done delivery, lists without the secret', async () => {
    const { owner, map, leaf } = await seed();
    const sub = await createWebhook(map.id, { url: 'https://hub.example/hook', events: ['node.done'], description: 'Tracer' }, owner.id);
    expect(sub.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.mapId).toBe(map.id);

    const listed = await listWebhooks(map.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');

    const n = await leaf({ status: 'done' });
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['status'], node: n });
    await settle();

    expect(sent).toHaveLength(1); // node.status_changed filtered out
    const d = sent[0];
    expect(d.url).toBe('https://hub.example/hook');
    expect(d.json).toMatchObject({ event: 'node.done', mapId: map.id, data: { node: { id: n.id }, status: 'done' } });
    expect(d.headers['x-mindblown-event']).toBe('node.done');
    expect(d.headers['x-mindblown-delivery']).toBe(d.json.id);
    const ts = d.headers['x-mindblown-timestamp'];
    const expected = `sha256=${createHmac('sha256', sub.secret).update(`${ts}.${d.body}`).digest('hex')}`;
    expect(d.headers['x-mindblown-signature']).toBe(expected);

    await vi.waitFor(async () => {
      const [row] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id));
      expect(row.lastStatus).toBe(200);
    });
  });

  it('claim and release reach a subscriber of all events; a paused or deleted one hears nothing', async () => {
    const { owner, map, leaf } = await seed();
    const sub = await createWebhook(map.id, { url: 'https://hub.example/all' }, owner.id);
    const claimed = await leaf({ claimedBySession: 'sess-1' });
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: claimed.id, fields: ['claimedBySession', 'claimedAt'], node: claimed });
    const released = { ...claimed, claimedBySession: null } as CoreNode;
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: claimed.id, fields: ['claimedBySession', 'claimedAt'], node: released });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.json.event).sort()).toEqual(['node.claimed', 'node.released']);
    expect(sent.find((s) => s.json.event === 'node.claimed')!.json.data.sessionId).toBe('sess-1');

    await updateWebhook((await getWebhookForMap(map.id, sub.id))!, { active: false }, owner.id);
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: claimed.id, fields: ['claimedBySession'], node: claimed });
    await deleteWebhook((await getWebhookForMap(map.id, sub.id))!, owner.id);
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: claimed.id, fields: ['claimedBySession'], node: claimed });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(2);
  });

  it('a workspace-wide subscription hears every map; only the workspace owner may make one', async () => {
    const { owner, other, map, map2 } = await seed();
    await expect(createWebhook(map.id, { url: 'https://hub.example/ws', scope: 'workspace' }, other.id)).rejects.toBeInstanceOf(WebhookForbiddenError);
    const sub = await createWebhook(map.id, { url: 'https://hub.example/ws', scope: 'workspace', events: ['node.blocked'] }, owner.id);
    expect(sub.mapId).toBeNull();
    expect((await listWebhooks(map2.id)).map((w) => w.id)).toEqual([sub.id]);

    const n = { id: 'n2', mapId: map2.id, text: 'x', status: null, claimedBySession: null, blockedReason: 'waiting on Dan', dueDate: null, percentComplete: null } as unknown as CoreNode;
    await handleBroadcast(map2.id, { type: 'node:updated', nodeId: 'n2', fields: ['blockedReason'], node: n });
    await settle();
    expect(sent[0].json).toMatchObject({ event: 'node.blocked', mapId: map2.id, data: { reason: 'waiting on Dan' } });
  });

  it('rejects a bad URL or event', async () => {
    const { owner, map } = await seed();
    await expect(createWebhook(map.id, { url: 'ftp://x' }, owner.id)).rejects.toBeInstanceOf(WebhookValidationError);
    await expect(createWebhook(map.id, { url: 'https://u:p@x.example' }, owner.id)).rejects.toBeInstanceOf(WebhookValidationError);
    await expect(createWebhook(map.id, { url: 'https://x.example', events: ['node.exploded'] }, owner.id)).rejects.toThrow(/Unknown event/);
  });

  it('retries a 503 on the schedule, stops on a 4xx', async () => {
    const { owner, map, leaf } = await seed();
    await createWebhook(map.id, { url: 'https://hub.example/flaky', events: ['node.blocked'] }, owner.id);
    const n = await leaf({ blockedReason: 'stuck' });
    status = 503;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['blockedReason'], node: n });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].json.id).toBe(sent[0].json.id); // same delivery id across retries
    status = 400;
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[2] + RETRY_DELAYS_MS[3]);
    expect(sent).toHaveLength(3);
  });

  it('queue.empty fires once when a pull runs dry, again only after a grant', async () => {
    const { owner, map, leaf } = await seed();
    await db.update(maps).set({ fleetId: null }).where(eq(maps.id, map.id));
    await createWebhook(map.id, { url: 'https://hub.example/q', events: ['queue.empty'] }, owner.id);

    expect((await getNextTicket(map.id, 's1')).granted).toBe(false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].json).toMatchObject({ event: 'queue.empty', mapId: map.id, data: { mapName: 'M' } });
    await getNextTicket(map.id, 's1');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);

    await leaf({
      approval: { state: 'approved' },
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'do it' }] }] },
    });
    expect((await getNextTicket(map.id, 's1')).granted).toBe(true);
    expect((await getNextTicket(map.id, 's2')).granted).toBe(false);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });

  it('node.question for each ask a push opens, not for one it only refreshes', async () => {
    const { owner, map } = await seed();
    const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: owner.id }).returning();
    await createWebhook(map.id, { url: 'https://hub.example/ask', events: ['node.question'] }, owner.id);
    const ask = {
      id: 'fleet-abc', ticket: 12, requirement: null, title: 'Ship it', url: null, sources: ['fleet-worker'],
      question: 'Which DB?', question_author: 'worker', options: ['pg', 'sqlite'], answerer: 'dan', hint: 'decide',
      priority: null, milestone: null, needs_version: false, idle_hours: null, moot: false,
      unblocks: { node_id: 'n-1', node_title: 'Ship it', node_status: 'blocked', claimed_by: 's1', worker: null, pr: null, pr_state: null },
    } as unknown as Ask;
    const meta = {} as never;

    const first = await replaceAsks(fleet.id, map.id, [{ ask, mapId: map.id }], meta);
    expect(first.opened).toHaveLength(1);
    emitOpenedAsks(first.opened);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].json).toMatchObject({
      event: 'node.question',
      data: { askId: 'fleet-abc', question: 'Which DB?', options: ['pg', 'sqlite'], node: { id: 'n-1' } },
    });

    const again = await replaceAsks(fleet.id, map.id, [{ ask, mapId: map.id }], meta);
    expect(again.opened).toEqual([]);
  });

  it('node.behind: the first sweep seeds, a later one announces a leaf that turned behind', async () => {
    const { owner, map, leaf } = await seed();
    await createWebhook(map.id, { url: 'https://hub.example/late', events: ['node.behind'] }, owner.id);
    await leaf({ text: 'already late', dueDate: '2026-01-01', percentComplete: 10 });
    const soon = await leaf({ text: 'due soon', dueDate: '2026-06-01', startDate: '2026-01-01', percentComplete: 90 });
    await leaf({ text: 'late but done', dueDate: '2026-01-01', status: 'done', percentComplete: 100 });

    expect(await runBehindSweep(new Date('2026-03-01T00:00:00Z'))).toBe(0);
    expect(await runBehindSweep(new Date('2026-07-01T00:00:00Z'))).toBe(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].json).toMatchObject({ event: 'node.behind', data: { node: { id: soon.id }, dueDate: '2026-06-01' } });
    expect(await runBehindSweep(new Date('2026-07-02T00:00:00Z'))).toBe(0);
  });

  describe('the dedupe ledger (Tracer\'s hub got ~300 node.question an hour, 19.11.2026)', () => {
    const askOf = (id: string, over: Partial<Ask> = {}) =>
      ({
        id, ticket: null, requirement: null, title: id, url: null, sources: ['orchestrator'], question: `What about ${id}?`,
        question_author: 'orchestrator', options: [], answerer: 'Dan', hint: 'decision', priority: null, milestone: null,
        needs_version: false, idle_hours: null, moot: false,
        unblocks: { node_id: null, node_title: null, node_status: null, claimed_by: null, worker: null, pr: null, pr_state: null },
        ...over,
      }) as unknown as Ask;
    const meta = {} as never;
    /** An API restart: every in-memory webhook state is gone, the database stays. */
    const restart = () => {
      resetWebhooksForTests();
      startWebhooks({ sweepMs: 0 });
    };
    const questions = () => sent.filter((d) => d.json.event === 'node.question').map((d) => d.json.data.askId);

    async function setup() {
      const s = await seed();
      const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: s.owner.id }).returning();
      await createWebhook(s.map.id, { url: 'https://hub.example/ask', events: ['node.question', 'node.blocked', 'queue.empty'] }, s.owner.id);
      const push = async (asks: Ask[]) => {
        const r = await replaceAsks(fleet.id, s.map.id, asks.map((ask) => ({ ask, mapId: s.map.id })), meta);
        await emitOpenedAsks(r.opened);
        return r;
      };
      return { ...s, fleet, push };
    }
    const quiet = () => new Promise((r) => setTimeout(r, 20));

    it('a restart between two identical pushes sends nothing new', async () => {
      const { push } = await setup();
      await push([askOf('#1')]);
      restart();
      await push([askOf('#1')]);
      await quiet();
      expect(questions()).toEqual(['#1']);
    });

    it('two collectors pushing different sets — each push "re-opens" the other\'s ask — send each ask once', async () => {
      const { push, map } = await setup();
      for (let tick = 0; tick < 3; tick++) {
        await push([askOf('#1')]); // host A
        await push([askOf('#2')]); // host B: #1 drops out, comes back on A's next tick
        restart();
      }
      await quiet();
      expect(questions().sort()).toEqual(['#1', '#2']);
      expect(await webhookStats(map.id)).toEqual([{ event: 'node.question', sentLastHour: 2, sent24h: 2, suppressed24h: 4 }]);
    });

    it('answered, then re-opened: one new event', async () => {
      const { push, map, fleet } = await setup();
      const ask = askOf('fleet-abc', { sources: ['fleet-worker'], question: 'Which DB?' });
      await push([ask]);
      await setAnswer({ fleetId: fleet.id, mapId: map.id, askId: 'fleet-abc' }, { status: 'answered', answer: { action: 'answered', decision: 'pg' }, answeredBy: 'Dan', answeredAt: new Date(), writes: [], workerPending: false });
      await forgetAnswered(map.id, 'fleet-abc');
      await push([ask]); // same text: stays answered
      await push([{ ...ask, question: 'And the cache?' } as Ask]); // the worker's next question
      await quiet();
      expect(questions()).toEqual(['fleet-abc', 'fleet-abc']);
    });

    it('a derived ask regenerated every tick is one event', async () => {
      const { push } = await setup();
      for (let tick = 0; tick < 4; tick++) {
        await push([askOf('blocker-1234abcd', { question: `Blocked: red CI (tick ${tick})` })]);
        await push([]); // the collector dropped it this tick
      }
      await quiet();
      expect(questions()).toEqual(['blocker-1234abcd']);
    });

    it('the 24 h window survives a restart; after 24 h the same key may go again', async () => {
      const { map } = await setup();
      const t0 = new Date('2026-11-19T08:00:00Z');
      expect([...(await claimSends('node.question', map.id, ['#1'], t0))]).toEqual(['#1']);
      restart();
      expect((await claimSends('node.question', map.id, ['#1'], new Date(t0.getTime() + 23 * 3_600_000))).size).toBe(0);
      expect((await claimSends('node.question', map.id, ['#1'], new Date(t0.getTime() + 24 * 3_600_000))).size).toBe(1);
      expect(await db.select().from(webhookSent)).toHaveLength(1);
    });

    it('node.blocked once per node until the blocker is cleared, across a restart', async () => {
      const { map, leaf } = await setup();
      const n = await leaf({ blockedReason: 'red CI' });
      const blocked = () => sent.filter((d) => d.json.event === 'node.blocked').length;
      await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['blockedReason'], node: n });
      restart();
      await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['blockedReason'], node: { ...n, blockedReason: 'red CI again' } });
      await quiet();
      expect(blocked()).toBe(1);
      await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['blockedReason'], node: { ...n, blockedReason: null } });
      await handleBroadcast(map.id, { type: 'node:updated', nodeId: n.id, fields: ['blockedReason'], node: n });
      await vi.waitFor(() => expect(blocked()).toBe(2));
    });

    it('queue.empty: a restart does not re-announce a queue that is still dry', async () => {
      const { map } = await setup();
      await db.update(maps).set({ fleetId: null }).where(eq(maps.id, map.id));
      await getNextTicket(map.id, 's1');
      await vi.waitFor(() => expect(sent.filter((d) => d.json.event === 'queue.empty')).toHaveLength(1));
      restart();
      await getNextTicket(map.id, 's1');
      await quiet();
      expect(sent.filter((d) => d.json.event === 'queue.empty')).toHaveLength(1);
    });
  });
});
