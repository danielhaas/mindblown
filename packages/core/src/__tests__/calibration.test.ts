import { describe, it, expect } from 'vitest';
import {
  assessCalibration,
  calibrationSamplesFromNodes,
  MIN_CALIBRATION_LEAVES,
  CALIBRATION_BULK_THRESHOLD,
} from '../calibration.js';

const sample = (est: number, act: number, completedAt: string | null = null) => ({
  effortEstimate: est,
  actualEffort: act,
  completedAt,
});

/** n organic samples, distinct timestamps, est=1 act=ratio each. */
const organic = (n: number, ratio = 1.2) =>
  Array.from({ length: n }, (_, i) => sample(1, ratio, `2026-07-${String((i % 28) + 1).padStart(2, '0')}T0${i % 10}:0${i % 6}:00Z`));

describe('assessCalibration', () => {
  it('withholds the factor on a thin sample', () => {
    const r = assessCalibration(organic(5));
    expect(r.fudgeFactor).toBeNull();
    expect(r.rawFudge).toBeCloseTo(1.2);
    expect(r.note).toContain('below evidence threshold');
  });

  it('applies the factor once both thresholds clear', () => {
    // 20 samples × 1 day = 20 days ≥ 15; ratio 1.3 throughout.
    const r = assessCalibration(organic(MIN_CALIBRATION_LEAVES, 1.3));
    expect(r.fudgeFactor).toBeCloseTo(1.3);
    expect(r.note).toBeNull();
  });

  it('count alone is not enough — estimate-days threshold also gates', () => {
    // 25 tiny samples of 0.1d = 2.5 estimate-days < 15.
    const r = assessCalibration(
      Array.from({ length: 25 }, (_, i) => sample(0.1, 0.2, `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:0${i % 6}:00Z`)),
    );
    expect(r.fudgeFactor).toBeNull();
  });

  it('excludes bulk-entered samples — the retrospective-backfill case', () => {
    // 22 samples sharing ONE timestamp (a bulk write) + 3 organic.
    const bulk = Array.from({ length: 22 }, () => sample(1, 2, '2026-06-25T10:00:00Z'));
    const r = assessCalibration([...bulk, ...organic(3)]);
    expect(r.bulkCount).toBe(22);
    expect(r.organicCount).toBe(3);
    expect(r.fudgeFactor).toBeNull(); // 3 organic < 20
    expect(r.note).toContain('22 bulk-entered excluded');
  });

  it(`groups below the bulk threshold (${CALIBRATION_BULK_THRESHOLD}) stay organic`, () => {
    // 4 samples share a timestamp — under threshold, still organic.
    const r = assessCalibration(Array.from({ length: 4 }, () => sample(1, 1, '2026-06-25T10:00:00Z')));
    expect(r.bulkCount).toBe(0);
    expect(r.organicCount).toBe(4);
  });

  it('missing completedAt counts as organic (bulk entry unprovable)', () => {
    const r = assessCalibration(Array.from({ length: 21 }, () => sample(1, 1.1, null)));
    expect(r.fudgeFactor).toBeCloseTo(1.1);
  });

  it('computes the gated factor from organic samples only', () => {
    // Organic ratio 1.0; a bulk block at ratio 3.0 must not contaminate it.
    const bulk = Array.from({ length: 10 }, () => sample(1, 3, '2026-06-25T10:00:00Z'));
    const r = assessCalibration([...organic(20, 1.0), ...bulk]);
    expect(r.fudgeFactor).toBeCloseTo(1.0);
    expect(r.rawFudge).toBeGreaterThan(1.5); // raw still shows the naive blend
  });

  it('empty input → all null, no note', () => {
    const r = assessCalibration([]);
    expect(r.fudgeFactor).toBeNull();
    expect(r.rawFudge).toBeNull();
    expect(r.note).toBeNull();
  });

  it('regression: the real Fulcrum sample (10 leaves, 8 bulk) is rejected', () => {
    // Mirrors the map that motivated the gate: 5.75 est / 7.25 act,
    // 8 of 10 rows sharing one retrospective timestamp.
    const rows = [
      sample(0.5, 0.5, '2026-05-10T09:00:00Z'),
      sample(0.5, 0.5, '2026-05-10T09:30:00Z'),
      ...Array.from({ length: 8 }, () => sample(0.59, 0.78, '2026-06-25T12:00:00Z')),
    ];
    const r = assessCalibration(rows);
    expect(r.fudgeFactor).toBeNull();
    expect(r.rawFudge).toBeGreaterThan(1.1); // the seductive 1.26-ish number
  });
});

describe('calibrationSamplesFromNodes', () => {
  it('takes only completed leaves with both estimate and actual', () => {
    const nodes = [
      { childrenIds: [], effortEstimate: 1, actualEffort: 2, completedAt: 'ts' },
      { childrenIds: ['x'], effortEstimate: 1, actualEffort: 2 }, // parent
      { childrenIds: [], effortEstimate: 1, actualEffort: null }, // no actual
      { childrenIds: [], effortEstimate: null, actualEffort: 2 }, // no estimate
    ];
    expect(calibrationSamplesFromNodes(nodes)).toEqual([
      { effortEstimate: 1, actualEffort: 2, completedAt: 'ts' },
    ]);
  });
});
