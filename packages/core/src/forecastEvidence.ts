/**
 * How much history stands behind a scoped forecast (#319, #342, #343).
 *
 * A version / subtree / phase forecast used to run entirely on the WHOLE
 * map's past: the ticket rate was every completion in the map, the fudge
 * factor every calibrated leaf in the map. For a release created last week
 * that produced confident slip verdicts ("55 days late", "⚠ caution") that
 * were statements about the map's history, not about this release — and
 * read exactly like the verdicts of a release that really is in trouble.
 *
 * Three pieces, shared by the MCP tool, the /forecast route and the
 * Releases table so they cannot drift:
 *   - `assessForecastEvidence` — the scope's own completions in the
 *     measuring window decide `not_measurable` / `provisional` / `measured`;
 *   - `chooseTicketRate` — the scope's own completion rate once it has
 *     enough of them, the map-wide rate otherwise, always with the
 *     reference class spelled out;
 *   - `forecastHeadline` — one date, a confidence word and the range of
 *     the models, or no date at all while nothing is measurable.
 */

/** Own completions in the window before a scoped forecast counts as measured. */
export const MIN_OWN_COMPLETIONS = 10;
/** Own completions before the ticket model uses the scope's own rate. */
export const MIN_OWN_RATE_COMPLETIONS = 3;
/** Shortest span an own pace is measured over — a burst on one day is not a rate. */
export const MIN_OWN_SPAN_DAYS = 7;

/**
 * - not_measurable — never a completion of its own and the target (if any)
 *   still ahead: a release that has not started. No verdict.
 * - stalled — open work, no completion in the window, but EITHER it had
 *   completions before OR its target has passed: that is a red flag, not
 *   an absence of data, so verdicts stay on (low confidence).
 * - provisional / measured — below / at MIN_OWN_COMPLETIONS in the window.
 */
export type ForecastEvidenceState = 'not_measurable' | 'stalled' | 'provisional' | 'measured';

export interface ForecastEvidence {
  state: ForecastEvidenceState;
  /** Leaves in scope completed within the measuring window. */
  ownCompletions: number;
  /** …ever (organic completions only, see ownCompletionStats). */
  ownCompletionsEver: number;
  /** ISO timestamp of the latest own completion, or null. */
  lastCompletion: string | null;
  /** MIN_OWN_COMPLETIONS — rendered as "N of 10". */
  required: number;
  windowDays: number;
  /** One sentence; safe to render verbatim. */
  note: string;
}

interface CompletableLeaf {
  completedAt?: string | null;
  createdAt?: string | null;
  percentComplete?: number | null;
  status?: string | null;
}

/**
 * A node created and marked done within this long was imported done (the
 * forge import creates the node, then sets 100%), not worked on — its
 * completedAt is the import time, not history.
 */
export const IMPORTED_DONE_WITHIN_MS = 2 * 60_000;

export interface OwnCompletionStats {
  /** Organic completions within the window. */
  inWindow: number;
  /** Organic completions ever. */
  ever: number;
  /** Earliest organic completion inside the window (ISO), or null. */
  firstInWindow: string | null;
  /** Latest organic completion (ISO), or null. */
  last: string | null;
}

/** The scope's own completion history — done leaves with a real completedAt. */
export function ownCompletionStats(leaves: CompletableLeaf[], windowDays: number, now: Date = new Date()): OwnCompletionStats {
  const since = now.getTime() - windowDays * 86_400_000;
  const stats: OwnCompletionStats = { inWindow: 0, ever: 0, firstInWindow: null, last: null };
  let first = Infinity;
  let last = -Infinity;
  for (const l of leaves) {
    const done = (l.percentComplete ?? 0) >= 99.5 || l.status === 'done';
    if (!done || !l.completedAt) continue;
    const at = Date.parse(l.completedAt);
    if (!Number.isFinite(at) || at > now.getTime()) continue;
    const created = l.createdAt ? Date.parse(l.createdAt) : NaN;
    if (Number.isFinite(created) && at - created < IMPORTED_DONE_WITHIN_MS) continue;
    stats.ever++;
    if (at > last) last = at;
    if (at >= since) {
      stats.inWindow++;
      if (at < first) first = at;
    }
  }
  stats.firstInWindow = Number.isFinite(first) ? new Date(first).toISOString() : null;
  stats.last = Number.isFinite(last) ? new Date(last).toISOString() : null;
  return stats;
}

