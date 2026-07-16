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
