import { describe, it, expect } from 'vitest';
import {
  clampFocusFactor,
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
