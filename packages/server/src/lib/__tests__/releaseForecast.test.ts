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

describe('computeReleaseForecast — measured rates', () => {
  it('measured net effort rate replaces the knob-based velocity line', () => {
    // focus 0.5 would say 20 cal days; the measured 0.5/day net rate says
    // 10 ÷ 0.5 = 20 too — use a distinct rate to prove measurement wins:
    // 1.25/day → 8 cal days → 2026-01-09.
    const result = computeReleaseForecast(makeMap(0.5), [root, leaf], [version], NOW, {
      netEffortPerDay: 1.25,
    });
    expect(result.releases[0].velocityAdjustedFinishDate).toBe('2026-01-09');
    expect(result.netEffortPerDay).toBe(1.25);
  });

  it('ticket model: open leaves ÷ net ticket rate, counting unestimated leaves', () => {
    const unestimated: CoreNode = {
      id: 'leaf-2',
      parentId: 'root',
      childrenIds: [],
      effortEstimate: null, // invisible to the day model...
      percentComplete: 0, // ...but an open ticket all the same
      versionId: 'v1',
    } as unknown as CoreNode;
    const root2 = { ...root, childrenIds: ['leaf-1', 'leaf-2'] } as CoreNode;
    const result = computeReleaseForecast(
      makeMap(1),
      [root2, leaf, unestimated],
      [version],
      NOW,
      { netTicketsPerDay: 0.5 },
    );
    const row = result.releases[0];
    expect(row.remainingTickets).toBe(2);
    // 2 tickets ÷ 0.5/day = 4 cal days → 2026-01-05.
    expect(row.ticketModelFinishDate).toBe('2026-01-05');
  });

  it('ticket model chains across sequential releases like the other cursors', () => {
    const leafB: CoreNode = {
      id: 'leaf-b',
      parentId: 'root',
      childrenIds: [],
      effortEstimate: 2,
      percentComplete: 0,
      versionId: 'v2',
    } as unknown as CoreNode;
    const root2 = { ...root, childrenIds: ['leaf-1', 'leaf-b'] } as CoreNode;
    const v2: Version = {
      id: 'v2',
      name: 'V2',
      status: 'planning',
      sortOrder: 1,
      targetDate: null,
    } as unknown as Version;
    const result = computeReleaseForecast(
      makeMap(1),
      [root2, leaf, leafB],
      [version, v2],
      NOW,
      { netTicketsPerDay: 1 },
    );
    // V1: 1 ticket ÷ 1/day → 01-02; V2 starts where V1's ticket cursor ended.
    expect(result.releases[0].ticketModelFinishDate).toBe('2026-01-02');
    expect(result.releases[1].ticketModelFinishDate).toBe('2026-01-03');
  });

  it('no rates → ticket date null, velocity falls back to knobs', () => {
    const result = computeReleaseForecast(makeMap(0.5), [root, leaf], [version], NOW);
    expect(result.releases[0].ticketModelFinishDate).toBeNull();
    expect(result.releases[0].remainingTickets).toBe(1);
    expect(result.releases[0].velocityAdjustedFinishDate).toBe('2026-01-21');
    expect(result.netTicketsPerDay).toBeNull();
  });
});

describe('computeReleaseForecast — effectiveStartDate rides the velocity cursor', () => {
  // The UI shows velocityAdjustedFinishDate under "Projected". If Start came
  // off the planned cursor instead, every row's Start would contradict the
  // row above it's Projected, and the gap would widen down the table.
  const leafB: CoreNode = {
    id: 'leaf-b',
    parentId: 'root',
    childrenIds: [],
    effortEstimate: 2,
    percentComplete: 0,
    versionId: 'v2',
  } as unknown as CoreNode;
  const root2 = { ...root, childrenIds: ['leaf-1', 'leaf-b'] } as CoreNode;
  const v2: Version = {
    id: 'v2',
    name: 'V2',
    status: 'planning',
    sortOrder: 1,
    targetDate: null,
  } as unknown as Version;

  it("chains each start onto the previous release's projected finish", () => {
    // focusFactor 0.5 pulls the two cursors apart: planned finishes V1 on
    // 01-11, velocity on 01-21. Only one of those may be V2's start.
    const result = computeReleaseForecast(makeMap(0.5), [root2, leaf, leafB], [version, v2], NOW);
    const [v1Row, v2Row] = result.releases;

    expect(v1Row.effectiveStartDate).toBe('2026-01-01'); // the anchor
    expect(v1Row.plannedFinishDate).toBe('2026-01-11');
    expect(v1Row.velocityAdjustedFinishDate).toBe('2026-01-21');

    expect(v2Row.effectiveStartDate).toBe(v1Row.velocityAdjustedFinishDate);
    expect(v2Row.effectiveStartDate).not.toBe(v1Row.plannedFinishDate);
    // 2 days ÷ (1 × 0.5) = 4 cal days on from 01-21.
    expect(v2Row.velocityAdjustedFinishDate).toBe('2026-01-25');
  });

  it('keeps the planned cursor independent of the shared start', () => {
    const result = computeReleaseForecast(makeMap(0.5), [root2, leaf, leafB], [version, v2], NOW);
    // V2's planned line still chains off V1's *planned* finish (01-11 + 2d),
    // so the two models stay independent second opinions.
    expect(result.releases[1].plannedFinishDate).toBe('2026-01-13');
  });
});
