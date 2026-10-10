import { describe, it, expect } from 'vitest';
import {
  countOwnCompletions,
  assessForecastEvidence,
  chooseTicketRate,
  forecastHeadline,
  type ForecastEvidence,
} from '../forecastEvidence.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('countOwnCompletions', () => {
  it('counts done leaves completed inside the window only', () => {
    const leaves = [
      { completedAt: daysAgo(3), percentComplete: 100, status: 'done' },
      { completedAt: daysAgo(3), status: 'done', percentComplete: null },
      { completedAt: daysAgo(80), percentComplete: 100 }, // outside
      { completedAt: daysAgo(3), percentComplete: 40 }, // reopened since
      { completedAt: null, percentComplete: 100 },
    ];
    expect(countOwnCompletions(leaves, 56, NOW)).toBe(2);
  });
});

describe('assessForecastEvidence (#343)', () => {
  it('whole map: always measured', () => {
    expect(assessForecastEvidence({ scoped: false, ownCompletions: 0, windowDays: 56 }).state).toBe('measured');
  });
  it('scoped: 0 → not measurable, below 10 → provisional, 10+ → measured', () => {
    const none = assessForecastEvidence({ scoped: true, ownCompletions: 0, windowDays: 56 });
    expect(none.state).toBe('not_measurable');
    expect(none.note).toContain('0 of 10');
    expect(assessForecastEvidence({ scoped: true, ownCompletions: 4, windowDays: 56 }).state).toBe('provisional');
    expect(assessForecastEvidence({ scoped: true, ownCompletions: 10, windowDays: 56 }).state).toBe('measured');
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
  const measured: ForecastEvidence = { state: 'measured', ownCompletions: 12, required: 10, windowDays: 56, note: '' };
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
  });
  it('no open work: no date', () => {
    expect(forecastHeadline({ ...input, openLeaves: 0 }).date).toBeNull();
  });
});
