/**
 * Stalled work as questions (services/stalledAsks.ts): derived on read
 * after a day, snoozed by Later / Delegate, answered through the lint
 * fixes and recorded so the answered fold shows the round.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const state = vi.hoisted(() => ({
  stalled: [] as Array<{ nodeId: string; percentComplete: number; lastChangeAt: string; lastRelease: null }>,
  stored: [] as unknown[],
}));

vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async (id: string) =>
    id === 'm1'
      ? { map: { id: 'm1' }, nodes: [{ id: 'old', text: 'Nicknames', priority: 'P3', externalLinks: [] }, { id: 'new', text: 'Fresh', externalLinks: [] }] }
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

import { answerStalledAsk, openStalledAsks, stalledAskRows } from '../stalledAsks.js';

const key = { fleetId: 'f1', mapId: 'm1', askId: 'stalled-old' };
const scope = { fleetId: 'f1', mapId: 'm1' };

beforeEach(() => {
  vi.clearAllMocks();
  state.stalled = [
    { nodeId: 'old', percentComplete: 90, lastChangeAt: hoursAgo(30), lastRelease: null },
    { nodeId: 'new', percentComplete: 20, lastChangeAt: hoursAgo(5), lastRelease: null },
  ];
  state.stored = [];
});

describe('stalled asks', () => {
  it('ask about work stalled for a day, not about work stalled for hours', async () => {
    const rows = await stalledAskRows(['m1', 'gone']);
    expect(rows.map((r) => [r.ask.id, r.mapId, r.status])).toEqual([['stalled-old', 'm1', 'open']]);
    expect(rows[0].ask.options).toEqual(['Done', 'Back to the queue', 'For a person']);
  });

  it('a recent Later or Delegate snoozes the question; an old one does not', async () => {
    state.stored = [{ ask: { id: 'stalled-old' }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(2) }];
    expect(await openStalledAsks(scope, ['m1'])).toEqual([]);
    state.stored = [{ ask: { id: 'stalled-old' }, mapId: 'm1', status: 'later', answeredAt: hoursAgo(24 * 20) }];
    expect((await openStalledAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['stalled-old']);
    state.stored = [{ ask: { id: 'stalled-old' }, mapId: 'm1', status: 'answered', answeredAt: hoursAgo(2) }];
    expect((await openStalledAsks(scope, ['m1'])).map((r) => r.ask.id)).toEqual(['stalled-old']);
  });

  it('Done / Back to the queue / free text run the matching fix and record the answer', async () => {
    const done = await answerStalledAsk(key, { action: 'answered', decision: 'Done' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'mark-done', 'u1', { note: undefined });
    expect(done.ok).toBe(true);
    expect(done.node).toEqual({ id: 'old', mapId: 'm1' });
    expect(recordAnswer).toHaveBeenLastCalledWith(key, expect.objectContaining({ id: 'stalled-old' }), expect.objectContaining({ status: 'answered', answeredBy: 'Dan' }));

    await answerStalledAsk(key, { action: 'answered', decision: 'Back to the queue' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'requeue', 'u1', { note: undefined });

    await answerStalledAsk(key, { action: 'answered', decision: 'run the import on prod' }, 'u1');
    expect(applyLintFix).toHaveBeenLastCalledWith('m1', 'old', 'needs-human', 'u1', { note: 'run the import on prod' });
  });

  it('Later only records; a node no longer stalled has no question to answer', async () => {
    const later = await answerStalledAsk(key, { action: 'later' }, 'u1');
    expect(applyLintFix).not.toHaveBeenCalled();
    expect(later.row.status).toBe('later');
    state.stalled = [];
    await expect(answerStalledAsk(key, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
    await expect(answerStalledAsk({ ...key, askId: '#6823' }, { action: 'answered', decision: 'Done' }, 'u1')).rejects.toThrow();
  });
});
