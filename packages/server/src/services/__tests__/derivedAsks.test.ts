/**
 * MindBlown's own rows on the Questions card (services/derivedAsks.ts):
 * stalled work after a day (a "Decision:" ticket after 2 h) and a
 * person's steps (skip-tagged tickets),
 * derived on read, snoozed by Later / Delegate, answered through the lint
 * fixes and recorded so the answered fold shows the round.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const state = vi.hoisted(() => ({
  stalled: [] as Array<{ nodeId: string; percentComplete: number; lastChangeAt: string; lastRelease: null }>,
  stored: [] as unknown[],
  nodes: [] as unknown[],
  archived: false,
  cap: 4,
}));

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: id,
  tags: [],
  childrenIds: [],
  status: 'wip',
  percentComplete: 0,
  externalLinks: [],
  description: null,
  updatedAt: hoursAgo(3),
  ...extra,
});

vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async (id: string) =>
    id === 'm1'
      ? {
          map: { id: 'm1', archivedAt: state.archived ? 'x' : null, maxActiveClaims: state.cap, statusWorkflow: [{ id: 'wip', name: 'In progress', category: 'in_progress' }, { id: 'done', name: 'Done', category: 'done' }] },
          nodes: state.nodes,
        }
      : null,
  ),
}));
vi.mock('../../lib/stalled.js', () => ({ stalledForMap: vi.fn(async () => state.stalled) }));
const applyLintFix = vi.fn(async (_m: string, id: string) => ({ action: 'x', node: { id, mapId: 'm1' }, changedFields: ['percentComplete'] }));
vi.mock('../../lint/fix.js', () => ({ applyLintFix: (...a: unknown[]) => applyLintFix(...(a as [string, string])) }));
const recordAnswer = vi.fn(async (k: { askId: string; mapId: string }, ask: unknown, p: { status: string }) => ({ ask, mapId: k.mapId, status: p.status }));
vi.mock('../../db/asks.js', () => ({
  ANSWER_RETENTION_DAYS: 14,
  listAsks: vi.fn(async () => state.stored),
  recordAnswer: (...a: unknown[]) => recordAnswer(...(a as [never, never, never])),
}));
vi.mock('../asks.js', () => ({ AskNotFoundError: class AskNotFoundError extends Error {} }));

import { answerDerivedAsk, autoCheckBlockers, openDerivedAsks, derivedAskRows, sendBlockersToFleet } from '../derivedAsks.js';

const key = { fleetId: 'f1', mapId: 'm1', askId: 'stalled-old' };
const scope = { fleetId: 'f1', mapId: 'm1' };

beforeEach(() => {
  vi.clearAllMocks();
  state.stalled = [
    { nodeId: 'old', percentComplete: 90, lastChangeAt: hoursAgo(30), lastRelease: null },
    { nodeId: 'new', percentComplete: 20, lastChangeAt: hoursAgo(5), lastRelease: null },
  ];
  state.nodes = [
    node('old', { text: 'Nicknames', priority: 'P3', percentComplete: 90 }),
    node('new', { percentComplete: 20 }),
    node('phone', { tags: ['needs-human'], description: '**Next step (a person): check on a real phone**\n\nInter.' }),
    node('done-step', { tags: ['needs-human'], status: 'done', percentComplete: 100 }),
    node('free', {}),
  ];
  state.stored = [];
  state.archived = false;
  state.cap = 4;
});

describe('stalled questions', () => {
  it('ask about work stalled for a day, not about work stalled for hours', async () => {
    const rows = (await derivedAskRows(['m1', 'gone'])).filter((r) => r.ask.id.startsWith('stalled-'));
    expect(rows.map((r) => [r.ask.id, r.mapId, r.status])).toEqual([['stalled-old', 'm1', 'open']]);
    expect(rows[0].ask.options).toEqual(['Done', 'Back to the queue', 'For a person']);
  });

  it('a "Decision:" ticket asks once it is stalled, not after a day', async () => {
    state.nodes = [...state.nodes.filter((n) => (n as { id: string }).id !== 'new'), node('new', { text: 'Decision: STP participation', percentComplete: 75 })];
    const rows = (await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('stalled-'));
    expect(rows.map((r) => r.ask.id)).toEqual(['stalled-old', 'stalled-new']);
  });

  it('a recent Later or Delegate snoozes the row; an old one or a plain answer does not', async () => {
    const stalledIds = async () => (await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id).filter((id) => id.startsWith('stalled-'));
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(2) }];
    expect(await stalledIds()).toEqual([]);
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(24 * 20) }];
    expect(await stalledIds()).toEqual(['stalled-old']);
    state.stored = [{ ask: { id: 'stalled-old', unblocks: {} }, mapId: 'm1', status: 'answered', answeredAt: hoursAgo(2) }];
    expect(await stalledIds()).toEqual(['stalled-old']);
  });

  it('Done / Back to the queue / free text run the matching fix and record the answer', async () => {
    const done = await answerDerivedAsk(key, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'mark-done', 'u1', { note: undefined });
    expect(done.ok).toBe(true);
    expect(done.node).toEqual({ id: 'old', mapId: 'm1' });
    expect(recordAnswer).toHaveBeenLastCalledWith(key, expect.objectContaining({ id: 'stalled-old' }), expect.objectContaining({ status: 'answered', answeredBy: 'Dan' }));

    await answerDerivedAsk(key, { action: 'answered', decision: 'Back to the queue' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'requeue', 'u1', { note: undefined });

    await answerDerivedAsk(key, { action: 'answered', decision: 'run the import on prod' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'needs-human', 'u1', { note: 'run the import on prod' });
  });

  it('Later only records; a node no longer stalled has no question to answer', async () => {
    const later = await answerDerivedAsk(key, { action: 'later' }, 'u1');
    expect(applyLintFix).not.toHaveBeenCalled();
    expect(later.row.status).toBe('later');
    state.stalled = [];
    await expect(answerDerivedAsk(key, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
    await expect(answerDerivedAsk({ ...key, askId: '#6823' }, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
  });
});

describe('a person\'s steps', () => {
  const stepKey = { fleetId: 'f1', mapId: 'm1', askId: 'step-phone' };

  it('one row per open ticket with a skip tag, its next step as the text; none for done work or an archived map', async () => {
    const steps = (await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('step-'));
    expect(steps.map((r) => r.ask.id)).toEqual(['step-phone']);
    expect(steps[0].ask).toMatchObject({ hint: 'ops-task', options: ['Done', 'Fleet can do it'], question: 'Next step: check on a real phone' });
    state.archived = true;
    expect(await derivedAskRows(['m1'])).toEqual([]);
  });

  it('no step row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-phone', unblocks: { node_id: 'phone' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['stalled-old']);
  });

  it('no stalled row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-old', unblocks: { node_id: 'old' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['step-phone']);
  });

  it('Done / Fleet can do it / free text = the new next step', async () => {
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'mark-done', 'u1', { note: undefined });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'Fleet can do it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'to-fleet', 'u1', { note: undefined });
    await answerDerivedAsk(stepKey, { action: 'answered', decision: 'waiting for Thomas to send the key' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'phone', 'needs-human', 'u1', { note: 'waiting for Thomas to send the key' });
  });
});

describe('blockers (a worker\'s red CI, a wait)', () => {
  const blockerKey = { fleetId: 'f1', mapId: 'm1', askId: 'blocker-ci' };
  const ci = 'Fleet worker bb:slot1:fleet-worker: CI failed on PR #995 (445fab60). Fix the branch or close the PR.';
  beforeEach(() => {
    state.nodes.push(
      // No MindBlown claim: the worker still follows the PR from its own claim file (22.10.2026).
      node('ci', { blockedReason: ci, percentComplete: 90 }),
      node('vendor', { blockedReason: 'Waiting for the vendor' }),
      node('checking', { blockedReason: 'Waiting for the vendor', tags: ['fleet-check'] }),
      node('tagged', { blockedReason: 'x', tags: ['needs-human'] }),
      node('epic', { blockedReason: 'y', childrenIds: ['free'] }),
      node('closed', { blockedReason: 'z', status: 'done', percentComplete: 100 }),
    );
  });

  it('one row per open blocked leaf; a skip-tagged one stays a step, parents, done work and ones the fleet is checking get none', async () => {
    const rows = await derivedAskRows(['m1']);
    expect(rows.filter((r) => r.ask.id.startsWith('blocker-')).map((r) => r.ask.id)).toEqual(['blocker-ci', 'blocker-vendor']);
    expect(rows.map((r) => r.ask.id)).toContain('step-tagged');
    expect(rows.find((r) => r.ask.id === 'blocker-ci')!.ask).toMatchObject({ question: `Blocked: ${ci}`, options: ['Fleet can fix it', 'Unblocked', 'Done'] });
  });

  it('no row for a node a collector\'s open question already names', async () => {
    state.stored = [{ ask: { id: 'fleet-ci', unblocks: { node_id: 'ci' } }, mapId: 'm1', status: 'open', answeredAt: null }];
    expect((await openDerivedAsks(scope, ['m1'])).map((r) => r.ask.id)).not.toContain('blocker-ci');
  });

  it('Unblocked clears the blocker, Done finishes, free text = a person\'s next step', async () => {
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Fleet can fix it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'fleet-fix', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Unblocked' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'clear-blocker', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'mark-done', 'u1', { note: undefined });
    await answerDerivedAsk(blockerKey, { action: 'answered', decision: 'bump the dependency on main' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'ci', 'needs-human', 'u1', { note: 'bump the dependency on main' });
    await answerDerivedAsk({ ...blockerKey, askId: 'blocker-vendor' }, { action: 'answered', decision: 'Fleet can fix it' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'vendor', 'fleet-check', 'u1', { note: undefined });
    expect(recordAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      writes: [expect.objectContaining({ detail: expect.stringMatching(/^fleet-check — Decision \(Dan, \d{4}-\d\d-\d\d\): Fleet can fix it$/) })],
    }));
  });

  it('"Let the fleet check all": every blocker row, fix or check by its kind; steps and stalled rows stay', async () => {
    const out = await sendBlockersToFleet({ fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false }, ['m1'], 'u1', 'Dan');
    expect(out.sent).toEqual([
      { askId: 'blocker-ci', mapId: 'm1', action: 'fleet-fix' },
      { askId: 'blocker-vendor', mapId: 'm1', action: 'fleet-check' },
    ]);
    expect(out.failed).toEqual([]);
    expect(applyLintFix.mock.calls.map((c) => (c as unknown[]).slice(1, 3))).toEqual([['ci', 'fleet-fix'], ['vendor', 'fleet-check']]);
  });

  describe('auto-check', () => {
    const fleetScope = { fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false };
    const gaveUp = 'Fleet worker bb:slot1:fleet-worker: the agent ran past 60 min and was stopped. Partial work: branch b.';
    beforeEach(() => {
      state.nodes.push(
        node('timeout', { blockedReason: gaveUp }),
        node('fresh', { blockedReason: gaveUp, updatedAt: new Date(NOW - 10 * 60_000).toISOString() }),
        node('merge', { blockedReason: 'Fleet worker bb:slot1:fleet-worker: PR #7 came from a ticket approved for a PR only. Review it and merge it by hand.' }),
      );
    });
    const ourRow = (writes: unknown[] = [{ done: true }]) => ({ ask: { id: 'blocker-timeout' }, mapId: 'm1', status: 'answered', answeredBy: 'Auto-check', answeredAt: hoursAgo(1), writes });

    it('checks a fleet give-up that has sat 30 min, as Auto-check; not a fresh one, a person\'s blocker or a PR note', async () => {
      const out = await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW));
      expect(out.sent).toEqual([{ askId: 'blocker-timeout', mapId: 'm1', action: 'fleet-check' }]);
      expect(applyLintFix).toHaveBeenCalledTimes(1);
      expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'timeout', 'fleet-check', 'owner', { note: undefined });
      expect(recordAnswer).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ answeredBy: 'Auto-check' }));
    });

    it('once per ticket: a row last answered by the auto-check stays with a person; a person\'s answer or a failed write re-arms it', async () => {
      state.stored = [ourRow()];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent).toEqual([]);
      state.stored = [{ ...ourRow(), answeredBy: 'Dan' }];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).toEqual(['blocker-timeout']);
      state.stored = [ourRow([{ done: false, error: 'db down' }])];
      expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).toEqual(['blocker-timeout']);
    });

    describe('stale: the ticket a blocker waits for is done now (#493 on 29.10.2026)', () => {
      const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
      const link = (n: number) => [{ provider: 'github', externalId: `o/r#${n}`, url: '', syncEnabled: true, lastSyncedAt: null }];
      const question = 'Fleet worker claudia:slot2:fleet-worker: needs a decision: #492 is merged. #494 is still open. Wait for it?';
      const ours = (mins: number) => ({ ask: { id: 'blocker-q' }, mapId: 'm1', status: 'answered', answeredBy: 'Auto-check', answeredAt: minsAgo(mins), writes: [{ done: true }] });
      const staleSent = async () => (await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId).filter((id) => id === 'blocker-q');
      const setDeps = (done494: string | null) => {
        state.nodes.push(
          node('q', { blockedReason: question, updatedAt: minsAgo(60), externalLinks: link(493) }),
          node('t492', { status: 'done', percentComplete: 100, completedAt: minsAgo(600), externalLinks: link(492) }),
          node('t494', done494 ? { status: 'done', percentComplete: 100, completedAt: done494, externalLinks: link(494) } : { externalLinks: link(494) }),
        );
      };

      it('checks the question again once every named ticket is done and one finished after it', async () => {
        setDeps(minsAgo(40));
        state.stored = [ours(61), { ask: { id: 'fleet-q', unblocks: { node_id: 'q' } }, mapId: 'm1', status: 'open', answeredAt: null }];
        expect(await staleSent()).toEqual(['blocker-q']);
      });

      it('not while a named ticket is open, nor for one done before the blocker, nor twice', async () => {
        setDeps(null);
        expect(await staleSent()).toEqual([]);
        state.nodes = state.nodes.filter((n) => !['q', 't492', 't494'].includes((n as { id: string }).id));
        setDeps(minsAgo(90));
        expect(await staleSent()).toEqual([]);
        state.nodes = state.nodes.filter((n) => !['q', 't492', 't494'].includes((n as { id: string }).id));
        setDeps(minsAgo(40));
        state.stored = [ours(35)];
        expect(await staleSent()).toEqual([]);
      });

      it('a named ticket done at an unknown time counts as done, but does not set it off', async () => {
        setDeps(minsAgo(40));
        const t492 = state.nodes.find((n) => (n as { id: string }).id === 't492') as Record<string, unknown>;
        t492.completedAt = null;
        expect(await staleSent()).toEqual(['blocker-q']);
        const t494 = state.nodes.find((n) => (n as { id: string }).id === 't494') as Record<string, unknown>;
        t494.completedAt = null;
        expect(await staleSent()).toEqual([]);
      });

      it('never a person\'s blocker that names a ticket', async () => {
        setDeps(minsAgo(40));
        state.nodes.push(node('held', { blockedReason: 'Waiting for #494', updatedAt: minsAgo(60) }));
        expect((await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW))).sent.map((r) => r.askId)).not.toContain('blocker-held');
      });
    });

    it('the fresh give-up is checked once its 30 min are up', async () => {
      const out = await autoCheckBlockers(fleetScope, ['m1'], 'owner', new Date(NOW + 25 * 60_000));
      expect(out.sent.map((r) => r.askId)).toEqual(['blocker-timeout', 'blocker-fresh']);
    });
  });
});

describe('tickets that need a brief', () => {
  const ready = (id: string, extra: Record<string, unknown> = {}) =>
    node(id, {
      parentId: 'root', status: null, claimedBySession: null, dependencies: [], blockedReason: null,
      approval: { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' },
      ...extra,
    });
  const briefKey = { fleetId: 'f1', mapId: 'm1', askId: 'brief-bare' };

  beforeEach(() => {
    state.stalled = [];
    state.nodes = [
      node('root', { parentId: null, childrenIds: ['bare', 'held', 'described'], dependencies: [], claimedBySession: null }),
      ready('bare', { text: 'Show durations' }),
      ready('held', { tags: ['needs-human'] }),
      ready('described', { description: 'Add a duration column to done cards' }),
    ];
  });

  it('one row per ready ticket the pull refuses for want of a brief; a held one stays a step', async () => {
    const rows = await derivedAskRows(['m1']);
    expect(rows.filter((r) => r.ask.id.startsWith('brief-')).map((r) => r.ask.id)).toEqual(['brief-bare']);
    expect(rows.map((r) => r.ask.id)).toContain('step-held');
    expect(rows.find((r) => r.ask.id === 'brief-bare')!.ask).toMatchObject({ title: 'Show durations', options: ['Done'], sources: ['mindblown-brief'] });
  });

  it('none while the map is on hold (cap 0) — nothing is pulled, so nothing waits on a brief', async () => {
    state.cap = 0;
    expect((await derivedAskRows(['m1'])).filter((r) => r.ask.id.startsWith('brief-'))).toEqual([]);
  });

  it('free text writes the brief, Done finishes', async () => {
    await answerDerivedAsk(briefKey, { action: 'answered', decision: 'Show on done cards how long they took' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'bare', 'write-brief', 'u1', { note: 'Show on done cards how long they took' });
    await answerDerivedAsk(briefKey, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'bare', 'mark-done', 'u1', { note: undefined });
  });
});