/**
 * Evidence state of a SCOPED forecast. The whole map's forecast runs on its
 * own history by definition — callers pass `scoped: false` and get
 * `measured`.
 */
export function assessForecastEvidence(input: {
  scoped: boolean;
  stats: OwnCompletionStats;
  windowDays: number;
  /** The scope's target (YYYY-MM-DD…), or null. */
  targetDate?: string | null;
  openLeaves: number;
  now?: Date;
}): ForecastEvidence {
  const { scoped, stats, windowDays, targetDate = null, openLeaves, now = new Date() } = input;
  const ownCompletions = stats.inWindow;
  const base = {
    ownCompletions,
    ownCompletionsEver: stats.ever,
    lastCompletion: stats.last,
    required: MIN_OWN_COMPLETIONS,
    windowDays,
  };
  if (!scoped) {
    return { ...base, state: 'measured', note: 'Whole map — forecast runs on its own history.' };
  }
  const today = now.toISOString().slice(0, 10);
  const overdue = openLeaves > 0 && targetDate != null && targetDate.slice(0, 10) < today;
  if (ownCompletions === 0 && openLeaves > 0) {
    if (stats.ever === 0 && !overdue) {
      return {
        ...base,
        state: 'not_measurable',
        note: `Not yet measurable — no completions of its own yet (0 of ${MIN_OWN_COMPLETIONS}). Dates project this scope at the map's pace; they are not a verdict on it.`,
      };
    }
    // Silence here would hide the red flag: overdue and unstarted, or work
    // that stopped.
    return {
      ...base,
      state: 'stalled',
      note:
        stats.ever === 0
          ? `Stalled — the target ${targetDate!.slice(0, 10)} has passed and none of its work is done yet.`
          : `Stalled — no completions of its own in the last ${windowDays}d (last ${stats.last!.slice(0, 10)})${overdue ? `, target ${targetDate!.slice(0, 10)} passed` : ''}.`,
    };
  }
  if (ownCompletions < MIN_OWN_COMPLETIONS) {
    return {
      ...base,
      state: 'provisional',
      note: `Provisional — ${ownCompletions} of ${MIN_OWN_COMPLETIONS} own completions in the last ${windowDays}d.`,
    };
  }
  return {
    ...base,
    state: 'measured',
    note: `Measured — ${ownCompletions} own completions in the last ${windowDays}d.`,
  };
}

export interface TicketRateChoice {
  /** Net tickets per day, or null when neither population can supply one. */
  ratePerDay: number | null;
  source: 'scope' | 'map' | null;
  /** The reference class, for the output line. */
  basis: string;
}

/**
 * Which ticket rate a forecast runs on (#342): the scope's own net rate once
 * it has MIN_OWN_RATE_COMPLETIONS completions in the window; else the
 * map-wide one — named as such, with how many of the scope's own completions
 * it contains, so nobody reads a map-wide pace as this release's.
 */
export function chooseTicketRate(input: {
  scoped: boolean;
  ownCompletions: number;
  windowDays: number;
  /**
   * Earliest own completion in the window (ownCompletionStats.firstInWindow):
   * the own pace is measured over the span the scope has actually been
   * worked (floor 7 days), not the whole window — a release three weeks old
   * would otherwise read at a third of its real pace.
   */
  firstOwnCompletion?: string | null;
  now?: Date;
  /** Net map-wide tickets/day, null when unmeasured. */
  mapRatePerDay: number | null;
  /** Map-wide completion events in the window (for the label). */
  mapCompletions: number | null;
  reworkFraction: number;
}): TicketRateChoice {
  const { scoped, ownCompletions, windowDays, mapRatePerDay, mapCompletions, reworkFraction, firstOwnCompletion = null, now = new Date() } = input;
  const rework = Math.min(1, Math.max(0, reworkFraction));
  if (scoped && ownCompletions >= MIN_OWN_RATE_COMPLETIONS) {
    const sinceFirst = firstOwnCompletion != null ? (now.getTime() - Date.parse(firstOwnCompletion)) / 86_400_000 : windowDays;
    const spanDays = Math.min(windowDays, Math.max(MIN_OWN_SPAN_DAYS, Math.ceil(sinceFirst)));
    return {
      ratePerDay: (ownCompletions / spanDays) * (1 - rework),
      source: 'scope',
      basis: `this scope's own pace: ${ownCompletions} completions in ${spanDays}d`,
    };
  }
  if (mapRatePerDay == null || mapRatePerDay <= 0) {
    return { ratePerDay: null, source: null, basis: 'no measured completion rate' };
  }
  const across = mapCompletions != null ? `${mapCompletions} completions` : 'completions';
  return {
    ratePerDay: mapRatePerDay,
    source: 'map',
    basis: scoped
      ? `map-wide pace: ${across} in ${windowDays}d across the whole map, mixed item types — ${ownCompletions} of them in this scope`
      : `map pace: ${across} in ${windowDays}d`,
  };
}

