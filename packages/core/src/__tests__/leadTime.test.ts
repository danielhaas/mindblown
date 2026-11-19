/**
 * Lead time (#654): a leaf that waits on someone outside the team. It takes
 * no worker slot, counts toward no roll-up, and holds everything after it.
 */
import { describe, it, expect } from 'vitest';
import { schedule, capacityCriticalPath, criticalPath, latestAskDates, type ScheduleConstraint } from '../dependencies.js';
import { computeEffort, computeProgress } from '../compute.js';
import { isLeadTimeNode, type Node, type ScheduledNode } from '../types.js';

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    mapId: 'map-1',
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
    x: null,
    y: null,
    collapsed: false,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    blockedReason: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    customFields: {},
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    attachments: [],
    autoProgress: 'off',
    priorityRank: null,
    completedAt: null,
    startedAt: null,
    expectedDoneAt: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    verificationVideoPosterUrl: null,
    approval: null,
    reportedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    ...overrides,
  } as Node;
}

const fs = (targetNodeId: string) => ({ targetNodeId, type: 'FS' as const, lag: 0 });

interface PlanOpts {
  workers?: number;
  today?: number;
  constraints?: Map<string, ScheduleConstraint>;
  completedAt?: Map<string, number>;
}

/** Leaves under one root; createdAt order decides queue order among equals. */
function plan(leaves: Array<Partial<Node> & { id: string }>, opts: PlanOpts = {}) {
  const kids = leaves.map((l, i) => makeNode({ parentId: 'root', createdAt: `2026-01-0${i + 1}T00:00:00Z`, ...l }));
  const nodes = [makeNode({ id: 'root', childrenIds: kids.map((k) => k.id) }), ...kids];
  const tracks = new Map<string, number>();
  const scheduled = schedule(nodes, 0, opts.constraints, undefined, opts.workers ?? 1, opts.today ?? 0, opts.completedAt, tracks);
  const byId = new Map<string, ScheduledNode>(scheduled.map((s) => [s.nodeId, s]));
  return { nodes, scheduled, tracks, byId, cp: capacityCriticalPath(nodes, scheduled, tracks) };
}

