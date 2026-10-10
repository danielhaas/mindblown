/**
 * Where schedule offsets become dates (#110).
 *
 * The scheduler works in effort days counted from the project anchor. How a
 * day offset maps onto the calendar depends on the map:
 *
 *   - no working calendar (the default): every day counts — offset n is the
 *     anchor plus n calendar days. AI-fleet maps work weekends, and this is
 *     exactly how dates were computed before #110.
 *   - working calendar (`holidays` is a Set, possibly empty): only Mon–Fri
 *     days that are not holidays count — offset n is the start of the n-th
 *     working day after the (snapped) anchor.
 *
 * Offsets are boundaries: work that runs from offset s to offset e starts on
 * `toDate(s)` and is done at the START of `toDate(e)` (exclusive end). A
 * finish date shown to a person is the day the work ends — `lastDay(e)`,
 * the last working day — and slip against a target date is measured from
 * that day, so work finishing on its due day is on time, not one day late.
 *
 * One mapper, used by every place that turns offsets into dates or dates
 * into offsets (the schedule route, planned-finish projections, release
 * forecasts, the Gantt, the MCP schedule), so they cannot disagree.
 */
import { addBusinessDays } from './calendar.js';

const MS_PER_DAY = 86_400_000;
/** Working days precomputed around the anchor: lookups inside are O(1) / O(log n). */
const WINDOW_BACK_DAYS = 3 * 366;
const WINDOW_AHEAD_DAYS = 15 * 366;

export type OffsetRounding = 'floor' | 'ceil' | 'round';

export interface DayMapper {
  /** True when weekends and holidays are skipped. */
  readonly workingCalendar: boolean;
  /** Day offset of a date from the anchor (a date's offset is the boundary at its start). */
  toOffset(date: Date | string): number;
  /** The date at a day offset (a boundary); fractional offsets are rounded as asked. */
  toDate(offsetDays: number, rounding?: OffsetRounding): Date;
  /**
   * The day work that ends at `endOffset` (exclusive) finishes on — the last
   * (working) day it occupies. Use this for every finish date reported.
   */
  lastDay(endOffset: number): Date;
}

function utcMidnight(d: Date | string): Date {
  const r = typeof d === 'string' ? new Date(d.slice(0, 10)) : new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

function isWorking(d: Date, holidays: Set<string>): boolean {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(d.toISOString().slice(0, 10));
}

function roundBy(n: number, rounding: OffsetRounding): number {
  return rounding === 'floor' ? Math.floor(n) : rounding === 'ceil' ? Math.ceil(n) : Math.round(n);
}

/** Index of the first entry ≥ t (entries ascending). */
function lowerBound(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last day of work ending at `end` (exclusive): the boundary before it. */
function lastDayOffset(end: number): number {
  return Math.ceil(end) - 1;
}

/**
 * @param anchor   day 0 of the schedule
 * @param holidays null = every day counts; a Set = working calendar (Mon–Fri minus these dates)
 */
export function makeDayMapper(anchor: Date | string, holidays: Set<string> | null): DayMapper {
  const base = utcMidnight(anchor);
  if (!holidays) {
    const toDate = (offset: number, rounding: OffsetRounding = 'round') => {
      const r = new Date(base);
      r.setUTCDate(r.getUTCDate() + roundBy(offset, rounding));
      return r;
    };
    return {
      workingCalendar: false,
      toOffset: (date) => Math.round((utcMidnight(date).getTime() - base.getTime()) / MS_PER_DAY),
      toDate,
      lastDay: (end) => toDate(lastDayOffset(end)),
    };
  }

  // Day 0 is the first working day on or after the anchor.
  const start = addBusinessDays(base, 0, holidays);
  // Every working day in the window, ascending; `zero` is the index of `start`.
  const days: number[] = [];
  const cur = new Date(start.getTime() - WINDOW_BACK_DAYS * MS_PER_DAY);
  const windowEnd = start.getTime() + WINDOW_AHEAD_DAYS * MS_PER_DAY;
  while (cur.getTime() <= windowEnd) {
    if (isWorking(cur, holidays)) days.push(cur.getTime());
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  const zero = lowerBound(days, start.getTime());
  const first = days[0];
  const last = days[days.length - 1];

  const toDate = (offset: number, rounding: OffsetRounding = 'round'): Date => {
    const k = roundBy(offset, rounding);
    const i = zero + k;
    if (i >= 0 && i < days.length) return new Date(days[i]);
    return addBusinessDays(start, k, holidays); // outside the window: walk it
  };

  return {
    workingCalendar: true,
    toOffset: (date) => {
      const t = utcMidnight(date).getTime();
      // Working days in [start, d) — or minus those in [d, start) when d is earlier.
      if (t >= first && t <= last + MS_PER_DAY) return lowerBound(days, t) - zero;
      const before = t < start.getTime();
      const c = new Date(before ? t : start.getTime());
      const end = before ? start.getTime() : t;
      let count = 0;
      while (c.getTime() < end) {
        if (isWorking(c, holidays)) count++;
        c.setUTCDate(c.getUTCDate() + 1);
      }
      return before ? -count : count;
    },
    toDate,
    lastDay: (end) => toDate(lastDayOffset(end)),
  };
}

/** Apply a map's own days off on top of resolved jurisdiction holidays. */
export function applyHolidayOverrides(
  base: Iterable<string>,
  overrides: { add?: string[]; remove?: string[] } | null | undefined,
): Set<string> {
  const out = new Set(base);
  for (const d of overrides?.remove ?? []) out.delete(d);
  for (const d of overrides?.add ?? []) out.add(d);
  return out;
}

/** A map is on a working calendar once a jurisdiction or any override is set. */
export function hasWorkingCalendar(map: {
  holidayJurisdiction?: string | null;
  holidayOverrides?: { add?: string[]; remove?: string[] } | null;
}): boolean {
  return (
    Boolean(map.holidayJurisdiction) ||
    (map.holidayOverrides?.add?.length ?? 0) > 0 ||
    (map.holidayOverrides?.remove?.length ?? 0) > 0
  );
}

/** One line for map summaries (get_map), or null when every day counts. */
export function describeHolidayCalendar(map: {
  holidayJurisdiction?: string | null;
  holidayOverrides?: { add?: string[]; remove?: string[] } | null;
}): string | null {
  if (!hasWorkingCalendar(map)) return null;
  const add = map.holidayOverrides?.add?.length ?? 0;
  const remove = map.holidayOverrides?.remove?.length ?? 0;
  const parts = [
    map.holidayJurisdiction ? `${map.holidayJurisdiction} public holidays` : null,
    add > 0 ? `+${add} own day(s) off` : null,
    remove > 0 ? `${remove} holiday(s) worked` : null,
  ].filter(Boolean);
  return `Calendar: working days (Mon–Fri) — ${parts.join(', ')} skipped in schedule dates`;
}

/** 'YYYY-MM-DD' and a real calendar date. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
