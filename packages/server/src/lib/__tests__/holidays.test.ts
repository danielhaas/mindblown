/**
 * Holiday resolution (#110) against the real date-holidays data — the
 * library is the source of truth, so these pin what we take from it.
 */
import { describe, it, expect } from 'vitest';
import { addBusinessDays } from '@mindblown/core';
import {
  isSupportedJurisdiction,
  publicHolidays,
  resolveHolidays,
  normalizeHolidaySettings,
  mapDayMapper,
} from '../holidays.js';

describe('date-holidays resolution', () => {
  it('knows countries and regions, and nothing made up', () => {
    expect(isSupportedJurisdiction('LI')).toBe(true);
    expect(isSupportedJurisdiction('ch-zh')).toBe(true);
    expect(isSupportedJurisdiction('DE-BY')).toBe(true);
    expect(isSupportedJurisdiction('CH-QQ')).toBe(false);
    expect(isSupportedJurisdiction('XX')).toBe(false);
    expect(isSupportedJurisdiction('not a code')).toBe(false);
  });

  it('takes only public holidays — LI Christmas is in, observances are not', () => {
    const li = publicHolidays('LI', 2026, 2026);
    expect(li).toEqual(expect.arrayContaining(['2026-12-25', '2026-12-26', '2026-12-08']));
    expect(li).not.toContain('2026-12-24'); // Christmas Eve is not a public holiday in LI
  });

  it('a 3-day task from 23 Dec 2026 on the LI calendar ends (exclusive) 29 Dec / last work day 28 Dec', () => {
    const holidays = resolveHolidays('LI', undefined, 2026, 2027)!;
    expect(addBusinessDays(new Date('2026-12-23'), 3, holidays).toISOString().slice(0, 10)).toBe('2026-12-29');
    const { mapper } = mapDayMapper({ holidayJurisdiction: 'LI' }, new Date('2026-12-23'));
    expect(mapper.lastDay(3).toISOString().slice(0, 10)).toBe('2026-12-28');
  });

  it('caches a resolved calendar — the same Set comes back', () => {
    const a = resolveHolidays('LI', { add: ['2026-12-31'], remove: [] }, 2026, 2027);
    const b = resolveHolidays('LI', { add: ['2026-12-31'], remove: [] }, 2026, 2027);
    expect(a).toBe(b);
    expect(resolveHolidays('LI', { add: [], remove: [] }, 2026, 2027)).not.toBe(a);
  });

  it('resolves far enough ahead to cover a long projection', () => {
    const { holidays } = mapDayMapper({ holidayJurisdiction: 'LI' }, new Date('2026-12-23'), new Date('2026-12-23'));
    expect(holidays!.has('2041-12-25')).toBe(true);
  });

  it('no jurisdiction and no overrides = no working calendar', () => {
    expect(resolveHolidays(null, { add: [], remove: [] }, 2026, 2027)).toBeNull();
    expect(mapDayMapper({}, new Date('2026-12-23')).mapper.workingCalendar).toBe(false);
  });

  it('overrides apply on top of the jurisdiction', () => {
    const s = resolveHolidays('LI', { add: ['2026-12-31'], remove: ['2026-12-26'] }, 2026, 2026)!;
    expect(s.has('2026-12-31')).toBe(true);
    expect(s.has('2026-12-26')).toBe(false);
    expect(s.has('2026-12-25')).toBe(true);
  });
});

describe('normalizeHolidaySettings', () => {
  it('upper-cases the code, clears an empty one, dedupes and sorts overrides', () => {
    const input = { holidayJurisdiction: ' ch-zh ', holidayOverrides: { add: ['2026-12-31', '2026-01-02', '2026-12-31'], remove: [] } };
    expect(normalizeHolidaySettings(input)).toBeNull();
    expect(input).toEqual({ holidayJurisdiction: 'CH-ZH', holidayOverrides: { add: ['2026-01-02', '2026-12-31'], remove: [] } });
    const cleared = { holidayJurisdiction: '' as string | null };
    expect(normalizeHolidaySettings(cleared)).toBeNull();
    expect(cleared.holidayJurisdiction).toBeNull();
  });

  it('names what is wrong', () => {
    expect(normalizeHolidaySettings({ holidayJurisdiction: 'ZZ' })).toMatch(/Unknown holiday jurisdiction/);
    expect(normalizeHolidaySettings({ holidayOverrides: { add: ['tomorrow'], remove: [] } })).toMatch(/YYYY-MM-DD/);
  });
});
