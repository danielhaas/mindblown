import { describe, it, expect } from 'vitest';
import {
  hasCycle,
  topologicalSort,
  schedule,
  criticalPath,
} from '../dependencies.js';
import type { Node, NodeMap } from '../types.js';

// ── Test helpers ────────────────────────────────────────────────

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
    autoProgress: 'off',
    priorityRank: null,
    completedAt: null,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    // Orchestration substrate (#111)
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

function toMap(nodes: Node[]): NodeMap {
  const map: NodeMap = new Map();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

// ── Example from the data model doc ─────────────────────────────
//
//   Design (3d) --FS--> Frontend (8d) --FS--> Integration Testing (3d) --FS--> Launch (milestone)
//   Design (3d) --FS--> Backend (7d)  --FS--> Integration Testing (3d) --FS--> Launch (milestone)
//
// Critical path: Design -> Backend -> Integration Testing -> Launch = 3 + 7 + 3 = 13 days
// (Frontend has float: 3 + 8 = 11 < 3 + 7 + 3 = 13, so 2 days float)

function buildScheduleExample() {
  const design = makeNode({
    id: 'design',
    effortEstimate: 3,
  });
  const frontend = makeNode({
    id: 'frontend',
    effortEstimate: 8,
    dependencies: [{ targetNodeId: 'design', type: 'FS', lag: 0 }],
  });
  const backend = makeNode({
    id: 'backend',
    effortEstimate: 7,
    dependencies: [{ targetNodeId: 'design', type: 'FS', lag: 0 }],
  });
  const integration = makeNode({
    id: 'integration',
    effortEstimate: 3,
    dependencies: [
      { targetNodeId: 'frontend', type: 'FS', lag: 0 },
      { targetNodeId: 'backend', type: 'FS', lag: 0 },
    ],
  });
  const launch = makeNode({
    id: 'launch',
    effortEstimate: 0,
    dependencies: [{ targetNodeId: 'integration', type: 'FS', lag: 0 }],
  });

  return {
    design,
    frontend,
    backend,
    integration,
    launch,
    allNodes: [design, frontend, backend, integration, launch],
  };
}

// ── Cycle detection ─────────────────────────────────────────────

describe('hasCycle', () => {
  it('returns false when no cycle exists', () => {
    const a = makeNode({ id: 'a' });
    const b = makeNode({
      id: 'b',
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }],
    });
    const nm = toMap([a, b]);

    // Would adding "c depends on b" create a cycle? No.
    const c = makeNode({ id: 'c' });
    nm.set('c', c);
    expect(hasCycle('c', 'b', nm)).toBe(false);
  });

  it('detects a direct cycle', () => {
    // A depends on B. Would adding "B depends on A" create a cycle?
    const a = makeNode({
      id: 'a',
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({ id: 'b' });
    const nm = toMap([a, b]);

    expect(hasCycle('b', 'a', nm)).toBe(true);
  });

  it('detects an indirect cycle', () => {
    // A -> B -> C (A depends on B, B depends on C)
    // Would adding "C depends on A" create a cycle? Yes.
    const a = makeNode({
      id: 'a',
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({
      id: 'b',
      dependencies: [{ targetNodeId: 'c', type: 'FS', lag: 0 }],
    });
    const c = makeNode({ id: 'c' });
    const nm = toMap([a, b, c]);

    expect(hasCycle('c', 'a', nm)).toBe(true);
  });

  it('returns false for unrelated nodes', () => {
    const a = makeNode({ id: 'a' });
    const b = makeNode({ id: 'b' });
    const nm = toMap([a, b]);

    expect(hasCycle('a', 'b', nm)).toBe(false);
    expect(hasCycle('b', 'a', nm)).toBe(false);
  });
});

// ── Topological sort ────────────────────────────────────────────

describe('topologicalSort', () => {
  it('sorts nodes in dependency order', () => {
    const { allNodes } = buildScheduleExample();
    const sorted = topologicalSort(allNodes);
    const ids = sorted.map((n) => n.id);

    // Design must come before frontend and backend
    expect(ids.indexOf('design')).toBeLessThan(ids.indexOf('frontend'));
    expect(ids.indexOf('design')).toBeLessThan(ids.indexOf('backend'));
    // Frontend and backend must come before integration
    expect(ids.indexOf('frontend')).toBeLessThan(ids.indexOf('integration'));
    expect(ids.indexOf('backend')).toBeLessThan(ids.indexOf('integration'));
    // Integration must come before launch
    expect(ids.indexOf('integration')).toBeLessThan(ids.indexOf('launch'));
  });

  it('handles nodes with no dependencies', () => {
    const a = makeNode({ id: 'a' });
    const b = makeNode({ id: 'b' });
    const sorted = topologicalSort([a, b]);
    expect(sorted).toHaveLength(2);
  });

  it('throws on cycle', () => {
    const a = makeNode({
      id: 'a',
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({
      id: 'b',
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }],
    });
    expect(() => topologicalSort([a, b])).toThrow(/[Cc]ycle/);
  });
});

// ── Scheduling (forward pass — single-worker, priority-driven) ─────

describe('schedule — pins and dep constraints', () => {
  it('honours a minStart pin that pushes the node forward', () => {
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const constraints = new Map([['a', { minStart: 5 }]]);
    const result = schedule([a], 0, constraints);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(5);
    expect(byId.get('a')!.computedEnd).toBe(8);
  });

  it('propagates a pinned start through FS successors', () => {
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 2,
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }],
    });
    const constraints = new Map([['a', { minStart: 5 }]]);
    const result = schedule([a, b], 0, constraints);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(5);
    expect(byId.get('a')!.computedEnd).toBe(8);
    expect(byId.get('b')!.computedStart).toBe(8);
    expect(byId.get('b')!.computedEnd).toBe(10);
  });

  it('stretches a leaf to meet a maxEnd pin (manual due date)', () => {
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const constraints = new Map([['a', { maxEnd: 10 }]]);
    const result = schedule([a], 0, constraints);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedEnd).toBe(10);
    expect(byId.get('a')!.duration).toBe(10);
  });

  it('leaves duration alone when maxEnd is earlier than the estimate would finish', () => {
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const constraints = new Map([['a', { maxEnd: 3 }]]);
    const result = schedule([a], 0, constraints);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.duration).toBe(5);
    expect(byId.get('a')!.computedEnd).toBe(5);
  });

  it('FS lag pushes a follower past the cursor', () => {
    // A=3, B depends on A FS lag=5. Single-worker cursor would put B
    // at A.end=3, but FS lag pushes it to A.end + 5 = 8.
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 2,
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 5 }],
    });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('b')!.computedStart).toBe(8);
    expect(byId.get('b')!.computedEnd).toBe(10);
  });
});