describe('lead time (#654)', () => {
  it('a wait in a chain A → wait → B holds B until the wait is over', () => {
    const { byId, tracks } = plan([
      { id: 'A', effortEstimate: 2 },
      { id: 'W', leadTime: 5, dependencies: [fs('A')] },
      { id: 'B', effortEstimate: 1, dependencies: [fs('W')] },
    ]);
    expect(byId.get('W')).toMatchObject({ computedStart: 2, computedEnd: 7, duration: 5, waiting: true });
    expect(byId.get('B')).toMatchObject({ computedStart: 7, computedEnd: 8 });
    expect(byId.get('root')!.computedEnd).toBe(8);
    expect(tracks.has('W')).toBe(false);
  });

  it('a wait takes no worker: other work runs on the single worker meanwhile', () => {
    // B (P0) waits on W; C is independent and lower priority — it still
    // fills the worker's idle days during the wait instead of queueing after B.
    const { byId } = plan([
      { id: 'W', leadTime: 5 },
      { id: 'B', effortEstimate: 1, priority: 'P0', dependencies: [fs('W')] },
      { id: 'C', effortEstimate: 3, priority: 'P2' },
    ]);
    expect(byId.get('W')).toMatchObject({ computedStart: 0, computedEnd: 5 });
    expect(byId.get('C')).toMatchObject({ computedStart: 0, computedEnd: 3 });
    expect(byId.get('B')).toMatchObject({ computedStart: 5, computedEnd: 6 });
  });

  it('an estimate on a wait does not make it worker effort', () => {
    const { byId, tracks } = plan([
      { id: 'W', leadTime: 4, effortEstimate: 10 },
      { id: 'C', effortEstimate: 2 },
    ]);
    expect(byId.get('W')).toMatchObject({ computedStart: 0, computedEnd: 4 });
    expect(byId.get('C')).toMatchObject({ computedStart: 0, computedEnd: 2 });
    expect(tracks.has('W')).toBe(false);
  });

  it('requestedAt in the past: the days already waited come off', () => {
    const asked = new Map([['W', { requestedAt: -3 }]]);
    const { byId } = plan(
      [
        { id: 'W', leadTime: 5, requestedAt: '2025-12-29' },
        { id: 'B', effortEstimate: 1, dependencies: [fs('W')] },
      ],
      { constraints: asked },
    );
    expect(byId.get('W')).toMatchObject({ computedStart: -3, computedEnd: 2 });
    expect(byId.get('B')!.computedStart).toBe(2);
  });

  it('an overdue wait that is still open ends no earlier than today', () => {
    const { byId } = plan(
      [
        { id: 'W', leadTime: 5, requestedAt: '2025-12-20' },
        { id: 'B', effortEstimate: 1, dependencies: [fs('W')] },
      ],
      { constraints: new Map([['W', { requestedAt: -12 }]]), today: 1 },
    );
    expect(byId.get('W')!.computedEnd).toBe(1);
    expect(byId.get('B')!.computedStart).toBe(1);
  });

  it('requestedAt does not start the clock before the wait\'s own dependencies', () => {
    const { byId } = plan(
      [
        { id: 'A', effortEstimate: 4 },
        { id: 'W', leadTime: 3, dependencies: [fs('A')] },
      ],
      { constraints: new Map([['W', { requestedAt: 1 }]]) },
    );
    expect(byId.get('W')).toMatchObject({ computedStart: 4, computedEnd: 7 });
  });

  it('a done wait ends at its real date', () => {
    const { byId, cp } = plan(
      [
        { id: 'W', leadTime: 5, percentComplete: 100 },
        { id: 'B', effortEstimate: 1, dependencies: [fs('W')] },
      ],
      { completedAt: new Map([['W', 3]]), today: 3 },
    );
    expect(byId.get('W')).toMatchObject({ computedStart: -2, computedEnd: 3, waiting: true });
    expect(byId.get('B')!.computedStart).toBe(3);
    expect(cp.path).toEqual(['B']);
  });

  it('a wait can be on the critical path', () => {
    const { cp } = plan([
      { id: 'A', effortEstimate: 2 },
      { id: 'W', leadTime: 5, dependencies: [fs('A')] },
      { id: 'B', effortEstimate: 1, dependencies: [fs('W')] },
      { id: 'C', effortEstimate: 1 },
    ]);
    expect(cp.path).toEqual(['A', 'W', 'B']);
    expect(cp.totalDuration).toBe(8);
    expect(cp.float.W).toBe(0);
    expect(cp.float.C).toBe(5);
  });

  it('the dependency-only CPM counts the wait as its duration', () => {
    const nodes = [
      makeNode({ id: 'A', effortEstimate: 2 }),
      makeNode({ id: 'W', leadTime: 5, dependencies: [fs('A')] }),
    ];
    expect(criticalPath(nodes).totalDuration).toBe(7);
  });

  it('a wait counts toward neither effort nor progress roll-ups', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['A', 'W'] }),
      makeNode({ id: 'A', parentId: 'root', effortEstimate: 4, percentComplete: 50 }),
      makeNode({ id: 'W', parentId: 'root', leadTime: 10, effortEstimate: 6 }),
    ];
    const map = new Map(nodes.map((n) => [n.id, n]));
    expect(computeEffort(map.get('root')!, map)).toBe(4);
    expect(computeProgress(map.get('root')!, map)).toBe(50);
  });

  it('only leaves wait', () => {
    expect(isLeadTimeNode({ childrenIds: [], leadTime: 2 })).toBe(true);
    expect(isLeadTimeNode({ childrenIds: ['x'], leadTime: 2 })).toBe(false);
    expect(isLeadTimeNode({ childrenIds: [], leadTime: 0 })).toBe(false);
    expect(isLeadTimeNode({ childrenIds: [] })).toBe(false);
  });

  it('latestAskDates: when an unrequested wait must be asked for', () => {
    const { nodes, scheduled } = plan([
      { id: 'A', effortEstimate: 6 },
      { id: 'W', leadTime: 2 },
      { id: 'B', effortEstimate: 1, dependencies: [fs('A'), fs('W')] },
      { id: 'X', leadTime: 3, requestedAt: '2026-01-01' },
    ]);
    // B starts on day 6 (after A); W takes 2 → ask by day 4. X is requested.
    expect(latestAskDates(nodes, scheduled)).toEqual([{ nodeId: 'W', latestStart: 4 }]);
  });
});