export type HeadlineConfidence = 'high' | 'medium' | 'low';

export interface ForecastHeadline {
  /** ISO date, or null while the scope is not yet measurable / nothing projects. */
  date: string | null;
  model: 'velocity' | 'ticket' | 'planned' | null;
  confidence: HeadlineConfidence | null;
  /** Earliest..latest across the available model dates. */
  range: { from: string; to: string } | null;
  /** Why this model, or why no date. */
  reason: string;
}

/**
 * One date for the reader who opens the tool for one number (#319).
 *
 * Model: the ticket model when the estimates cannot carry a day model (the
 * calibration says the estimate unit is off by more than 2x, or more than a
 * quarter of the open work is unestimated) and it is available; the
 * velocity-adjusted date otherwise; the planned date as a last resort.
 * Confidence: provisional evidence or a diverging cross-check is `low`; no
 * cross-check is `medium`; models agreeing on measured evidence is `high`.
 */
export function forecastHeadline(input: {
  evidence: ForecastEvidence;
  plannedDate: string | null;
  velocityDate: string | null;
  ticketDate: string | null;
  /** assessForecastConfidence(...).level */
  crossCheck: 'agree' | 'caution' | 'unmeasured';
  /** Fudge factor applied, or null when withheld. */
  fudgeFactor: number | null;
  openLeaves: number;
  unestimatedOpenLeaves: number;
}): ForecastHeadline {
  const { evidence, plannedDate, velocityDate, ticketDate, crossCheck, fudgeFactor, openLeaves, unestimatedOpenLeaves } = input;
  if (openLeaves <= 0) {
    return { date: null, model: null, confidence: null, range: null, reason: 'No open work in scope.' };
  }
  if (evidence.state === 'not_measurable') {
    return { date: null, model: null, confidence: null, range: null, reason: evidence.note };
  }
  const dates = [plannedDate, velocityDate, ticketDate].filter((d): d is string => d != null).sort();
  const range = dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null;

  const unitBroken = fudgeFactor != null && (fudgeFactor < 0.5 || fudgeFactor > 2);
  const mostlyUnestimated = unestimatedOpenLeaves > openLeaves * 0.25;
  let model: ForecastHeadline['model'] = null;
  let date: string | null = null;
  let reason: string;
  if ((unitBroken || mostlyUnestimated) && ticketDate) {
    model = 'ticket';
    date = ticketDate;
    reason = unitBroken
      ? 'ticket model — the estimate unit is off by more than 2x, so the day models cannot carry the date'
      : `ticket model — ${unestimatedOpenLeaves} of ${openLeaves} open tasks are unestimated and invisible to the day models`;
  } else if (velocityDate) {
    model = 'velocity';
    date = velocityDate;
    reason = 'velocity-adjusted day model';
  } else if (ticketDate) {
    model = 'ticket';
    date = ticketDate;
    reason = 'ticket model — no remaining estimated effort';
  } else if (plannedDate) {
    model = 'planned';
    date = plannedDate;
    reason = 'planned capacity only — no measured pace';
  } else {
    return { date: null, model: null, confidence: null, range, reason: 'No model could project a date.' };
  }

  const confidence: HeadlineConfidence =
    evidence.state === 'provisional' || evidence.state === 'stalled' || crossCheck === 'caution' || mostlyUnestimated
      ? 'low'
      : crossCheck === 'unmeasured' || model === 'planned'
        ? 'medium'
        : 'high';
  return { date, model, confidence, range, reason };
}
