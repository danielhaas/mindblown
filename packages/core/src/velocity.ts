/**
 * Velocity & capacity helpers.
 *
 * The **focus factor** models the fraction of a worker's calendar time that
 * actually reaches planned-ticket work. Meetings, support, firefighting and
 * unplanned tickets all eat into a day — a team that spends half its time on
 * planned work has a focus factor of 0.5, so the same estimated effort takes
 * twice as long in calendar terms.
 *
 * It is orthogonal to the estimation *fudge factor* (actual/estimate): the
 * fudge factor corrects how a ticket is *sized*, the focus factor corrects how
 * much sizing gets *delivered* per calendar day. A realistic completion
 * forecast applies both:
 *
 *     calendarDays = schedulerDays × fudgeFactor ÷ focusFactor
 *
 * Default 1.0 = no capacity leakage (the historical behaviour — every existing
 * map forecasts exactly as before until its focus factor is set).
 */

export const FOCUS_FACTOR_MIN = 0.05;
export const FOCUS_FACTOR_MAX = 1;
export const DEFAULT_FOCUS_FACTOR = 1;

/**
 * Clamp a focus factor to the sane range (0.05, 1]. A factor above 1 would
 * mean spending more than 100% of calendar time on planned work (that's the
 * fudge factor's job, not this knob); a factor at/below 0 would blow up the
 * `÷ focusFactor` division. Non-finite / missing values fall back to the
 * default (1.0 = no effect).
 */
export function clampFocusFactor(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_FOCUS_FACTOR;
  return Math.min(FOCUS_FACTOR_MAX, Math.max(FOCUS_FACTOR_MIN, value));
}

/**
 * Capacity-based calendar projection for a **scoped** forecast (a version /
 * milestone or a subtree), from now.
 *
 * The whole-map completion forecast runs the critical-path scheduler over the
 * entire map and reads a scope's finish off where its leaves land in that
 * global ordering. For a *scoped* forecast that is wrong: the milestone's
 * leaves get buried behind the entire backlog, so the date reflects the
 * backlog's size, not the milestone's. When you commit to a milestone you work
 * *it*, so the honest projection is its own remaining effort against the team's
 * capacity:
 *
 *     plannedCalendarDays  = remaining ÷ (workers × unitsPerDay)
 *     velocityCalendarDays = remaining × fudge ÷ (workers × unitsPerDay × focus)
 *
 * Both are measured from today (the work is ahead of you). This intentionally
 * ignores within-scope dependency chains — a milestone with a long serial
 * critical path can run longer than pure capacity implies; that refinement can
 * schedule the isolated subtree later. It is still far closer than the
 * backlog-buried scheduler position it replaces.
 */
export interface ScopedCapacityInput {
  workers: number;
  unitsPerDay: number;
  fudge: number;
  focusFactor: number;
}

export function scopedCapacityDays(
  remainingEffort: number,
  opts: ScopedCapacityInput,
): { plannedCalendarDays: number; velocityCalendarDays: number } {
  const capacityPerDay = Math.max(1e-9, opts.workers * opts.unitsPerDay);
  const focus = clampFocusFactor(opts.focusFactor);
  const rem = Math.max(0, remainingEffort);
  return {
    plannedCalendarDays: rem / capacityPerDay,
    velocityCalendarDays: (rem * opts.fudge) / (capacityPerDay * focus),
  };
}
