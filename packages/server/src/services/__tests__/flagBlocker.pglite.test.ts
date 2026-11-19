/**
 * Every blocker reaches a person or resolves itself (19.11.2026). Free-text
 * blockers held tickets out of the queue but never reached the Questions
 * card. End to end on PGlite: flag_blocker's service with each kind, the
 * hourly classification of unkinded blockers, the derived rows on the card
 * and answer_ask on them. Only the forge and the socket are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db/connection.js', async () =>
  (await import('../../test/pgliteDb.js')).pgliteConnection());
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../routes/nodes.js', () => ({ syncNodeToGitHub: vi.fn(async () => {}) }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { db } from '../../db/connection.js';
import { users, workspaces, maps, nodes, fleets } from '../../db/schema.js';
import { truncateAll } from '../../test/pgliteDb.js';
import * as nodeDb from '../../db/nodes.js';
import { flagBlocker, classifyUnkindedBlockers, FlagBlockerError, mapOwnerAnswerer } from '../flagBlocker.js';
import { setAnswerer } from '../../db/answerer.js';
import { derivedAskRows } from '../derivedAsks.js';
import { answerAsk } from '../asks.js';

const HOUR = 3_600_000;
const link = (n: number, pr = false) => [
  { provider: 'github', externalId: `o/r#${n}`, url: `https://github.com/o/r/${pr ? 'pull' : 'issues'}/${n}`, syncEnabled: false, lastSyncedAt: null, isPullRequest: pr },
];

async function seed() {
  const [user] = await db.insert(users).values({ email: 'dan@example.com', name: 'Dan Haas' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: user.id }).returning();
  const [fleet] = await db.insert(fleets).values({ name: 'F', ownerId: user.id }).returning();
  const [map] = await db.insert(maps).values({ workspaceId: ws.id, name: 'M', createdBy: user.id, maxActiveClaims: 2 }).returning();
  const [root] = await db.insert(nodes).values({ mapId: map.id, text: 'root', createdBy: user.id }).returning();
  const leaf = async (text: string, extra: Partial<typeof nodes.$inferInsert> = {}) =>
    (await db.insert(nodes).values({ mapId: map.id, parentId: root.id, text, createdBy: user.id, status: 'todo', approval: { state: 'approved' }, ...extra }).returning())[0];
  const ticket = await leaf('Ship the payment page', { description: 'Build it.' });
  const api = await leaf('Merge the API PR', { externalLinks: link(62, true) });
  const done = await leaf('Old migration', { externalLinks: link(7), status: 'done', percentComplete: 100 });
  return { user, fleet, map, ticket, api, done };
}

async function row(id: string) {
  const [r] = await db.select().from(nodes).where(eq(nodes.id, id));
  return r;
}

describe('flag_blocker with a kind', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
  });

  it('question → an ask on the Questions card to the map owner; answering it unblocks', async () => {
    const { user, fleet, map, ticket } = await seed();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'question', reason: 'Stripe or Adyen?', options: ['Stripe', 'Adyen'] }, user.id);
    expect(out.node.blockedReason).toBe('Stripe or Adyen?');
    expect(out.node.blockerInfo).toEqual({ kind: 'question', answerer: 'Dan', options: ['Stripe', 'Adyen'] });
    expect(out.node.blockedAt).toBeTruthy();

    const rows = await derivedAskRows([map.id]);
    const q = rows.find((r) => r.ask.id === `question-${ticket.id}`);
    expect(q?.ask.question).toBe('Stripe or Adyen?');
    expect(q?.ask.answerer).toBe('Dan');
    expect(q?.ask.options).toEqual(['Stripe', 'Adyen']);
    // Not also a blocker row on Your steps.
    expect(rows.some((r) => r.ask.id === `blocker-${ticket.id}`)).toBe(false);

    const ans = await answerAsk({ fleetId: fleet.id, mapId: map.id, askId: `question-${ticket.id}` }, { action: 'answered', decision: 'Stripe', by: 'Dan' }, user.id);
    expect(ans.ok).toBe(true);
    const after = await row(ticket.id);
    expect(after.blockedReason).toBeNull();
    expect(after.blockerInfo).toBeNull();
    expect(after.blockedAt).toBeNull();
    expect(after.status).toBe('todo');
    expect(String(after.description)).toMatch(/^\*\*Decision \(Dan, \d{4}-\d{2}-\d{2}\): Stripe\*\*\n\nBuild it\.$/);
    expect((await derivedAskRows([map.id])).some((r) => r.ask.id === `question-${ticket.id}`)).toBe(false);
  });

  it('owner "Daniel Haas" with answerer name "Dan" → question and gate asks (and lint, same lookup) go to Dan, not Daniel', async () => {
    const { user, map, ticket } = await seed();
    await db.update(users).set({ name: 'Daniel Haas' }).where(eq(users.id, user.id));
    expect(await mapOwnerAnswerer(map)).toBe('Daniel');
    await setAnswerer(user.id, 'Dan');
    expect(await mapOwnerAnswerer(map)).toBe('Dan');
    const out = await flagBlocker(map.id, ticket.id, { kind: 'question', reason: 'Stripe or Adyen?' }, user.id);
    expect(out.node.blockerInfo).toEqual({ kind: 'question', answerer: 'Dan' });
    const rows = await derivedAskRows([map.id]);
    expect(rows.find((r) => r.ask.id === `question-${ticket.id}`)?.ask.answerer).toBe('Dan');
    // The gate ask: a ready ticket outside the map's gate.
    await db.update(maps).set({ dispatchGate: ['00000000-0000-4000-8000-000000000000'] }).where(eq(maps.id, map.id));
    const gate = (await derivedAskRows([map.id])).find((r) => r.ask.id.startsWith('gate-'));
    expect(gate?.ask.answerer).toBe('Dan');
    expect((await derivedAskRows([map.id])).every((r) => r.ask.answerer !== 'Daniel')).toBe(true);
  });

  it('question with an answerer keeps it', async () => {
    const { user, map, ticket } = await seed();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'question', reason: 'Which logo?', answerer: 'Rita' }, user.id);
    expect(out.node.blockerInfo).toEqual({ kind: 'question', answerer: 'Rita' });
  });

  it('person-step → needs-human, the text the next step on Your steps, no blocker', async () => {
    const { user, map, ticket } = await seed();
    await flagBlocker(map.id, ticket.id, { kind: 'person-step', reason: 'Upload the build to the store' }, user.id);
    const after = await row(ticket.id);
    expect(after.blockedReason).toBeNull();
    expect(after.tags).toContain('needs-human');
    expect(String(after.description)).toMatch(/^\*\*Next step \(a person\): Upload the build to the store\*\*/);
    const rows = await derivedAskRows([map.id]);
    expect(rows.find((r) => r.ask.id === `step-${ticket.id}`)?.ask.question).toBe('Next step: Upload the build to the store');
  });

  it('external → kept with a re-check date; asked again once it has come; "Still waiting" moves it on', async () => {
    const { user, fleet, map, ticket } = await seed();
    const now = new Date();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'external', reason: 'LOKE sends the keys' }, user.id, now);
    const recheck = Date.parse(out.node.blockerInfo!.recheckAt!);
    expect(recheck - now.getTime()).toBe(7 * 24 * HOUR);
    // Before the date: nothing on the card, no blocker row either.
    expect((await derivedAskRows([map.id], now)).filter((r) => r.ask.unblocks.node_id === ticket.id)).toEqual([]);

    const later = new Date(recheck + HOUR);
    const due = (await derivedAskRows([map.id], later)).find((r) => r.ask.id === `external-${ticket.id}`);
    expect(due?.ask.question).toBe('Still waiting? LOKE sends the keys');
    expect(due?.ask.options).toEqual(['Still waiting', 'Unblocked']);

    vi.useFakeTimers({ now: later, toFake: ['Date'] });
    try {
      await answerAsk({ fleetId: fleet.id, mapId: map.id, askId: `external-${ticket.id}` }, { action: 'answered', decision: 'Still waiting' }, user.id);
    } finally {
      vi.useRealTimers();
    }
    const after = await row(ticket.id);
    expect(after.blockedReason).toBe('LOKE sends the keys');
    expect(Date.parse((after.blockerInfo as { recheckAt: string }).recheckAt)).toBe(later.getTime() + 7 * 24 * HOUR);
  });

  it('external with recheckDays', async () => {
    const { user, map, ticket } = await seed();
    const now = new Date();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'external', reason: 'Vendor SLA', recheckDays: 2 }, user.id, now);
    expect(Date.parse(out.node.blockerInfo!.recheckAt!) - now.getTime()).toBe(2 * 24 * HOUR);
  });

  it('waits-on → a dependency on the ticket, no blocker', async () => {
    const { user, map, ticket, api } = await seed();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'waits-on', reason: '', waitsOn: '#62' }, user.id);
    expect(out.dependsOn).toEqual({ id: api.id, text: 'Merge the API PR' });
    const after = await row(ticket.id);
    expect(after.blockedReason).toBeNull();
    expect(after.dependencies).toEqual([{ targetNodeId: api.id, type: 'FS', lag: 0 }]);
  });

  it('waits-on finds the ticket the reason names, or says it needs one', async () => {
    const { user, map, ticket, api } = await seed();
    const out = await flagBlocker(map.id, ticket.id, { kind: 'waits-on', reason: 'until o/r PR #62 is merged' }, user.id);
    expect(out.dependsOn?.id).toBe(api.id);
    await expect(flagBlocker(map.id, ticket.id, { kind: 'waits-on', reason: 'something else' }, user.id)).rejects.toBeInstanceOf(FlagBlockerError);
  });
});

