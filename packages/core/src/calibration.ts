/**
 * Estimation-calibration evidence gate.
 *
 * The fudge factor (sum(actual) / sum(estimate) over completed leaves) is a
 * multiplier applied to every forecast on the map. Applied from a thin or
 * retrospectively bulk-entered sample it is not calibration — it is one
 * anecdote scaling a 900-day plan. This module decides whether the evidence
 * is strong enough to correct forecasts with, using the same bulk-write
 * heuristic as the velocity measurement: rows whose completion timestamps
 * are shared by many siblings were back-filled in one sitting, not recorded
 * as the work finished, so they carry no independent information.
 *
 * Gate result semantics:
 *   fudgeFactor  — null unless the ORGANIC sample clears both thresholds;
 *                  when set, it is computed from organic samples only.
 *   rawFudge     — the naive all-samples ratio, for transparent reporting
 *                  (get_estimation_accuracy still shows what the data says).
 *   note         — human-readable reason when the gate withholds the factor.
 */

/** Minimum organic samples before the fudge factor is applied to forecasts. */
export const MIN_CALIBRATION_LEAVES = 20;
/** Minimum summed estimate-days in the organic sample. */
export const MIN_CALIBRATION_DAYS = 15;
/** Samples sharing one exact completion timestamp beyond this = bulk entry. */
export const CALIBRATION_BULK_THRESHOLD = 5;

export interface CalibrationSample {
  effortEstimate: number;
  actualEffort: number;
  /** ISO timestamp; missing/null counts as organic (bulk entry unprovable). */
  completedAt?: string | null;
}

export interface CalibrationAssessment {
  /** Gated factor — null means "insufficient evidence, apply 1.0". */
  fudgeFactor: number | null;
  /** Naive all-samples ratio, or null when there are no samples at all. */
  rawFudge: number | null;
  sampleCount: number;
  organicCount: number;
  bulkCount: number;
  /** Summed estimate over organic samples. */
  organicDays: number;
  /** Set when fudgeFactor is null but samples exist — why the gate held. */
  note: string | null;
}

export function assessCalibration(samples: CalibrationSample[]): CalibrationAssessment {
  const total = samples.reduce(
    (acc, s) => {
      acc.est += s.effortEstimate;
      acc.act += s.actualEffort;
      return acc;
    },
    { est: 0, act: 0 },
  );
  const rawFudge = total.est > 0 ? total.act / total.est : null;

  // Bulk detection: exact-timestamp groups above the threshold.
  const byTimestamp = new Map<string, number>();
  for (const s of samples) {
    if (s.completedAt) byTimestamp.set(s.completedAt, (byTimestamp.get(s.completedAt) ?? 0) + 1);
  }
  const bulkTimestamps = new Set(
    [...byTimestamp.entries()]
      .filter(([, n]) => n >= CALIBRATION_BULK_THRESHOLD)
      .map(([ts]) => ts),
  );
  const organic = samples.filter((s) => !s.completedAt || !bulkTimestamps.has(s.completedAt));
  const organicDays = organic.reduce((s, x) => s + x.effortEstimate, 0);
  const organicActual = organic.reduce((s, x) => s + x.actualEffort, 0);

  const qualified =
    organic.length >= MIN_CALIBRATION_LEAVES && organicDays >= MIN_CALIBRATION_DAYS;

  let note: string | null = null;
  if (!qualified && samples.length > 0) {
    const parts = [
      `${organic.length}/${MIN_CALIBRATION_LEAVES} organic samples`,
      `${organicDays.toFixed(1)}/${MIN_CALIBRATION_DAYS} estimate-days`,
    ];
    if (samples.length - organic.length > 0) {
      parts.push(`${samples.length - organic.length} bulk-entered excluded`);
    }
    note = `calibration below evidence threshold (${parts.join(', ')}) — forecasts apply 1.0`;
  }

  return {
    fudgeFactor: qualified && organicDays > 0 ? organicActual / organicDays : null,
    rawFudge,
    sampleCount: samples.length,
    organicCount: organic.length,
    bulkCount: samples.length - organic.length,
    organicDays,
    note,
  };
}

/**
 * Convenience for the four call sites: pull calibration samples out of a
 * node list (completed leaves carrying both estimate and actual).
 */
export function calibrationSamplesFromNodes(
  nodes: Array<{
    childrenIds?: string[] | null;
    effortEstimate?: number | null;
    actualEffort?: number | null;
    completedAt?: string | null;
  }>,
): CalibrationSample[] {
  return nodes
    .filter(
      (n) =>
        (n.childrenIds?.length ?? 0) === 0 &&
        n.effortEstimate != null &&
        n.actualEffort != null,
    )
    .map((n) => ({
      effortEstimate: n.effortEstimate as number,
      actualEffort: n.actualEffort as number,
      completedAt: n.completedAt ?? null,
    }));
}