// ── Critical path ───────────────────────────────────────────────

describe('criticalPath', () => {
  it('finds the critical path in the doc example', () => {
    const { allNodes } = buildScheduleExample();
    const result = criticalPath(allNodes);

    // Total duration: Design(3) + Backend(7) + Integration(3) = 13... wait.
    // Actually: Design ends at 3. Backend ends at 10. Frontend ends at 11.
    // Integration starts at max(11, 10) = 11, ends at 14.
    // So total = 14.
    expect(result.totalDuration).toBe(14);

    // Critical path: Design -> Frontend -> Integration (3+8+3=14)
    // Backend has float: it ends at 10, integration waits until 11 (1 day float)
    // Launch is milestone (0 duration) so it won't be on critical path
    expect(result.path).toContain('design');
    expect(result.path).toContain('frontend');
    expect(result.path).toContain('integration');
    expect(result.path).not.toContain('backend');

    // Backend should have 1 day of float
    expect(result.float['backend']).toBe(1);

    // Critical path nodes have 0 float
    expect(result.float['design']).toBe(0);
    expect(result.float['frontend']).toBe(0);
    expect(result.float['integration']).toBe(0);
  });

  it('returns empty for no nodes', () => {
    const result = criticalPath([]);
    expect(result.path).toEqual([]);
    expect(result.totalDuration).toBe(0);
  });

  it('handles a single chain', () => {
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 5,
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }],
    });
    const c = makeNode({
      id: 'c',
      effortEstimate: 2,
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });

    const result = criticalPath([a, b, c]);
    expect(result.totalDuration).toBe(10);
    expect(result.path).toEqual(['a', 'b', 'c']);
  });

  it('handles parallel paths with different lengths', () => {
    // A(5) -> C(2) = 7
    // B(10) -> C(2) = 12 (critical)
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const b = makeNode({ id: 'b', effortEstimate: 10 });
    const c = makeNode({
      id: 'c',
      effortEstimate: 2,
      dependencies: [
        { targetNodeId: 'a', type: 'FS', lag: 0 },
        { targetNodeId: 'b', type: 'FS', lag: 0 },
      ],
    });

    const result = criticalPath([a, b, c]);
    expect(result.totalDuration).toBe(12);
    expect(result.path).toContain('b');
    expect(result.path).toContain('c');
    expect(result.path).not.toContain('a');
    expect(result.float['a']).toBe(5); // 5 days float
  });
});

