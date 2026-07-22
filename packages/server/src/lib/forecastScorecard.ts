/**
 * Forecast scorecard — grade both forecast models against reality.
 *
 * For every version that actually shipped (released_at set), walk its
 * snapshot history and score each snapshot's predicted finish dates
 * against the real ship date, bucketed by lead time (how far before the
 * ship date the prediction was made). Aggregates per model per bucket:
 *
 *   meanAbsErrorDays — how far off, regardless of direction
 *   biasDays         — signed mean (positive = model predicts too late)
 *
 * This closes the estimation loop empirically: after one or two shipped
 * releases the question "which model do we trust?" stops being an
 * opinion. Pure function over rows so it is trivially testable.
 */

export interface ScorecardSnapshotRow {
  versionId: string;
  snapshotDate: string; // YYYY-MM-DD
  velocityAdjustedFinishDate: string | null;
  ticketModelFinishDate: string | null;
  plannedFinishDate: string | null;
}

export interface ScorecardVersion {
  id: string;
  name: string;
  releasedAt: string; // ISO timestamp
}

export interface ModelBucketScore {
  samples: number;
  meanAbsErrorDays: number;
  biasDays: number;
}

export interface LeadTimeBucket {
  label: string;
  minLeadDays: number;
  maxLeadDays: number; // exclusive
  planned: ModelBucketScore | null;
  velocity: ModelBucketScore | null;
  ticket: ModelBucketScore | null;
}

export interface ForecastScorecard {
  versionsScored: Array<{ id: string; name: string; shippedOn: string; snapshots: number }>;
  buckets: LeadTimeBucket[];
  /** Model with the lowest overall mean abs error, when comparable. */
  verdict: string | null;
}

const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '0–7d out', min: 0, max: 8 },
  { label: '8–14d out', min: 8, max: 15 },
  { label: '15–30d out', min: 15, max: 31 },
  { label: '31–60d out', min: 31, max: 61 },
  { label: '>60d out', min: 61, max: 100_000 },
];

const MS_PER_DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / MS_PER_DAY);

export function computeForecastScorecard(
  versions: ScorecardVersion[],
  snapshots: ScorecardSnapshotRow[],
): ForecastScorecard {
  const shipped = versions.filter((v) => v.releasedAt);
  const byVersion = new Map<string, ScorecardSnapshotRow[]>();
  for (const s of snapshots) {
    const list = byVersion.get(s.versionId) ?? [];
    list.push(s);
    byVersion.set(s.versionId, list);
  }

  type Err = { abs: number; signed: number };
  const errs: Record<string, Err[][]> = {
    planned: BUCKETS.map(() => []),
    velocity: BUCKETS.map(() => []),
    ticket: BUCKETS.map(() => []),
  };

  const versionsScored: ForecastScorecard['versionsScored'] = [];

  for (const v of shipped) {
    const shipDate = v.releasedAt.slice(0, 10);
    const rows = byVersion.get(v.id) ?? [];
    let counted = 0;
    for (const row of rows) {
      // Lead time = how far before the ship date this prediction was made.
      // Snapshots taken after shipping grade nothing.
      const lead = daysBetween(shipDate, row.snapshotDate);
      if (lead < 0) continue;
      const bucketIdx = BUCKETS.findIndex((b) => lead >= b.min && lead < b.max);
      if (bucketIdx < 0) continue;
      counted++;
      const score = (predicted: string | null, model: keyof typeof errs) => {
        if (!predicted) return;
        const e = daysBetween(predicted, shipDate); // + = predicted too late
        errs[model][bucketIdx].push({ abs: Math.abs(e), signed: e });
      };
      score(row.plannedFinishDate, 'planned');
      score(row.velocityAdjustedFinishDate, 'velocity');
      score(row.ticketModelFinishDate, 'ticket');
    }
    if (counted > 0) {
      versionsScored.push({ id: v.id, name: v.name, shippedOn: shipDate, snapshots: counted });
    }
  }

  const agg = (list: Err[]): ModelBucketScore | null =>
    list.length === 0
      ? null
      : {
          samples: list.length,
          meanAbsErrorDays: list.reduce((s, e) => s + e.abs, 0) / list.length,
          biasDays: list.reduce((s, e) => s + e.signed, 0) / list.length,
        };

  const buckets: LeadTimeBucket[] = BUCKETS.map((b, i) => ({
    label: b.label,
    minLeadDays: b.min,
    maxLeadDays: b.max,
    planned: agg(errs.planned[i]),
    velocity: agg(errs.velocity[i]),
    ticket: agg(errs.ticket[i]),
  }));

  // Verdict: overall mean abs error per model — only across buckets where
  // BOTH the day-side models and the ticket model have samples, so a model
  // that only exists in easy buckets can't win by forfeit.
  const overall = (model: 'planned' | 'velocity' | 'ticket'): { n: number; mae: number } => {
    let n = 0;
    let sum = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      if (errs.velocity[i].length > 0 && errs.ticket[i].length > 0) {
        for (const e of errs[model][i]) {
          n++;
          sum += e.abs;
        }
      }
    }
    return { n, mae: n > 0 ? sum / n : Infinity };
  };
  let verdict: string | null = null;
  const vel = overall('velocity');
  const tick = overall('ticket');
  if (vel.n > 0 && tick.n > 0) {
    const better = tick.mae < vel.mae ? 'ticket model' : 'day (velocity) model';
    const worse = tick.mae < vel.mae ? vel : tick;
    const best = tick.mae < vel.mae ? tick : vel;
    verdict = `${better} wins: ${best.mae.toFixed(1)}d mean abs error vs ${worse.mae.toFixed(1)}d (${best.n + worse.n} comparable predictions)`;
  }

  return { versionsScored, buckets, verdict };
}
