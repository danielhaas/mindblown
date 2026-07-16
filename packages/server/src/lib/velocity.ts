import { clampFocusFactor } from '@mindblown/core';

/**
 * Empirical velocity / focus-factor measurement.
 *
 * Measures how much *planned scope* a map actually completes per calendar day
 * and expresses it as a **focus factor** — the fraction of nominal capacity
 * that reaches planned-ticket work (see `@mindblown/core` velocity helpers and
 * the completion forecast). This is the empirical counterpart to the manual
 * `focusFactor` knob: instead of the user guessing "half our time goes to
 * planned work", we read it off the history.
 *
 * ## Why this dodges the elapsed-vs-effort hazard
 *
 * We do NOT infer per-ticket duration from timestamps. Completion is measured
 * exactly like `burnup`: estimate-weighted `percentComplete` deltas — a leaf
 * estimated at 2 days going 0→100% contributes 2 *estimate-days* of completed
 * scope, regardless of how long it sat open. Timestamps are used ONLY to (a)
 * place a completion inside the window and (b) detect bulk writes. So the
 * numerator is in the same estimate-unit space as the forecast's remaining
 * scope, and calendar-elapsed never enters.
 *
 * ## Bulk-op noise
 *
 * A hygiene pass or sprint-close can flip dozens of leaves at once — those are
 * batch writes, not organic daily throughput, and would spike the rate. We
 * detect them structurally: progress events that share an exact `createdAt`
 * timestamp in groups larger than {@link BULK_TIMESTAMP_THRESHOLD} are treated
 * as one bulk action and excluded from the clean rate. Both raw and
 * bulk-excluded numbers are returned so the caller can be transparent.
 *
 * ## Consistency with the forecast
 *
 * `nominalCapacity = workerCount × unitsPerDay` — the planned-scope-per-day the
 * forecast assumes at focus 1.0. `measuredFocusFactor = deliveryRate ÷
 * nominalCapacity`. Because both the measurement and the forecast use the same
 * `workerCount`, the factor is self-consistent for the common single-track
 * (workerCount = 1) case. It reads scope in *estimates*, so it assumes the
 * estimation fudge is ≈1 (verified on the target map); a large fudge would mean
 * the factor also absorbs estimation bias, which the caller should note.
 */

/** Progress events sharing one exact timestamp beyond this count = one bulk write. */
export const BULK_TIMESTAMP_THRESHOLD = 5;

/** Minimum organic completion events before the measurement is trustworthy. */
export const MIN_SAMPLE_EVENTS = 3;

export interface VelocityProgressEvent {
  nodeId: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string; // ISO 8601
}

export interface VelocityInput {
  windowDays: number;
  unitsPerDay: number;
  workerCount: number;
  currentFocusFactor: number;
  /** Current estimate per leaf id — used to weight progress deltas (burnup's proxy). */
  estimateByNodeId: Map<string, number>;
  progressEvents: VelocityProgressEvent[];
}

export interface VelocityResult {
  windowDays: number;
  unitsPerDay: number;
  workerCount: number;
  nominalCapacity: number;
  currentFocusFactor: number;

  /** Organic (bulk-excluded) figures. */
  completionEvents: number;
  estCompleted: number;
  deliveryRate: number;
  measuredFocusFactor: number;
  activeDays: number;

  /** Bulk-inclusive figures, for transparency. */
  estCompletedRaw: number;
  deliveryRateRaw: number;
  measuredFocusFactorRaw: number;

  /** How much was set aside as batch writes. */
  bulkGroupsExcluded: number;
  bulkEventsExcluded: number;
  estCompletedExcludedAsBulk: number;

  /** False when there are too few organic completions to trust the number. */
  sampleSufficient: boolean;
}

export function computeVelocity(input: VelocityInput): VelocityResult {
  const {
    windowDays,
    unitsPerDay,
    workerCount,
    currentFocusFactor,
    estimateByNodeId,
    progressEvents,
  } = input;

  // Group by exact timestamp to spot bulk writes.
  const byTimestamp = new Map<string, VelocityProgressEvent[]>();
  for (const e of progressEvents) {
    const g = byTimestamp.get(e.createdAt);
    if (g) g.push(e);
    else byTimestamp.set(e.createdAt, [e]);
  }

  // Estimate-weighted completed scope from a single positive-progress event.
  const completedFor = (e: VelocityProgressEvent): number => {
    const oldProg = Number(e.oldValue ?? 0);
    const newProg = Number(e.newValue ?? 0);
    const delta = newProg - oldProg;
    if (!(delta > 0)) return 0; // only forward progress counts as completion
    const est = e.nodeId ? (estimateByNodeId.get(e.nodeId) ?? 0) : 0;
    return est * (delta / 100);
  };

  let estCompleted = 0;
  let estCompletedRaw = 0;
  let completionEvents = 0;
  let bulkGroupsExcluded = 0;
  let bulkEventsExcluded = 0;
  let estCompletedExcludedAsBulk = 0;
  const activeDaySet = new Set<string>();

  for (const [, group] of byTimestamp) {
    const isBulk = group.length > BULK_TIMESTAMP_THRESHOLD;
    for (const e of group) {
      const done = completedFor(e);
      estCompletedRaw += done;
      if (isBulk) {
        estCompletedExcludedAsBulk += done;
      } else if (done > 0) {
        estCompleted += done;
        completionEvents++;
        activeDaySet.add(e.createdAt.slice(0, 10));
      }
    }
    if (isBulk) {
      bulkGroupsExcluded++;
      bulkEventsExcluded += group.length;
    }
  }

  const safeWindow = Math.max(1, windowDays);
  const nominalCapacity = Math.max(1e-9, workerCount * unitsPerDay);
  const deliveryRate = estCompleted / safeWindow;
  const deliveryRateRaw = estCompletedRaw / safeWindow;

  return {
    windowDays,
    unitsPerDay,
    workerCount,
    nominalCapacity,
    currentFocusFactor: clampFocusFactor(currentFocusFactor),
    completionEvents,
    estCompleted,
    deliveryRate,
    measuredFocusFactor: clampFocusFactor(deliveryRate / nominalCapacity),
    activeDays: activeDaySet.size,
    estCompletedRaw,
    deliveryRateRaw,
    measuredFocusFactorRaw: clampFocusFactor(deliveryRateRaw / nominalCapacity),
    bulkGroupsExcluded,
    bulkEventsExcluded,
    estCompletedExcludedAsBulk,
    sampleSufficient: completionEvents >= MIN_SAMPLE_EVENTS && estCompleted > 0,
  };
}
