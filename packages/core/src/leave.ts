/**
 * Personal leave (#664): the days a person is away, entered once on their
 * profile and applied on every map they work on.
 *
 * The map's working calendar (#110) says which days count for everyone
 * (weekends, public holidays, the map's own days off). A person's leave
 * takes days off THAT calendar for the work that person does: a working
 * day for a track is a map working day minus its person's leave. A leave
 * day that is already a weekend or a holiday is not counted twice.
 *
 * Whose leave applies to a node:
 *   - fleet-built work (an approved ticket on a fleet map, no skip tag such
 *     as `needs-human`, nobody assigned) ignores leave — no person does it;
 *   - an assigned node follows its (first) assignee;
 *   - anything else follows the map worker of the track it lands on.
 */
import type { MindMap, Node } from './types.js';
import type { DayMapper } from './workCalendar.js';
import { isIsoDate, isWorkingDate } from './workCalendar.js';
import type { DaysOff } from './dependencies.js';
import { dispatchSkipTag } from './dispatch.js';

/** One stretch of leave, both days inclusive ('YYYY-MM-DD'). */
export interface LeaveRange {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  note: string | null;
  createdAt: string;
}

/** A person's leave as the scheduler needs it. */
export interface PersonLeave {
  userId: string;
  name: string;
  ranges: Array<Pick<LeaveRange, 'startDate' | 'endDate' | 'note'>>;
}

/** Longest single range accepted — a year and a bit. */
export const MAX_LEAVE_DAYS = 400;

const MS_PER_DAY = 86_400_000;

/** Validation for a new range — an error message, or null when fine. */
export function validateLeaveInput(input: { startDate?: unknown; endDate?: unknown; note?: unknown }): string | null {
  const { startDate, endDate, note } = input;
  if (typeof startDate !== 'string' || !isIsoDate(startDate)) return 'startDate must be a YYYY-MM-DD date.';
  if (typeof endDate !== 'string' || !isIsoDate(endDate)) return 'endDate must be a YYYY-MM-DD date.';
  if (endDate < startDate) return 'endDate must not be before startDate.';
  if ((Date.parse(endDate) - Date.parse(startDate)) / MS_PER_DAY + 1 > MAX_LEAVE_DAYS) {
    return `A leave range may span at most ${MAX_LEAVE_DAYS} days — enter longer absences as several ranges.`;
  }
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 200)) {
    return 'note must be a string of at most 200 characters.';
  }
  return null;
}

/**
 * The leave as scheduler days off: one [o, o + 1) interval (in scheduler
 * units) per day of leave that is a working day on the map's calendar.
 * `holidays` null = every day counts. `days` = how many such days.
 */
export function leaveDaysOff(
  ranges: Array<Pick<LeaveRange, 'startDate' | 'endDate'>>,
  mapper: DayMapper,
  holidays: Set<string> | null,
  unitsPerDay = 1,
): { off: DaysOff; days: number } {
  const offsets = new Set<number>();
  for (const r of ranges) {
    const end = Date.parse(r.endDate.slice(0, 10));
    for (let t = Date.parse(r.startDate.slice(0, 10)); t <= end; t += MS_PER_DAY) {
      const d = new Date(t);
      if (isWorkingDate(d, holidays)) offsets.add(mapper.toOffset(d));
    }
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  const off: DaysOff = [];
  for (const o of sorted) {
    const last = off[off.length - 1];
    if (last && last[1] === o * unitsPerDay) last[1] = (o + 1) * unitsPerDay;
    else off.push([o * unitsPerDay, (o + 1) * unitsPerDay]);
  }
  return { off, days: sorted.length };
}

/**
 * Work the fleet builds: no person does it, so nobody's leave applies. An
 * approved ticket on a map connected to a fleet, without a skip tag
 * (`needs-human` …: a person's step) and without an assignee.
 */
export function isFleetBuilt(
  map: Pick<MindMap, 'fleetId'>,
  node: Pick<Node, 'tags' | 'assigneeIds' | 'approval'>,
): boolean {
  return (
    Boolean(map.fleetId) &&
    node.approval?.state === 'approved' &&
    dispatchSkipTag(node) === null &&
    (node.assigneeIds?.length ?? 0) === 0
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** "21 Dec – 4 Jan", or "21 Dec" for a single day. */
export function formatLeaveRange(r: Pick<LeaveRange, 'startDate' | 'endDate'>): string {
  return r.startDate === r.endDate ? shortDate(r.startDate) : `${shortDate(r.startDate)} – ${shortDate(r.endDate)}`;
}

/**
 * The line a schedule reader gets (#664): "Includes leave: Dan 21 Dec – 4
 * Jan, Ana 3 Feb". Null when no leave is in the schedule.
 */
export function describeLeave(people: Array<Pick<PersonLeave, 'name' | 'ranges'>>): string | null {
  const parts = people.flatMap((p) => p.ranges.map((r) => `${p.name} ${formatLeaveRange(r)}`));
  return parts.length > 0 ? `Includes leave: ${parts.join(', ')}` : null;
}
