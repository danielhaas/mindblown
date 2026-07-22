import type { Node as CoreNode, MindMap, Version } from '@mindblown/core';
import { clampFocusFactor, compareVersions } from '@mindblown/core';

/**
 * Release forecast row for a single version.
 *
 * All dates are ISO 8601 date strings (YYYY-MM-DD). The cumulative
 * chain uses two independent cursors — planned vs velocity-adjusted —
 * so the two timelines diverge cleanly as velocity drifts from estimate.
 */
export interface ReleaseForecastRow {
  versionId: string;
  versionName: string;
  versionStatus: Version['status'];
  sortOrder: number;
  targetDate: string | null;
  leaves: number;
  noEstimateLeaves: number;
  totalEffort: number;
  remainingEffort: number;
  effectiveStartDate: string | null;
  plannedFinishDate: string | null;
  velocityAdjustedFinishDate: string | null;
  slipPlannedDays: number | null;
  slipVelocityDays: number | null;
}

export interface ReleaseForecastResult {
  projectStartDate: string;
  effortUnit: string;
  dailyCapacity: number;
  fudgeFactor: number | null;
  focusFactor: number;
  calibrationLeafCount: number;
  releases: ReleaseForecastRow[];
}

/**
 * Pure computation of the release forecast for a map.
 *
 * Assumptions — distinct from the PERT/CPM scheduler:
 *   1. Capacity-constrained: plannedFinish = effStart +
 *      ceil(remainingEffort / dailyCapacity). Does NOT assume infinite
 *      parallelism.
 *   2. Sequential by release order (target date, undated last):
 *      non-shipped versions chain — each
 *      effective start is clamped to the previous release's finish.
 *   3. Wall-clock anchored: the first cursor starts at max(today,
 *      projectStartDate). If the project is already underway with
 *      incomplete work, the remaining effort projects forward from
 *      today, not from a frozen past start.
 *
 * Released/archived versions are included in the result for context
 * but do NOT advance the cumulative cursor — they represent shipped
 * work with no wall-clock cost on future releases.
 */
export function computeReleaseForecast(
  map: MindMap,
  nodes: CoreNode[],
  versions: Version[],
  now: Date = new Date(),
): ReleaseForecastResult {
  // ── Constants ──
  const MS_PER_DAY = 86_400_000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const addCalendarDays = (base: Date, days: number): Date => {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() + Math.ceil(days));
    return d;
  };
  const daysBetween = (a: Date, b: Date) =>
    Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);

  // ── Project start + wall-clock anchor ──
  // Frozen past start dates would cause the forecast to project into
  // the past on long-running maps — so we clamp the cursor forward to
  // today when projectStartDate is behind us.
  const projectStart = map.projectStartDate
    ? new Date(map.projectStartDate)
    : new Date(iso(now));
  projectStart.setUTCHours(0, 0, 0, 0);

  const today = new Date(iso(now));
  today.setUTCHours(0, 0, 0, 0);

  const anchor = today > projectStart ? today : projectStart;

  // dailyCapacity: effort units consumed per calendar day for one
  // full-time worker. Mirrors unitsPerDay from the schedule route.
  const dailyCapacity = map.effortUnit === 'hours' ? (map.hoursPerDay ?? 8) : 1;

  // ── Velocity fudge (all-time calibration) ──
  const calibrationLeaves = nodes.filter(
    (n) =>
      (n.childrenIds?.length ?? 0) === 0 &&
      n.effortEstimate != null &&
      n.actualEffort != null,
  );
  const calibEstimate = calibrationLeaves.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
  const calibActual = calibrationLeaves.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
  const fudgeFactor = calibEstimate > 0 ? calibActual / calibEstimate : null;
  const effectiveFudge = fudgeFactor ?? 1.0;

  // ── Focus factor (capacity leakage) ──
  // Discounts effective daily capacity on the velocity-adjusted line only:
  // if only `focusFactor` of each day reaches planned work, the same remaining
  // effort spans proportionally more calendar days.
  const focusFactor = clampFocusFactor(map.focusFactor);

  // ── Ancestor-inherited version tags ──
  // A leaf belongs to version V if itself or any ancestor is tagged V.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ancestorVersions = (leafId: string): Set<string> => {
    const tagged = new Set<string>();
    let cur: CoreNode | undefined = nodeById.get(leafId);
    while (cur) {
      if (cur.versionId) tagged.add(cur.versionId);
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return tagged;
  };
  const allLeaves = nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);

  // ── Walk versions in release order with two cursors ──
  // compareVersions (core) is the single ordering authority — target
  // date ascending, undated last, ties broken by sortOrder then semver.
  const sorted = [...versions].sort(compareVersions);
  let plannedCursor = anchor;
  let velocityCursor = anchor;

  const releases: ReleaseForecastRow[] = sorted.map((v) => {
    const scopedLeaves = allLeaves.filter((l) => ancestorVersions(l.id).has(v.id));

    let totalEffort = 0;
    let remainingEffort = 0;
    let noEstimateLeaves = 0;
    for (const leaf of scopedLeaves) {
      if (leaf.effortEstimate == null) noEstimateLeaves++;
      const est = leaf.effortEstimate ?? 0;
      const prog = leaf.percentComplete ?? 0;
      totalEffort += est;
      remainingEffort += est * (1 - prog / 100);
    }

    const isSequenced = v.status !== 'released' && v.status !== 'archived';
    let effectiveStartDate: string | null = null;
    let plannedFinishDate: string | null = null;
    let velocityAdjustedFinishDate: string | null = null;

    if (isSequenced && scopedLeaves.length > 0) {
      effectiveStartDate = iso(plannedCursor);

      const plannedCalDays = remainingEffort / dailyCapacity;
      const plannedFinish = addCalendarDays(plannedCursor, plannedCalDays);
      plannedFinishDate = iso(plannedFinish);
      plannedCursor = plannedFinish;

      const velCalDays = (remainingEffort * effectiveFudge) / (dailyCapacity * focusFactor);
      const velFinish = addCalendarDays(velocityCursor, velCalDays);
      velocityAdjustedFinishDate = iso(velFinish);
      velocityCursor = velFinish;
    }

    let slipPlannedDays: number | null = null;
    let slipVelocityDays: number | null = null;
    if (v.targetDate && plannedFinishDate) {
      slipPlannedDays = daysBetween(new Date(plannedFinishDate), new Date(v.targetDate));
    }
    if (v.targetDate && velocityAdjustedFinishDate) {
      slipVelocityDays = daysBetween(
        new Date(velocityAdjustedFinishDate),
        new Date(v.targetDate),
      );
    }

    return {
      versionId: v.id,
      versionName: v.name,
      versionStatus: v.status,
      sortOrder: v.sortOrder,
      targetDate: v.targetDate,
      leaves: scopedLeaves.length,
      noEstimateLeaves,
      totalEffort,
      remainingEffort,
      effectiveStartDate,
      plannedFinishDate,
      velocityAdjustedFinishDate,
      slipPlannedDays,
      slipVelocityDays,
    };
  });

  return {
    projectStartDate: iso(projectStart),
    effortUnit: map.effortUnit,
    dailyCapacity,
    fudgeFactor,
    focusFactor,
    calibrationLeafCount: calibrationLeaves.length,
    releases,
  };
}
