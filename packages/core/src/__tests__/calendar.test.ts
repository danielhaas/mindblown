import { describe, it, expect } from 'vitest';
import { addBusinessDays, businessDaysBetween, hoursToBusinessDays } from '../calendar.js';

// All dates in these tests use UTC midnight to avoid local-timezone surprises.

function utcDate(yyyy: number, mm: number, dd: number): Date {
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

describe('addBusinessDays', () => {
  it('adds 0 business days on a weekday returns same day', () => {
    // Monday 2026-06-01
    const mon = utcDate(2026, 6, 1);
    expect(addBusinessDays(mon, 0).toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('skips weekends when adding 1 business day from Friday', () => {
    // Friday 2026-06-05 + 1 business day = Monday 2026-06-08
    const fri = utcDate(2026, 6, 5);
    expect(addBusinessDays(fri, 1).toISOString().slice(0, 10)).toBe('2026-06-08');
  });

  it('adds 5 business days spanning a weekend', () => {
    // Monday 2026-06-01 + 5 = Monday 2026-06-08
    const mon = utcDate(2026, 6, 1);
    expect(addBusinessDays(mon, 5).toISOString().slice(0, 10)).toBe('2026-06-08');
  });

  it('snaps a weekend start forward before counting', () => {
    // Saturday 2026-06-06 + 2 → snap to Mon 2026-06-08 + 2 = Wed 2026-06-10
    const sat = utcDate(2026, 6, 6);
    expect(addBusinessDays(sat, 2).toISOString().slice(0, 10)).toBe('2026-06-10');
  });

  it('respects holiday set', () => {
    // Monday 2026-06-01 + 1, but Tuesday 2026-06-02 is a holiday → result = Wednesday
    const mon = utcDate(2026, 6, 1);
    const holidays = new Set(['2026-06-02']);
    expect(addBusinessDays(mon, 1, holidays).toISOString().slice(0, 10)).toBe('2026-06-03');
  });
});

describe('businessDaysBetween', () => {
  it('returns 0 when b <= a', () => {
    const d = utcDate(2026, 6, 1);
    expect(businessDaysBetween(d, d)).toBe(0);
  });

  it('counts Mon–Fri across one weekend', () => {
    // Mon 2026-06-01 → Mon 2026-06-08 = 5 business days
    const a = utcDate(2026, 6, 1);
    const b = utcDate(2026, 6, 8);
    expect(businessDaysBetween(a, b)).toBe(5);
  });

  it('excludes the start day and includes the end day', () => {
    // Mon → Tue = 1 business day
    const a = utcDate(2026, 6, 1);
    const b = utcDate(2026, 6, 2);
    expect(businessDaysBetween(a, b)).toBe(1);
  });

  it('skips weekend days in the count', () => {
    // Fri 2026-06-05 → Mon 2026-06-08 = 1 business day (just Monday)
    const a = utcDate(2026, 6, 5);
    const b = utcDate(2026, 6, 8);
    expect(businessDaysBetween(a, b)).toBe(1);
  });

  it('respects holidays', () => {
    // Mon → Mon (1 week) with Tuesday as holiday → 4 business days
    const a = utcDate(2026, 6, 1);
    const b = utcDate(2026, 6, 8);
    const holidays = new Set(['2026-06-02']);
    expect(businessDaysBetween(a, b, holidays)).toBe(4);
  });
});

describe('hoursToBusinessDays', () => {
  it('4h with 8h/day = 1 business day', () => {
    expect(hoursToBusinessDays(4, 8)).toBe(1);
  });

  it('8h with 8h/day = 1 business day', () => {
    expect(hoursToBusinessDays(8, 8)).toBe(1);
  });

  it('12h with 8h/day = 2 business days (spec example)', () => {
    expect(hoursToBusinessDays(12, 8)).toBe(2);
  });

  it('16h with 8h/day = 2 business days', () => {
    expect(hoursToBusinessDays(16, 8)).toBe(2);
  });

  it('24h with 8h/day = 3 business days (spec example: 8h→1, 24h→3)', () => {
    expect(hoursToBusinessDays(24, 8)).toBe(3);
  });

  it('0h = 0 business days', () => {
    expect(hoursToBusinessDays(0, 8)).toBe(0);
  });

  it('throws when hoursPerDay <= 0', () => {
    expect(() => hoursToBusinessDays(8, 0)).toThrow();
  });
});
