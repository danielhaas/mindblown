/**
 * Unit tests for `resolveDriftAuditIntervalMs` (closes #72).
 *
 * The helper resolves the drift-audit cadence from an optional
 * `DRIFT_AUDIT_INTERVAL_MS` env-var string. Five invariants:
 *
 *   1. Unset (undefined)                 → default 6h, no warn
 *   2. Valid integer ≥ MIN (e.g. 6h)     → used as-is, no warn
 *   3. Below MIN (e.g. 60_000 = 1 min)   → fall back to default + warn
 *   4. Non-numeric / NaN (e.g. "6h")     → fall back to default + warn
 *   5. Zero                              → fall back to default + warn
 *
 * The min-interval guard is critical: without it, an env-var typo
 * could turn setInterval into a busy-loop hammering the GitHub API
 * across every opted-in map (see deploy/README.md "Tuning the
 * drift-audit cadence" for the rationale).
 *
 * The helper is a pure function exported from `index.ts` purely so
 * this test can verify it without booting Fastify. The production
 * call site reads `process.env.DRIFT_AUDIT_INTERVAL_MS` directly
 * during `main()`; we exercise the same resolution logic here by
 * passing strings directly, which is functionally equivalent and
 * avoids env-var teardown noise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  DEFAULT_DRIFT_AUDIT_INTERVAL_MS,
  MIN_DRIFT_AUDIT_INTERVAL_MS,
  resolveDriftAuditIntervalMs,
} from '../sync/driftAuditInterval.js';

describe('resolveDriftAuditIntervalMs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the 6h default when the env var is unset', () => {
    const result = resolveDriftAuditIntervalMs(undefined);
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);
    expect(result).toBe(6 * 60 * 60 * 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses the override when the env var is a valid integer ≥ MIN', () => {
    // 4h — above the 1h floor, below the 6h default.
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const result = resolveDriftAuditIntervalMs(String(fourHoursMs));
    expect(result).toBe(fourHoursMs);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses the override at the MIN boundary exactly', () => {
    // 1h exactly — the floor, must be accepted (≥, not >).
    const result = resolveDriftAuditIntervalMs(
      String(MIN_DRIFT_AUDIT_INTERVAL_MS),
    );
    expect(result).toBe(MIN_DRIFT_AUDIT_INTERVAL_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to default and warns when the value is below MIN', () => {
    // 1 min — well below the 1h floor.
    const result = resolveDriftAuditIntervalMs('60000');
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnText).toContain('DRIFT_AUDIT_INTERVAL_MS=60000');
    expect(warnText).toContain('invalid');
    expect(warnText).toContain(String(DEFAULT_DRIFT_AUDIT_INTERVAL_MS));
  });

  it('falls back to default and warns on a non-numeric value (NaN guard)', () => {
    // `parseInt("6h", 10)` returns 6 — fails the MIN check, NOT NaN.
    // But `parseInt("not-a-number", 10)` returns NaN.  Both must
    // fall back — exercise the genuinely-NaN path here.
    const result = resolveDriftAuditIntervalMs('not-a-number');
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnText).toContain('DRIFT_AUDIT_INTERVAL_MS=not-a-number');
    expect(warnText).toContain('invalid');
  });

  it('falls back to default and warns on the "6h" typo (parseInt → 6, below MIN)', () => {
    // The classic env-var typo the min guard exists to catch.
    const result = resolveDriftAuditIntervalMs('6h');
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnText).toContain('DRIFT_AUDIT_INTERVAL_MS=6h');
  });

  it('falls back to default and warns when the value is zero (DDoS guard)', () => {
    // The single most dangerous typo: `setInterval(callback, 0)` is
    // an event-loop-rate busy loop.  Must be rejected.
    const result = resolveDriftAuditIntervalMs('0');
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnText).toContain('DRIFT_AUDIT_INTERVAL_MS=0');
    expect(warnText).toContain('invalid');
  });

  it('falls back to default and warns when the value is negative', () => {
    const result = resolveDriftAuditIntervalMs('-1');
    expect(result).toBe(DEFAULT_DRIFT_AUDIT_INTERVAL_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes a 1h minimum constant', () => {
    // Pin the documented contract so an accidental tightening (e.g.
    // someone drops it to 60_000 "for testing") trips a test instead
    // of shipping silently.
    expect(MIN_DRIFT_AUDIT_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('exposes a 6h default constant', () => {
    expect(DEFAULT_DRIFT_AUDIT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
