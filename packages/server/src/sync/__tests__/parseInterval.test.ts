/**
 * Tests for `parsePositiveIntMs` — the shared env-var → ms parser.
 *
 * The whole point of this helper is to prevent `setInterval(NaN)` from
 * turning into event-loop-rate firing. The cases below pin every
 * fallback path so a future refactor can't silently regress the guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parsePositiveIntMs } from '../parseInterval.js';

describe('parsePositiveIntMs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns default when env value is undefined', () => {
    expect(parsePositiveIntMs(undefined, 5000)).toBe(5000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns default when env value is empty string', () => {
    expect(parsePositiveIntMs('', 5000)).toBe(5000);
    // Empty string is the "unset" path — no warn fired (the operator
    // didn't typo, they just didn't set the var).
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns parsed value when env value is a positive integer', () => {
    expect(parsePositiveIntMs('60000', 5000)).toBe(60000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns default and warns on a trailing-unit typo like "1d"', () => {
    // The motivating case from #85 — but with the actual JS semantics:
    // `parseInt('1d', 10)` returns `1` (NOT NaN — parseInt stops at the
    // first non-digit), so without the leading regex guard you'd end up
    // with `setInterval(fn, 1)` firing every 1 ms. The strict regex
    // gate catches it.
    expect(parsePositiveIntMs('1d', 5000)).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0].join(' ')).toContain('1d');
  });

  it('returns default and warns on a fully non-numeric value', () => {
    expect(parsePositiveIntMs('abc', 5000)).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns default and warns on zero', () => {
    expect(parsePositiveIntMs('0', 5000)).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns default and warns on a negative integer', () => {
    expect(parsePositiveIntMs('-1000', 5000)).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('honours `minMs` floor — returns default when below', () => {
    expect(parsePositiveIntMs('500', 5000, 1000)).toBe(5000);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0].join(' ');
    expect(warnMsg).toContain('1000');
  });

  it('honours `minMs` floor — returns value when at or above', () => {
    expect(parsePositiveIntMs('1000', 5000, 1000)).toBe(1000);
    expect(parsePositiveIntMs('2000', 5000, 1000)).toBe(2000);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
