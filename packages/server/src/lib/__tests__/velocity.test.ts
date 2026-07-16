import { describe, it, expect } from 'vitest';
import { computeVelocity, BULK_TIMESTAMP_THRESHOLD } from '../velocity.js';

// Three leaves, each estimated 2 days.
const estimates = new Map<string, number>([
  ['a', 2],
  ['b', 2],
  ['c', 2],
]);

function progress(nodeId: string, from: number, to: number, createdAt: string) {
  return { nodeId, oldValue: from, newValue: to, createdAt };
}

describe('computeVelocity', () => {
  it('rate = estimate-weighted completion ÷ calendar window, focus = rate ÷ capacity', () => {
    // Three leaves fully completed on distinct days → 6 estimate-days.
    const result = computeVelocity({
      windowDays: 12,
      unitsPerDay: 1,
      workerCount: 1,
      currentFocusFactor: 1,
      estimateByNodeId: estimates,
      progressEvents: [
        progress('a', 0, 100, '2026-07-01T09:00:00.000Z'),
        progress('b', 0, 100, '2026-07-03T09:00:00.000Z'),
        progress('c', 0, 100, '2026-07-05T09:00:00.000Z'),
      ],
    });
    expect(result.estCompleted).toBe(6);
    expect(result.completionEvents).toBe(3);
    expect(result.activeDays).toBe(3);
    expect(result.deliveryRate).toBeCloseTo(0.5, 6); // 6 / 12
    expect(result.measuredFocusFactor).toBeCloseTo(0.5, 6); // 0.5 / (1×1)
    expect(result.sampleSufficient).toBe(true);
  });

  it('counts only forward progress and weights partial deltas', () => {
    const result = computeVelocity({
      windowDays: 10,
      unitsPerDay: 1,
      workerCount: 1,
      currentFocusFactor: 1,
      estimateByNodeId: estimates,
      progressEvents: [
        progress('a', 0, 50, '2026-07-01T09:00:00.000Z'), // +50% of 2 = 1
        progress('a', 50, 20, '2026-07-02T09:00:00.000Z'), // backward → ignored
        progress('b', 0, 100, '2026-07-03T09:00:00.000Z'), // +2
      ],
    });
    expect(result.estCompleted).toBe(3);
    expect(result.completionEvents).toBe(2);
  });

  it('excludes bulk writes that share an exact timestamp', () => {
    const ts = '2026-07-10T06:14:52.000Z';
    const bulk = Array.from({ length: BULK_TIMESTAMP_THRESHOLD + 1 }, (_, i) =>
      progress(`bulk-${i}`, 0, 100, ts),
    );
    // Give the bulk nodes estimates too so raw ≠ 0.
    const est = new Map(estimates);
    bulk.forEach((e) => est.set(e.nodeId!, 2));

    const result = computeVelocity({
      windowDays: 10,
      unitsPerDay: 1,
      workerCount: 1,
      currentFocusFactor: 1,
      estimateByNodeId: est,
      progressEvents: [
        progress('a', 0, 100, '2026-07-01T09:00:00.000Z'), // organic +2
        ...bulk, // one batch write → excluded
      ],
    });
    expect(result.bulkGroupsExcluded).toBe(1);
    expect(result.bulkEventsExcluded).toBe(BULK_TIMESTAMP_THRESHOLD + 1);
    expect(result.estCompleted).toBe(2); // only the organic one
    expect(result.completionEvents).toBe(1);
    expect(result.estCompletedRaw).toBeGreaterThan(result.estCompleted);
    expect(result.estCompletedExcludedAsBulk).toBe((BULK_TIMESTAMP_THRESHOLD + 1) * 2);
  });

  it('flags an insufficient sample and never divides by zero capacity', () => {
    const result = computeVelocity({
      windowDays: 56,
      unitsPerDay: 1,
      workerCount: 1,
      currentFocusFactor: 1,
      estimateByNodeId: estimates,
      progressEvents: [progress('a', 0, 100, '2026-07-01T09:00:00.000Z')],
    });
    expect(result.completionEvents).toBe(1);
    expect(result.sampleSufficient).toBe(false);
    expect(Number.isFinite(result.measuredFocusFactor)).toBe(true);
  });

  it('scales focus by nominal capacity (workerCount × unitsPerDay)', () => {
    // Same 6 days completed, but 2 workers → half the focus.
    const result = computeVelocity({
      windowDays: 12,
      unitsPerDay: 1,
      workerCount: 2,
      currentFocusFactor: 1,
      estimateByNodeId: estimates,
      progressEvents: [
        progress('a', 0, 100, '2026-07-01T09:00:00.000Z'),
        progress('b', 0, 100, '2026-07-03T09:00:00.000Z'),
        progress('c', 0, 100, '2026-07-05T09:00:00.000Z'),
      ],
    });
    expect(result.nominalCapacity).toBe(2);
    expect(result.measuredFocusFactor).toBeCloseTo(0.25, 6); // 0.5 / 2
  });
});
