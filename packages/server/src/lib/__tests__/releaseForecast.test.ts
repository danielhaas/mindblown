import { describe, it, expect } from 'vitest';
import type { MindMap, Node as CoreNode, Version } from '@mindblown/core';
import { computeReleaseForecast } from '../releaseForecast.js';

// ── Minimal fixtures ──
// A map anchored at a fixed start with one active version holding a single
// open 10-day leaf and no calibration data (so the estimation fudge is 1.0 and
// the focus factor is the only thing moving the velocity line).
const NOW = new Date('2026-01-01T00:00:00Z');

function makeMap(focusFactor: number): MindMap {
  return {
    effortUnit: 'days',
    projectStartDate: '2026-01-01',
    hoursPerDay: 8,
    workerCount: 1,
    focusFactor,
  } as unknown as MindMap;
}

const leaf: CoreNode = {
  id: 'leaf-1',
  parentId: 'root',
  childrenIds: [],
  effortEstimate: 10,
  actualEffort: null,
  percentComplete: 0,
  versionId: 'v1',
} as unknown as CoreNode;

const root: CoreNode = {
  id: 'root',
  parentId: null,
  childrenIds: ['leaf-1'],
} as unknown as CoreNode;

const version: Version = {
  id: 'v1',
  name: 'V1',
  status: 'active',
  sortOrder: 0,
  targetDate: null,
} as unknown as Version;

describe('computeReleaseForecast — focusFactor', () => {
  it('leaves the velocity line equal to planned at focusFactor 1.0', () => {
    const result = computeReleaseForecast(makeMap(1), [root, leaf], [version], NOW);
    expect(result.focusFactor).toBe(1);
    const row = result.releases[0];
    // 10 remaining days, capacity 1/day → 2026-01-11 for both.
    expect(row.plannedFinishDate).toBe('2026-01-11');
    expect(row.velocityAdjustedFinishDate).toBe('2026-01-11');
  });

  it('doubles the remaining velocity horizon at focusFactor 0.5', () => {
    const result = computeReleaseForecast(makeMap(0.5), [root, leaf], [version], NOW);
    expect(result.focusFactor).toBe(0.5);
    const row = result.releases[0];
    // Planned stays the idealised baseline...
    expect(row.plannedFinishDate).toBe('2026-01-11');
    // ...but only half of each day reaches planned work → 20 cal days.
    expect(row.velocityAdjustedFinishDate).toBe('2026-01-21');
  });

  it('clamps an out-of-range focusFactor into the sane band', () => {
    const result = computeReleaseForecast(makeMap(5), [root, leaf], [version], NOW);
    // 5 → clamped to 1.0, so velocity == planned.
    expect(result.focusFactor).toBe(1);
    expect(result.releases[0].velocityAdjustedFinishDate).toBe('2026-01-11');
  });
});
