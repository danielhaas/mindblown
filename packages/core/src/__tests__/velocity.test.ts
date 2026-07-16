import { describe, it, expect } from 'vitest';
import {
  clampFocusFactor,
  scopedCapacityDays,
  DEFAULT_FOCUS_FACTOR,
  FOCUS_FACTOR_MIN,
  FOCUS_FACTOR_MAX,
} from '../velocity.js';

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
