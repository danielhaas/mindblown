/**
 * Business-day calendar helpers for the Gantt scheduler.
 *
 * Slice 1 operates on Mon–Fri only. The `holidays` parameter is accepted on all
 * public functions to establish the API seam for the follow-up public-holiday
 * ticket (#110); until then it is always passed as `undefined` or an empty Set.
 */

/**
 * Returns true if the given date falls on a Saturday (6) or Sunday (0) in UTC.
 */
function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Returns true if the given date is a holiday (format: 'YYYY-MM-DD').
 */
function isHoliday(d: Date, holidays?: Set<string>): boolean {
  if (!holidays || holidays.size === 0) return false;
  const key = d.toISOString().slice(0, 10);
  return holidays.has(key);
}

/**
 * Returns true if the given date is a non-working day (weekend or holiday).
 */
function isNonWorking(d: Date, holidays?: Set<string>): boolean {
  return isWeekend(d) || isHoliday(d, holidays);
}

/**
 * Add `days` business days to `start`. Returns a new Date at UTC midnight.
 *
 * - If `start` itself is a non-working day, it is first snapped forward to
 *   the next working day before counting begins.
 * - `days` may be 0 (returns the same effective working day) or negative
 *   (not required by slice 1 but handled gracefully by counting backwards).
 */
export function addBusinessDays(
  start: Date,
  days: number,
  holidays?: Set<string>,
): Date {
  const result = new Date(start);
  result.setUTCHours(0, 0, 0, 0);

  // Snap to the next working day if start itself is non-working
  while (isNonWorking(result, holidays)) {
    result.setUTCDate(result.getUTCDate() + 1);
  }

  let remaining = days;
  const step = remaining >= 0 ? 1 : -1;

  while (remaining !== 0) {
    result.setUTCDate(result.getUTCDate() + step);
    if (!isNonWorking(result, holidays)) {
      remaining -= step;
    }
  }

  return result;
}

/**
 * Count business days between two dates (both at UTC midnight).
 *
 * Returns the number of Mon–Fri (non-holiday) days strictly after `a` and on
 * or before `b`. If `b <= a`, returns 0.
 */
export function businessDaysBetween(
  a: Date,
  b: Date,
  holidays?: Set<string>,
): number {
  if (b <= a) return 0;
  const cur = new Date(a);
  cur.setUTCHours(0, 0, 0, 0);
  let count = 0;
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (!isNonWorking(cur, holidays)) count++;
  }
  return count;
}

/**
 * Convert an effort in hours to business days (ceiling).
 *
 * Examples (with hoursPerDay = 8):
 *   4h  → 1 business day   (ceil(4/8) = 1)
 *   8h  → 1 business day   (ceil(8/8) = 1)
 *  12h  → 2 business days  (ceil(12/8) = 2)
 *  16h  → 2 business days  (ceil(16/8) = 2)
 *  24h  → 3 business days  (ceil(24/8) = 3)
 */
export function hoursToBusinessDays(
  hours: number,
  hoursPerDay: number,
): number {
  if (hoursPerDay <= 0) throw new RangeError('hoursPerDay must be positive');
  return Math.ceil(hours / hoursPerDay);
}
