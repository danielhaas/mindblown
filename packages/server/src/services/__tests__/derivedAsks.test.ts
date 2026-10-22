/**
 * MindBlown's own rows on the Questions card (services/derivedAsks.ts):
 * stalled work after a day and a person's steps (skip-tagged tickets),
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
          map: { id: 'm1', archivedAt: state.archived ? 'x' : null, statusWorkflow: [{ id: 'wip', name: 'In progress', category: 'in_progress' }, { id: 'done', name: 'Done', category: 'done' }] },
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

import { answerDerivedAsk, openDerivedAsks, derivedAskRows, sendBlockersToFleet } from '../derivedAsks.js';

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
});

describe('stalled questions', () => {
  it('ask about work stalled for a day, not about work stalled for hours', async () => {
    const rows = (await derivedAskRows(['m1', 'gone'])).filter((r) => r.ask.id.startsWith('stalled-'));
    expect(rows.map((r) => [r.ask.id, r.mapId, r.status])).toEqual([['stalled-old', 'm1', 'open']]);
    expect(rows[0].ask.options).toEqual(['Done', 'Back to the queue', 'For a person']);
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
      node('ci', { blockedReason: ci, percentComplete: 90, claimedBySession: 'bb:slot1:fleet-worker' }),
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
});