describe('a blocker without a kind', () => {
  beforeEach(async () => {
    await truncateAll(db);
    vi.clearAllMocks();
  });

  it('is left alone for an hour, then becomes a question to the map owner', async () => {
    const { map, ticket } = await seed();
    await nodeDb.updateNode(ticket.id, { blockedReason: 'Waiting on Dan: which domain?' });
    const set = await row(ticket.id);
    expect(set.blockedAt).toBeTruthy();
    expect(set.blockerInfo).toBeNull();

    const soon = new Date(set.blockedAt!.getTime() + 30 * 60_000);
    expect(await classifyUnkindedBlockers({ mapIds: [map.id], now: soon })).toEqual([]);

    const hourLater = new Date(set.blockedAt!.getTime() + HOUR + 1000);
    const [m] = await classifyUnkindedBlockers({ mapIds: [map.id], now: hourLater });
    expect(m.items).toEqual([{ nodeId: ticket.id, text: ticket.text, reason: 'Waiting on Dan: which domain?', plan: { kind: 'question', answerer: 'Dan' } }]);
    const after = await row(ticket.id);
    expect(after.blockerInfo).toEqual({ kind: 'question', answerer: 'Dan', auto: true });
    expect(after.blockedAt?.getTime()).toBe(set.blockedAt!.getTime());
    expect((await derivedAskRows([map.id], hourLater)).find((r) => r.ask.id === `question-${ticket.id}`)?.ask.question).toBe('Waiting on Dan: which domain?');
  });

  it('becomes a dependency when it names an open ticket of the map — the blocker goes', async () => {
    const { map, ticket, api } = await seed();
    await nodeDb.updateNode(ticket.id, { blockedReason: 'Waiting on Dan: merge o/r PR #62 first' });
    const [m] = await classifyUnkindedBlockers({ mapIds: [map.id], now: new Date(Date.now() + 2 * HOUR) });
    expect(m.items[0].plan).toEqual({ kind: 'waits-on', targetNodeId: api.id, targetText: 'Merge the API PR' });
    const after = await row(ticket.id);
    expect(after.blockedReason).toBeNull();
    expect(after.dependencies).toEqual([{ targetNodeId: api.id, type: 'FS', lag: 0 }]);
  });

  it('naming only a finished ticket is a question', async () => {
    const { map, ticket } = await seed();
    await nodeDb.updateNode(ticket.id, { blockedReason: 'Blocked by #7' });
    const [m] = await classifyUnkindedBlockers({ mapIds: [map.id], now: new Date(Date.now() + 2 * HOUR) });
    expect(m.items[0].plan.kind).toBe('question');
  });

  it("leaves a fleet worker's own note alone", async () => {
    const { map, ticket } = await seed();
    await nodeDb.updateNode(ticket.id, { blockedReason: 'Fleet worker claudia: CI failed on PR #62 — fixing' });
    expect(await classifyUnkindedBlockers({ mapIds: [map.id], now: new Date(Date.now() + 2 * HOUR) })).toEqual([]);
    expect((await row(ticket.id)).blockerInfo).toBeNull();
  });

  it('a blocker from before blocked_at: only the one-time run takes it, and its dry run writes nothing', async () => {
    const { map, ticket } = await seed();
    await db.update(nodes).set({ blockedReason: 'needs a design choice from Dan' }).where(eq(nodes.id, ticket.id));
    expect(await classifyUnkindedBlockers({ mapIds: [map.id] })).toEqual([]);

    const [dry] = await classifyUnkindedBlockers({ mapIds: [map.id], legacy: true, dryRun: true });
    expect(dry.items.map((i) => i.plan.kind)).toEqual(['question']);
    expect((await row(ticket.id)).blockerInfo).toBeNull();

    await classifyUnkindedBlockers({ mapIds: [map.id], legacy: true });
    expect((await row(ticket.id)).blockerInfo).toEqual({ kind: 'question', answerer: 'Dan', auto: true });
  });

  it('the same text written again keeps the kind and the clock; a new text clears the kind', async () => {
    const { user, map, ticket } = await seed();
    await flagBlocker(map.id, ticket.id, { kind: 'question', reason: 'Which domain?' }, user.id);
    const first = await row(ticket.id);
    await nodeDb.updateNode(ticket.id, { blockedReason: 'Which domain?' });
    const same = await row(ticket.id);
    expect(same.blockerInfo).toEqual(first.blockerInfo);
    expect(same.blockedAt?.getTime()).toBe(first.blockedAt!.getTime());

    await nodeDb.updateNode(ticket.id, { blockedReason: 'Something else now' });
    expect((await row(ticket.id)).blockerInfo).toBeNull();
    await nodeDb.updateNode(ticket.id, { blockedReason: null });
    const cleared = await row(ticket.id);
    expect(cleared.blockedAt).toBeNull();
    expect(cleared.blockerInfo).toBeNull();
  });
});
