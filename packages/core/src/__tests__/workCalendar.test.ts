import { describe, it, expect } from 'vitest';
import { makeDayMapper, applyHolidayOverrides, hasWorkingCalendar, isIsoDate } from '../workCalendar.js';
import { addBusinessDays } from '../calendar.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
// Liechtenstein's public holidays around Christmas 2026 (date-holidays, type public).
const LI_DEC_2026 = new Set(['2026-12-08', '2026-12-25', '2026-12-26']);

describe('makeDayMapper — no working calendar (#110)', () => {
  it('counts every day, exactly as before the holiday calendar', () => {
    const m = makeDayMapper('2026-12-23', null);
    expect(m.workingCalendar).toBe(false);
    expect(iso(m.toDate(3))).toBe('2026-12-26');
    expect(m.toOffset('2026-12-28')).toBe(5);
    expect(m.toOffset('2026-12-20')).toBe(-3);
    expect(iso(m.toDate(2.4, 'ceil'))).toBe('2026-12-26');
    // 3 days from 23 Dec end (exclusive) 26 Dec; the last day worked is 25 Dec.
    expect(iso(m.lastDay(3))).toBe('2026-12-25');
    expect(iso(m.lastDay(2.4))).toBe('2026-12-25');
  });
});

describe('makeDayMapper — working calendar (#110)', () => {
  it('a 3-day task from 23 Dec on the LI calendar ends (exclusive) 29 Dec / last work day 28 Dec', () => {
    // Works 23 (Wed) and 24 (Thu); 25 + 26 are holidays, 27 is Sunday; the
    // third working day is Mon 28 — the day it ends — so the next work can
    // start on 29.
    expect(iso(addBusinessDays(new Date('2026-12-23'), 3, LI_DEC_2026))).toBe('2026-12-29');
    const m = makeDayMapper('2026-12-23', LI_DEC_2026);
    expect(iso(m.toDate(3))).toBe('2026-12-29'); // exclusive end = next start
    expect(iso(m.lastDay(3))).toBe('2026-12-28'); // the finish date reported
    expect(iso(m.lastDay(2.5))).toBe('2026-12-28'); // part of a day still ends that day
  });

  it('lookups far outside the precomputed window still answer', () => {
    const m = makeDayMapper('2026-12-23', LI_DEC_2026);
    const far = m.toOffset('2050-06-01');
    expect(iso(m.toDate(far))).toBe('2050-06-01'); // a Wednesday
    expect(m.toOffset('2000-01-03')).toBeLessThan(-6000);
  });

  it('toOffset and toDate are inverses on working days, before and after the anchor', () => {
    const m = makeDayMapper('2026-12-23', LI_DEC_2026);
    for (const day of ['2026-12-23', '2026-12-24', '2026-12-28', '2026-12-29', '2027-01-04', '2026-12-07', '2026-12-09']) {
      expect(iso(m.toDate(m.toOffset(day)))).toBe(day);
    }
    expect(m.toOffset('2026-12-28')).toBe(2);
    expect(m.toOffset('2026-12-09')).toBe(-10); // 9–22 Dec minus weekends; 8 Dec is before
  });

  it('a non-working date sits at the boundary of the next working day', () => {
    const m = makeDayMapper('2026-12-23', LI_DEC_2026);
    expect(m.toOffset('2026-12-26')).toBe(2); // Saturday holiday — same boundary as Mon 28
    expect(m.toOffset('2026-12-27')).toBe(2);
  });

  it('an anchor on a weekend snaps to the next working day', () => {
    const m = makeDayMapper('2026-12-26', LI_DEC_2026);
    expect(iso(m.toDate(0))).toBe('2026-12-28');
    expect(m.toOffset('2026-12-28')).toBe(0);
  });

  it('an empty holiday set is still a working calendar — weekends skipped', () => {
    const m = makeDayMapper('2026-12-25', new Set());
    expect(m.workingCalendar).toBe(true);
    expect(iso(m.toDate(1))).toBe('2026-12-28');
  });
});

describe('holiday overrides (#110)', () => {
  it('add puts days off in, remove takes jurisdiction holidays out', () => {
    const s = applyHolidayOverrides(LI_DEC_2026, { add: ['2026-12-31'], remove: ['2026-12-08'] });
    expect([...s].sort()).toEqual(['2026-12-25', '2026-12-26', '2026-12-31']);
  });

  it('a map is on a working calendar once a jurisdiction or any override is set', () => {
    expect(hasWorkingCalendar({})).toBe(false);
    expect(hasWorkingCalendar({ holidayJurisdiction: null, holidayOverrides: { add: [], remove: [] } })).toBe(false);
    expect(hasWorkingCalendar({ holidayJurisdiction: 'LI' })).toBe(true);
    expect(hasWorkingCalendar({ holidayOverrides: { add: ['2026-12-31'], remove: [] } })).toBe(true);
  });

  it('isIsoDate rejects impossible dates', () => {
    expect(isIsoDate('2026-12-31')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('31.12.2026')).toBe(false);
  });
});
