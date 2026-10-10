import { describe, it, expect } from 'vitest';
import {
  ownCompletionStats,
  assessForecastEvidence,
  chooseTicketRate,
  forecastHeadline,
  type ForecastEvidence,
} from '../forecastEvidence.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('ownCompletionStats', () => {
  it('counts done leaves with a real completion; window, first and last', () => {
    const leaves = [
      { completedAt: daysAgo(3), percentComplete: 100, status: 'done' },
      { completedAt: daysAgo(10), status: 'done', percentComplete: null },
      { completedAt: daysAgo(80), percentComplete: 100 }, // outside the window, still "ever"
      { completedAt: daysAgo(3), percentComplete: 40 }, // reopened since
      { completedAt: null, percentComplete: 100 },
    ];
    expect(ownCompletionStats(leaves, 56, NOW)).toEqual({
      inWindow: 2, ever: 3, firstInWindow: daysAgo(10), last: daysAgo(3),
    });
  });
  it('a node created and marked done within two minutes was imported done — not history', () => {
    const at = daysAgo(1);
    const imported = { createdAt: at, completedAt: new Date(Date.parse(at) + 30_000).toISOString(), percentComplete: 100 };
    const worked = { createdAt: daysAgo(5), completedAt: at, percentComplete: 100 };
    expect(ownCompletionStats([imported, worked], 56, NOW).inWindow).toBe(1);
  });
});

const stats = (inWindow: number, ever = inWindow, last: string | null = inWindow || ever ? daysAgo(70) : null) =>
  ({ inWindow, ever, firstInWindow: inWindow ? daysAgo(20) : null, last });

describe('assessForecastEvidence (#343)', () => {
  it('whole map: always measured', () => {
    expect(assessForecastEvidence({ scoped: false, stats: stats(0), windowDays: 56, openLeaves: 5 }).state).toBe('measured');
  });
  it('scoped: never started, target ahead → not measurable; below 10 → provisional; 10+ → measured', () => {
    const none = assessForecastEvidence({ scoped: true, stats: stats(0), windowDays: 56, targetDate: '2026-12-01', openLeaves: 5, now: NOW });
    expect(none.state).toBe('not_measurable');
    expect(none.note).toContain('0 of 10');
    expect(assessForecastEvidence({ scoped: true, stats: stats(4), windowDays: 56, openLeaves: 5, now: NOW }).state).toBe('provisional');
    expect(assessForecastEvidence({ scoped: true, stats: stats(10), windowDays: 56, openLeaves: 5, now: NOW }).state).toBe('measured');
  });
  it('the red flags are NOT silenced: overdue and unstarted, or work that stopped → stalled', () => {
    const overdue = assessForecastEvidence({ scoped: true, stats: stats(0), windowDays: 56, targetDate: '2026-09-01', openLeaves: 5, now: NOW });
    expect(overdue.state).toBe('stalled');
    expect(overdue.note).toContain('target 2026-09-01 has passed and none of its work is done');
    const stopped = assessForecastEvidence({ scoped: true, stats: stats(0, 7), windowDays: 56, openLeaves: 5, now: NOW });
    expect(stopped.state).toBe('stalled');
    expect(stopped.note).toContain('no completions of its own in the last 56d');
  });
});

describe('chooseTicketRate (#342)', () => {
  const base = { windowDays: 56, mapRatePerDay: 1.56, mapCompletions: 87, reworkFraction: 0.1 };
  it('a scope with enough own completions runs on its own net pace', () => {
    const r = chooseTicketRate({ ...base, scoped: true, ownCompletions: 28 });
    expect(r.source).toBe('scope');
    expect(r.ratePerDay).toBeCloseTo((28 / 56) * 0.9);
    expect(r.basis).toContain("this scope's own pace");
  });
  it('the own pace is measured over the span actually worked (floor 7 days), not the whole window', () => {
    const young = chooseTicketRate({ ...base, scoped: true, ownCompletions: 6, firstOwnCompletion: daysAgo(14), now: NOW });
    expect(young.ratePerDay).toBeCloseTo((6 / 14) * 0.9);
    const burst = chooseTicketRate({ ...base, scoped: true, ownCompletions: 3, firstOwnCompletion: daysAgo(1), now: NOW });
    expect(burst.ratePerDay).toBeCloseTo((3 / 7) * 0.9);
    expect(burst.basis).toContain('3 completions in 7d');
  });
  it('otherwise the map-wide pace, named as such with the scope\'s share', () => {
    const r = chooseTicketRate({ ...base, scoped: true, ownCompletions: 0 });
    expect(r).toMatchObject({ ratePerDay: 1.56, source: 'map' });
    expect(r.basis).toContain('87 completions in 56d across the whole map, mixed item types — 0 of them in this scope');
  });
  it('the whole map is plainly its own pace; no rate → null', () => {
    expect(chooseTicketRate({ ...base, scoped: false, ownCompletions: 87 }).basis).toBe('map pace: 87 completions in 56d');
    expect(chooseTicketRate({ ...base, mapRatePerDay: null, scoped: true, ownCompletions: 1 })).toMatchObject({ ratePerDay: null, source: null });
  });
});

describe('forecastHeadline (#319)', () => {
  const measured: ForecastEvidence = { state: 'measured', ownCompletions: 12, ownCompletionsEver: 12, lastCompletion: null, required: 10, windowDays: 56, note: '' };
  const input = {
    evidence: measured,
    plannedDate: '2026-11-01',
    velocityDate: '2026-11-20',
    ticketDate: '2026-12-25',
    crossCheck: 'agree' as const,
    fudgeFactor: 1.1,
    openLeaves: 40,
    unestimatedOpenLeaves: 0,
  };
  it('not yet measurable: no date at all', () => {
    const h = forecastHeadline({ ...input, evidence: { ...measured, state: 'not_measurable', note: 'Not yet measurable — x' } });
    expect(h).toMatchObject({ date: null, confidence: null });
    expect(h.reason).toContain('Not yet measurable');
  });
  it('healthy estimates: the velocity date, high confidence, range over all models', () => {
    expect(forecastHeadline(input)).toMatchObject({
      date: '2026-11-20', model: 'velocity', confidence: 'high', range: { from: '2026-11-01', to: '2026-12-25' },
    });
  });
  it('a broken estimate unit or mostly-unestimated work: the ticket model carries it', () => {
    expect(forecastHeadline({ ...input, fudgeFactor: 0.11 })).toMatchObject({ date: '2026-12-25', model: 'ticket' });
    const h = forecastHeadline({ ...input, unestimatedOpenLeaves: 30 });
    expect(h).toMatchObject({ model: 'ticket', confidence: 'low' });
    expect(h.reason).toContain('30 of 40');
  });
  it('provisional evidence or a diverging cross-check reads low; no cross-check medium', () => {
    expect(forecastHeadline({ ...input, evidence: { ...measured, state: 'provisional' } }).confidence).toBe('low');
    expect(forecastHeadline({ ...input, crossCheck: 'caution' }).confidence).toBe('low');
    expect(forecastHeadline({ ...input, crossCheck: 'unmeasured' }).confidence).toBe('medium');
    expect(forecastHeadline({ ...input, evidence: { ...measured, state: 'stalled' } })).toMatchObject({ date: '2026-11-20', confidence: 'low' });
  });
  it('no open work: no date', () => {
    expect(forecastHeadline({ ...input, openLeaves: 0 }).date).toBeNull();
  });
});
