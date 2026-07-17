import { describe, it, expect } from 'vitest';
import {
  clampFocusFactor,
  scopedCapacityDays,
  analyzeRepoThroughput,
  netDeliveryRate,
  DEFAULT_FOCUS_FACTOR,
  FOCUS_FACTOR_MIN,
  FOCUS_FACTOR_MAX,
} from '../velocity.js';

function pr(number: number, title: string, openH: number, mergeH: number, body = '') {
  const base = Date.parse('2026-07-10T00:00:00Z');
  return {
    number,
    title,
    body,
    createdAt: new Date(base + openH * 3_600_000).toISOString(),
    mergedAt: new Date(base + mergeH * 3_600_000).toISOString(),
  };
}

describe('clampFocusFactor', () => {
  it('passes valid values through unchanged', () => {
    expect(clampFocusFactor(0.5)).toBe(0.5);
    expect(clampFocusFactor(0.75)).toBe(0.75);
    expect(clampFocusFactor(FOCUS_FACTOR_MIN)).toBe(FOCUS_FACTOR_MIN);
    expect(clampFocusFactor(FOCUS_FACTOR_MAX)).toBe(FOCUS_FACTOR_MAX);
  });

  it('caps above 1 at 1 (can never spend >100% of time on planned work)', () => {
    expect(clampFocusFactor(1.5)).toBe(1);
    expect(clampFocusFactor(10)).toBe(1);
  });

  it('floors at the minimum to avoid a runaway ÷focusFactor', () => {
    expect(clampFocusFactor(0)).toBe(FOCUS_FACTOR_MIN);
    expect(clampFocusFactor(-2)).toBe(FOCUS_FACTOR_MIN);
    expect(clampFocusFactor(0.001)).toBe(FOCUS_FACTOR_MIN);
  });

  it('falls back to the default (1.0) for missing / non-finite values', () => {
    expect(clampFocusFactor(null)).toBe(DEFAULT_FOCUS_FACTOR);
    expect(clampFocusFactor(undefined)).toBe(DEFAULT_FOCUS_FACTOR);
    expect(clampFocusFactor(NaN)).toBe(DEFAULT_FOCUS_FACTOR);
    expect(clampFocusFactor(Infinity)).toBe(DEFAULT_FOCUS_FACTOR);
  });
});

describe('scopedCapacityDays', () => {
  it('planned = remaining ÷ (workers × unitsPerDay); velocity applies fudge & focus', () => {
    // 50 remaining, 5 workers, 1 unit/day → 10 calendar days planned.
    const r = scopedCapacityDays(50, { workers: 5, unitsPerDay: 1, fudge: 1, focusFactor: 1 });
    expect(r.plannedCalendarDays).toBeCloseTo(10, 6);
    expect(r.velocityCalendarDays).toBeCloseTo(10, 6);
  });

  it('velocity stretches by fudge and by 1/focus, planned does not', () => {
    const r = scopedCapacityDays(50, { workers: 5, unitsPerDay: 1, fudge: 1.26, focusFactor: 0.5 });
    expect(r.plannedCalendarDays).toBeCloseTo(10, 6); // idealised baseline
    expect(r.velocityCalendarDays).toBeCloseTo((50 * 1.26) / (5 * 0.5), 6); // 25.2
  });

  it('does not bury a small scope behind a big backlog — depends only on scope size', () => {
    // Whatever the rest of the map holds, a 20-day scope at 5 workers is ~4 days.
    const r = scopedCapacityDays(20, { workers: 5, unitsPerDay: 1, fudge: 1, focusFactor: 1 });
    expect(r.plannedCalendarDays).toBeCloseTo(4, 6);
  });

  it('clamps focus and never divides by zero capacity', () => {
    const r = scopedCapacityDays(10, { workers: 0, unitsPerDay: 0, fudge: 1, focusFactor: 5 });
    expect(Number.isFinite(r.plannedCalendarDays)).toBe(true);
    expect(Number.isFinite(r.velocityCalendarDays)).toBe(true);
  });
});

describe('analyzeRepoThroughput', () => {
  it('rework = correction keyword AND reference to an in-window PR (both required)', () => {
    const prs = [
      pr(1, 'feat(a): new thing', 0, 0.5),
      pr(2, 'feat(b): another', 1, 1.4),
      pr(3, 'fix(a): correct #1 regression', 2, 2.5), // keyword + ref → rework
      pr(4, 'follow-up to #2', 3, 3.2),               // keyword + ref → rework
      pr(5, 'feat(c): builds on #1', 4, 4.3),         // ref only, NO keyword → NOT rework
      pr(6, 'fix(z): standalone bug', 5, 5.3),        // keyword only, NO ref → NOT rework
    ];
    const rt = analyzeRepoThroughput(prs);
    expect(rt.merged).toBe(6);
    expect(rt.reworkCount).toBe(2); // only #3, #4
    expect(rt.reworkFraction).toBeCloseTo(2 / 6, 6);
  });

  it('computes review-latency stats and offline (>6h) merges', () => {
    const prs = [
      pr(1, 'a', 0, 0.4),   // 0.4h
      pr(2, 'b', 0, 0.6),   // 0.6h
      pr(3, 'c', 0, 12),    // 12h → offline
    ];
    const rt = analyzeRepoThroughput(prs);
    expect(rt.medianLatencyHours).toBeCloseTo(0.6, 6);
    expect(rt.maxLatencyHours).toBeCloseTo(12, 6);
    expect(rt.offlineMergeCount).toBe(1);
  });

  it('a reference to a PR NOT in the window is not rework by itself', () => {
    const prs = [pr(10, 'feat: extends #9999 (not in window)', 0, 0.5)];
    const rt = analyzeRepoThroughput(prs);
    expect(rt.reworkCount).toBe(0);
  });

  it('empty input is safe', () => {
    const rt = analyzeRepoThroughput([]);
    expect(rt.merged).toBe(0);
    expect(rt.reworkFraction).toBe(0);
    expect(rt.medianLatencyHours).toBe(0);
  });
});

describe('netDeliveryRate', () => {
  it('discounts gross by the rework fraction', () => {
    expect(netDeliveryRate(3.2, 0.42)).toBeCloseTo(3.2 * 0.58, 6);
    expect(netDeliveryRate(2, 0)).toBe(2);
    expect(netDeliveryRate(2, 1)).toBe(0);
  });
  it('clamps out-of-range fractions', () => {
    expect(netDeliveryRate(2, 1.5)).toBe(0);
    expect(netDeliveryRate(2, -1)).toBe(2);
  });
});
