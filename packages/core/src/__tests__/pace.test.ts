import { describe, it, expect } from 'vitest';
import { summarisePace } from '../velocity.js';

const days = (values: number[]) => values.map((completed, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, completed, completions: completed > 0 ? 1 : 0 }));

describe('summarisePace', () => {
  it('today / 7 days / window, per day and the ratio to the plan', () => {
    const p = summarisePace(days([4, 0, 0, 0, 0, 0, 0, 10, 20, 0, 5, 20.5, 12.75, 31.75]), 1);
    expect(p.today).toBe(31.75);
    expect(p.last7).toBeCloseTo(100);
    expect(p.window).toBeCloseTo(104);
    expect(p.perDay).toBeCloseTo(104 / 14);
    expect(p.ratio).toBeCloseTo(104 / 14);
    expect(p.note).toBe('Work runs 7.4× faster than planned — 7.4 days of estimates finished per calendar day against 1.0 planned.');
  });

  it('slow and on-plan wording; nothing done says so', () => {
    expect(summarisePace(days([0.5, 0.5]), 2).note).toBe('Work runs at 25% of the planned pace — 0.5 days of estimates per calendar day against 2.0 planned.');
    expect(summarisePace(days([1, 1]), 1).note).toBe('Work runs at about the planned pace — 1.0 days of estimates per calendar day.');
    expect(summarisePace(days([0, 0]), 1).note).toBe('No estimated work finished in the last 2 days.');
  });
});
