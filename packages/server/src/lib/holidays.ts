/**
 * Public holidays for a map's working calendar (#110).
 *
 * Resolved here, on the server, rather than in core: `date-holidays` carries
 * the rules for ~200 countries, which has no place in the browser bundle.
 * The schedule response ships the resolved dates, so the Gantt and the MCP
 * schedule use exactly the set the server scheduled with.
 *
 * Only `type: 'public'` counts — bank holidays, observances and optional
 * days ("school", "optional") are not days off for everyone.
 */
import Holidays from 'date-holidays';
import { applyHolidayOverrides, hasWorkingCalendar, isIsoDate, makeDayMapper, type DayMapper } from '@mindblown/core';

/** 'LI', 'CH-ZH', 'DE-BY' → constructor args; null when the code is malformed. */
function parseCode(code: string): [string, string?] | null {
  const m = /^([A-Za-z]{2})(?:-([A-Za-z0-9]{1,3}))?$/.exec(code.trim());
  return m ? [m[1].toUpperCase(), m[2]?.toUpperCase()] : null;
}

const supportCache = new Map<string, boolean>();

/** Does date-holidays know this country / country-region? */
export function isSupportedJurisdiction(code: string): boolean {
  const key = code.trim().toUpperCase();
  const hit = supportCache.get(key);
  if (hit !== undefined) return hit;
  const parsed = parseCode(key);
  let ok = false;
  if (parsed) {
    const [country, region] = parsed;
    const hd = new Holidays();
    const countries = hd.getCountries() ?? {};
    if (country in countries) {
      ok = region ? region in (hd.getStates(country) ?? {}) : true;
    }
  }
  supportCache.set(key, ok);
  return ok;
}

/** Public holidays of a jurisdiction for the given years, 'YYYY-MM-DD'. */
export function publicHolidays(code: string, fromYear: number, toYear: number): string[] {
  const parsed = parseCode(code);
  if (!parsed || !isSupportedJurisdiction(code)) return [];
  const [country, region] = parsed;
  const hd = region ? new Holidays(country, region) : new Holidays(country);
  const out: string[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (const h of hd.getHolidays(y) ?? []) {
      if (h.type === 'public') out.push(h.date.slice(0, 10));
    }
  }
  return out;
}

/**
 * The holiday set a map schedules with, or null when the map has no working
 * calendar (every day counts — the pre-#110 behaviour).
 */
export function resolveHolidays(
  jurisdiction: string | null | undefined,
  overrides: { add?: string[]; remove?: string[] } | null | undefined,
  fromYear: number,
  toYear: number,
): Set<string> | null {
  if (!hasWorkingCalendar({ holidayJurisdiction: jurisdiction, holidayOverrides: overrides })) return null;
  // Every schedule, forecast and release-table request resolves the same few
  // calendars — keep them in-process. The returned Set is shared: read only.
  const key = `${jurisdiction ?? ''}|${(overrides?.add ?? []).join(',')}|${(overrides?.remove ?? []).join(',')}|${fromYear}-${toYear}`;
  const hit = resolvedCache.get(key);
  if (hit) return hit;
  const base = jurisdiction ? publicHolidays(jurisdiction, fromYear, toYear) : [];
  const set = applyHolidayOverrides(base, overrides);
  if (resolvedCache.size >= RESOLVED_CACHE_MAX) resolvedCache.clear();
  resolvedCache.set(key, set);
  return set;
}

const RESOLVED_CACHE_MAX = 200;
const resolvedCache = new Map<string, Set<string>>();

/**
 * Years worth resolving around a schedule: a few back for done work, and
 * far enough ahead to cover the projection's end — the day mapper
 * precomputes 15 years past the anchor, so the holidays reach as far.
 */
export function holidayYears(anchor: Date, now: Date = new Date()): [number, number] {
  const a = anchor.getUTCFullYear();
  const t = now.getUTCFullYear();
  return [Math.min(a, t) - 3, Math.max(a, t) + 15];
}

/**
 * The day mapper a map's schedule uses from `anchor`, and the holiday set
 * behind it (null = every day counts). One call per projection so the
 * schedule route, planned finishes and forecasts all agree.
 */
export function mapDayMapper(
  map: { holidayJurisdiction?: string | null; holidayOverrides?: { add?: string[]; remove?: string[] } | null },
  anchor: Date,
  now: Date = new Date(),
): { mapper: DayMapper; holidays: Set<string> | null } {
  const [from, to] = holidayYears(anchor, now);
  const holidays = resolveHolidays(map.holidayJurisdiction, map.holidayOverrides, from, to);
  return { mapper: makeDayMapper(anchor, holidays), holidays };
}

/**
 * Validate the holiday fields of a map update and normalise them in place
 * ('ch-zh' → 'CH-ZH', '' → null). Returns an error message, or null. Every
 * write path calls this — the REST route and the in-app chat backend.
 */
export function normalizeHolidaySettings(input: {
  holidayJurisdiction?: string | null;
  holidayOverrides?: { add: string[]; remove: string[] };
}): string | null {
  const error = holidaySettingsError(input);
  if (error) return error;
  if (typeof input.holidayJurisdiction === 'string') {
    input.holidayJurisdiction = input.holidayJurisdiction.trim().toUpperCase() || null;
  }
  if (input.holidayOverrides) {
    input.holidayOverrides = {
      add: [...new Set(input.holidayOverrides.add)].sort(),
      remove: [...new Set(input.holidayOverrides.remove)].sort(),
    };
  }
  return null;
}

/** Validation for the two map fields — an error message, or null when fine. */
export function holidaySettingsError(input: {
  holidayJurisdiction?: unknown;
  holidayOverrides?: unknown;
}): string | null {
  const j = input.holidayJurisdiction;
  if (j !== undefined && j !== null && j !== '') {
    if (typeof j !== 'string' || !isSupportedJurisdiction(j)) {
      return `Unknown holiday jurisdiction "${String(j)}" — use a country code (LI, AT) or country-region (CH-ZH, DE-BY).`;
    }
  }
  const o = input.holidayOverrides;
  if (o !== undefined) {
    if (!o || typeof o !== 'object') return 'holidayOverrides must be { add: string[], remove: string[] }.';
    for (const key of ['add', 'remove'] as const) {
      const list = (o as Record<string, unknown>)[key];
      if (!Array.isArray(list) || list.some((d) => typeof d !== 'string' || !isIsoDate(d))) {
        return `holidayOverrides.${key} must be a list of YYYY-MM-DD dates.`;
      }
    }
  }
  return null;
}