// ── Priority-inheritance scheduler tests (v0.17.0) ──────────────

describe('priority-inheritance schedule', () => {
  it('orders leaves by priority — high priority first', () => {
    const a = makeNode({ id: 'a', priority: 'P2', effortEstimate: 2 });
    const b = makeNode({ id: 'b', priority: 'P0', effortEstimate: 1 });
    const c = makeNode({ id: 'c', priority: 'P1', effortEstimate: 3 });
    const result = schedule([a, b, c]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // Order: b (P0) at 0..1, c (P1) at 1..4, a (P2) at 4..6
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(1);
    expect(byId.get('c')!.computedStart).toBe(1);
    expect(byId.get('c')!.computedEnd).toBe(4);
    expect(byId.get('a')!.computedStart).toBe(4);
    expect(byId.get('a')!.computedEnd).toBe(6);
  });

  it('high-priority item with low-priority blocker: blocker inherits and runs first', () => {
    // A=P0 depends on B=P3. B inherits P0 → runs at 0, then A.
    // C=P1 has no deps → runs after A (queue: B@P0, A@P0, C@P1).
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: 1,
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({ id: 'b', priority: 'P3', effortEstimate: 2 });
    const c = makeNode({ id: 'c', priority: 'P1', effortEstimate: 1 });
    const result = schedule([a, b, c]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(2);
    expect(byId.get('a')!.computedStart).toBe(2);
    expect(byId.get('a')!.computedEnd).toBe(3);
    expect(byId.get('c')!.computedStart).toBe(3);
    expect(byId.get('c')!.computedEnd).toBe(4);
  });

  it('chain inheritance: A → B → C all converge to A.priority', () => {
    // A=P0 depends on B. B=P2 depends on C. C=P3.
    // After inheritance: A=P0, B=P0, C=P0.
    // Topological order forces C before B before A.
    // Queue: C, B, A (all P0).
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: 1,
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({
      id: 'b',
      priority: 'P2',
      effortEstimate: 1,
      dependencies: [{ targetNodeId: 'c', type: 'FS', lag: 0 }],
    });
    const c = makeNode({ id: 'c', priority: 'P3', effortEstimate: 1 });
    const result = schedule([a, b, c]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('c')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedStart).toBe(1);
    expect(byId.get('a')!.computedStart).toBe(2);
  });

  it('diamond: B blocks both A and E, inherits min priority', () => {
    // A=P0 deps on B, E=P2 deps on B, B=P3.
    // B inherits min(P0, P2) = P0.
    // After inheritance: A=P0, B=P0, E=P2.
    // Queue: B (P0), A (P0), E (P2). [B before A by topo, A and B share P0]
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: 1,
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const b = makeNode({ id: 'b', priority: 'P3', effortEstimate: 1 });
    const e = makeNode({
      id: 'e',
      priority: 'P2',
      effortEstimate: 1,
      dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }],
    });
    const result = schedule([a, b, e]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedStart).toBe(1);
    expect(byId.get('e')!.computedStart).toBe(2);
  });

  it('parent rollup: parent.start = min(child.start), parent.end = max(child.end)', () => {
    const parent = makeNode({
      id: 'p',
      childrenIds: ['c1', 'c2'],
    });
    const c1 = makeNode({
      id: 'c1',
      parentId: 'p',
      priority: 'P0',
      effortEstimate: 2,
    });
    const c2 = makeNode({
      id: 'c2',
      parentId: 'p',
      priority: 'P1',
      effortEstimate: 3,
    });
    const result = schedule([parent, c1, c2]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // c1 at 0..2, c2 at 2..5. Parent at 0..5.
    expect(byId.get('p')!.computedStart).toBe(0);
    expect(byId.get('p')!.computedEnd).toBe(5);
  });

  it('priorityRank tiebreaks within same priority enum', () => {
    const a = makeNode({ id: 'a', priority: 'P1', priorityRank: 3, effortEstimate: 1 });
    const b = makeNode({ id: 'b', priority: 'P1', priorityRank: 1, effortEstimate: 1 });
    const c = makeNode({ id: 'c', priority: 'P1', priorityRank: 2, effortEstimate: 1 });
    const result = schedule([a, b, c]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('b')!.computedStart).toBe(0); // rank 1
    expect(byId.get('c')!.computedStart).toBe(1); // rank 2
    expect(byId.get('a')!.computedStart).toBe(2); // rank 3
  });

  it('null priority sorts last (lowest)', () => {
    const a = makeNode({ id: 'a', priority: null, effortEstimate: 1 });
    const b = makeNode({ id: 'b', priority: 'P3', effortEstimate: 1 });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedStart).toBe(1);
  });

  it('workerCount=2: two independent leaves run in parallel on different tracks', () => {
    const a = makeNode({ id: 'a', priority: 'P0', effortEstimate: 3 });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 2 });
    const result = schedule([a, b], 0, undefined, undefined, 2);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // A on track 0 at 0..3, B on track 1 at 0..2 (both start at day 0).
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedEnd).toBe(3);
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(2);
  });

  it('workerCount=2: dep forces serial even with capacity', () => {
    const a = makeNode({ id: 'a', priority: 'P0', effortEstimate: 3 });
    const b = makeNode({
      id: 'b',
      priority: 'P1',
      effortEstimate: 2,
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }],
    });
    const result = schedule([a, b], 0, undefined, undefined, 2);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // A at 0..3 on track 0. B depends on A so must start at 3 — picks
    // track 1 (cursor 0) but constraint pushes start to 3.
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedEnd).toBe(3);
    expect(byId.get('b')!.computedStart).toBe(3);
    expect(byId.get('b')!.computedEnd).toBe(5);
  });

  it('workerCount=2: three items, two parallel then third on first free track', () => {
    const a = makeNode({ id: 'a', priority: 'P0', effortEstimate: 4 });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 2 });
    const c = makeNode({ id: 'c', priority: 'P2', effortEstimate: 3 });
    const result = schedule([a, b, c], 0, undefined, undefined, 2);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // A on track 0 at 0..4. B on track 1 at 0..2. C picks track 1
    // (cursor 2 < track 0's cursor 4) and runs at 2..5.
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedEnd).toBe(4);
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(2);
    expect(byId.get('c')!.computedStart).toBe(2);
    expect(byId.get('c')!.computedEnd).toBe(5);
  });

  it('done leaves end at today with effort as bar width; do not consume cursor', () => {
    // A is done with effort 3 → bar spans [today-3, today].
    // B is todo with effort 2 → starts at 0 (cursor wasn't moved by A).
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: 3,
      percentComplete: 100,
    });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 2 });
    // todayDay = 10 (well past projectStartDay = 0)
    const result = schedule([a, b], 0, undefined, undefined, 1, 10);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(7); // today - 3
    expect(byId.get('a')!.computedEnd).toBe(10);  // today
    expect(byId.get('a')!.duration).toBe(3);
    expect(byId.get('b')!.computedStart).toBe(0); // cursor still at start
    expect(byId.get('b')!.computedEnd).toBe(2);
  });

  it('done leaf with null effort collapses to a zero-width marker at today', () => {
    // The #213-followup / #132-PR case: done + no estimate. They get
    // zero width but END AT TODAY, not at the project anchor.
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: null,
      percentComplete: 100,
    });
    const c = makeNode({ id: 'c', priority: 'P1', effortEstimate: 1 });
    const result = schedule([a, c], 0, undefined, undefined, 1, 10);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(10); // today
    expect(byId.get('a')!.computedEnd).toBe(10);   // today
    expect(byId.get('a')!.duration).toBe(0);
    expect(byId.get('c')!.computedStart).toBe(0);
    expect(byId.get('c')!.computedEnd).toBe(1);
  });

  it('todayDay defaults to projectStartDay (back-compat for callers that omit it)', () => {
    // Old call signature (no todayDay) still works: done items pin at 0.
    const a = makeNode({
      id: 'a',
      priority: 'P0',
      effortEstimate: 3,
      percentComplete: 100,
    });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 2 });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.computedStart).toBe(-3); // 0 - 3
    expect(byId.get('a')!.computedEnd).toBe(0);
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(2);
  });

  it('mixed parent rollup skips done children, reflects only outstanding work', () => {
    // Parent with one done child + one todo child. The bar should reflect
    // the TODO work's span only — done child is excluded from rollup.
    const parent = makeNode({ id: 'p', childrenIds: ['done_c', 'todo_c'] });
    const doneChild = makeNode({
      id: 'done_c',
      parentId: 'p',
      priority: 'P0',
      effortEstimate: 5,
      percentComplete: 100,
    });
    const todoChild = makeNode({
      id: 'todo_c',
      parentId: 'p',
      priority: 'P1',
      effortEstimate: 3,
    });
    const result = schedule([parent, doneChild, todoChild], 0, undefined, undefined, 1, 10);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // done_c at [5, 10] (today-5..today); todo_c at [0, 3].
    expect(byId.get('done_c')!.computedStart).toBe(5);
    expect(byId.get('done_c')!.computedEnd).toBe(10);
    expect(byId.get('todo_c')!.computedStart).toBe(0);
    expect(byId.get('todo_c')!.computedEnd).toBe(3);
    // Parent rollup uses ONLY todo_c → span 0..3. If we'd included
    // done_c (5..10), the parent would have spanned 0..10 — wrong.
    expect(byId.get('p')!.computedStart).toBe(0);
    expect(byId.get('p')!.computedEnd).toBe(3);
  });

  it('mixed parent with done child + LATE todo child: parent.start follows the todo', () => {
    const blocker = makeNode({ id: 'blocker', priority: 'P0', effortEstimate: 5 });
    const parent = makeNode({ id: 'p', childrenIds: ['done_c', 'todo_c'] });
    const doneChild = makeNode({
      id: 'done_c',
      parentId: 'p',
      priority: 'P0',
      effortEstimate: 1,
      percentComplete: 100,
    });
    const todoChild = makeNode({
      id: 'todo_c',
      parentId: 'p',
      priority: 'P1',
      effortEstimate: 2,
      dependencies: [{ targetNodeId: 'blocker', type: 'FS', lag: 0 }],
    });
    const result = schedule([blocker, parent, doneChild, todoChild], 0, undefined, undefined, 1, 10);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // blocker at 0..5, done_c at 9..10, todo_c at 5..7.
    expect(byId.get('todo_c')!.computedStart).toBe(5);
    expect(byId.get('todo_c')!.computedEnd).toBe(7);
    // Parent rollup uses ONLY todo_c.
    expect(byId.get('p')!.computedStart).toBe(5);
    expect(byId.get('p')!.computedEnd).toBe(7);
  });

  it('parent whose ALL children are done spans the past work and ends at today', () => {
    // Grandparent → parent → 2 done children, each 1d. Parent has no
    // active work — its bar should span the past work (c1 + c2 are both
    // at [9, 10] since they both have 1d effort and end at today=10).
    const gp = makeNode({ id: 'gp', childrenIds: ['p'] });
    const parent = makeNode({
      id: 'p',
      parentId: 'gp',
      childrenIds: ['c1', 'c2'],
    });
    const c1 = makeNode({
      id: 'c1',
      parentId: 'p',
      effortEstimate: 1,
      percentComplete: 100,
    });
    const c2 = makeNode({
      id: 'c2',
      parentId: 'p',
      effortEstimate: 1,
      percentComplete: 100,
    });
    const result = schedule([gp, parent, c1, c2], 0, undefined, undefined, 1, 10);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // Both children at [9, 10]. Parent rolls up to [9, 10] (their span).
    expect(byId.get('c1')!.computedStart).toBe(9);
    expect(byId.get('c1')!.computedEnd).toBe(10);
    expect(byId.get('p')!.computedStart).toBe(9);
    expect(byId.get('p')!.computedEnd).toBe(10);
    // Grandparent rolls up from its sole (done) child — same past span.
    expect(byId.get('gp')!.computedStart).toBe(9);
    expect(byId.get('gp')!.computedEnd).toBe(10);
  });

  it('workerCount=1 is identical to default (serial regression)', () => {
    const a = makeNode({ id: 'a', priority: 'P0', effortEstimate: 2 });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 3 });
    const expected = schedule([a, b]); // default workerCount=1
    const explicit = schedule([a, b], 0, undefined, undefined, 1);
    expect(explicit).toEqual(expected);
  });

  it('hours → business-day conversion via context', () => {
    const a = makeNode({ id: 'a', priority: 'P0', effortEstimate: 12 });
    const b = makeNode({ id: 'b', priority: 'P1', effortEstimate: 8 });
    const result = schedule([a, b], 0, undefined, {
      effortUnit: 'hours',
      hoursPerDay: 8,
    });
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // 12h → ceil(12/8) = 2 days. 8h → 1 day.
    expect(byId.get('a')!.duration).toBe(2);
    expect(byId.get('b')!.duration).toBe(1);
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedStart).toBe(2);
  });
});

