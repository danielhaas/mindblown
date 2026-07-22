import { describe, it, expect } from 'vitest';
import { computeForecastScorecard } from '../forecastScorecard.js';

const v1 = { id: 'v1', name: 'V1', releasedAt: '2026-03-01T10:00:00Z' };

function snap(
  snapshotDate: string,
  velocity: string | null,
  ticket: string | null,
  planned: string | null = null,
  versionId = 'v1',
) {
  return {
    versionId,
    snapshotDate,
    plannedFinishDate: planned,
    velocityAdjustedFinishDate: velocity,
    ticketModelFinishDate: ticket,
  };
}

describe('computeForecastScorecard', () => {
  it('empty history → nothing scored, no verdict', () => {
    const sc = computeForecastScorecard([], []);
    expect(sc.versionsScored).toEqual([]);
    expect(sc.verdict).toBeNull();
  });

  it('scores signed error per model, bucketed by lead time', () => {
    // Shipped 03-01. One snapshot 20 days out (15–30d bucket):
    // velocity predicted 03-06 (+5 late), ticket predicted 02-27 (−2 early).
    const sc = computeForecastScorecard([v1], [snap('2026-02-09', '2026-03-06', '2026-02-27')]);
    const bucket = sc.buckets.find((b) => b.label === '15–30d out')!;
    expect(bucket.velocity).toEqual({ samples: 1, meanAbsErrorDays: 5, biasDays: 5 });
    expect(bucket.ticket).toEqual({ samples: 1, meanAbsErrorDays: 2, biasDays: -2 });
    expect(sc.versionsScored).toEqual([
      { id: 'v1', name: 'V1', shippedOn: '2026-03-01', snapshots: 1 },
    ]);
  });

  it('snapshots taken after shipping grade nothing', () => {
    const sc = computeForecastScorecard([v1], [snap('2026-03-05', '2026-03-06', '2026-03-06')]);
    expect(sc.versionsScored).toEqual([]);
  });

  it('verdict names the model with lower mean abs error on comparable buckets', () => {
    const sc = computeForecastScorecard(
      [v1],
      [
        snap('2026-02-24', '2026-03-11', '2026-03-02'), // 5d out: vel +10, ticket +1
        snap('2026-02-25', '2026-03-09', '2026-03-03'), // 4d out: vel +8,  ticket +2
      ],
    );
    expect(sc.verdict).toContain('ticket model wins');
  });

  it('a model present only where the other is absent cannot win by forfeit', () => {
    // Velocity has samples only in a bucket where ticket has none → no
    // comparable buckets → no verdict.
    const sc = computeForecastScorecard(
      [v1],
      [snap('2026-02-24', '2026-03-02', null)],
    );
    expect(sc.verdict).toBeNull();
  });

  it('unreleased versions are ignored even with snapshots', () => {
    const sc = computeForecastScorecard(
      [{ id: 'v2', name: 'V2', releasedAt: '' }],
      [snap('2026-02-24', '2026-03-02', '2026-03-02', null, 'v2')],
    );
    expect(sc.versionsScored).toEqual([]);
  });
});
