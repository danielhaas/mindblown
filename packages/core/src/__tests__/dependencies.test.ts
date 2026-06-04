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

// ── Scheduling (forward pass) ───────────────────────────────────

describe('schedule', () => {
  it('schedules the doc example correctly', () => {
    const { allNodes } = buildScheduleExample();
    const result = schedule(allNodes);

    const byId = new Map(result.map((s) => [s.nodeId, s]));

    // Design: start=0, end=3
    expect(byId.get('design')!.computedStart).toBe(0);
    expect(byId.get('design')!.computedEnd).toBe(3);

    // Frontend: start=3 (after design), end=11
    expect(byId.get('frontend')!.computedStart).toBe(3);
    expect(byId.get('frontend')!.computedEnd).toBe(11);

    // Backend: start=3 (after design), end=10
    expect(byId.get('backend')!.computedStart).toBe(3);
    expect(byId.get('backend')!.computedEnd).toBe(10);

    // Integration: starts after max(frontend=11, backend=10) = 11, end=14
    expect(byId.get('integration')!.computedStart).toBe(11);
    expect(byId.get('integration')!.computedEnd).toBe(14);

    // Launch: starts at 14, end=14 (milestone, 0 duration)
    expect(byId.get('launch')!.computedStart).toBe(14);
    expect(byId.get('launch')!.computedEnd).toBe(14);
  });

  it('handles lag on dependencies', () => {
    const a = makeNode({ id: 'a', effortEstimate: 3 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 5,
      dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 2 }],
    });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));

    // B starts at A.end + lag = 3 + 2 = 5
    expect(byId.get('b')!.computedStart).toBe(5);
    expect(byId.get('b')!.computedEnd).toBe(10);
  });

  it('handles SS dependency type', () => {
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 3,
      dependencies: [{ targetNodeId: 'a', type: 'SS', lag: 1 }],
    });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));

    // SS: B can start when A starts + lag = 0 + 1 = 1
    expect(byId.get('b')!.computedStart).toBe(1);
    expect(byId.get('b')!.computedEnd).toBe(4);
  });

  it('handles FF dependency type', () => {
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 3,
      dependencies: [{ targetNodeId: 'a', type: 'FF', lag: 0 }],
    });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));

    // FF: B.end >= A.end + lag → B.start >= A.end + lag - B.duration = 5 + 0 - 3 = 2
    expect(byId.get('b')!.computedStart).toBe(2);
    expect(byId.get('b')!.computedEnd).toBe(5);
  });

  it('handles SF dependency type', () => {
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const b = makeNode({
      id: 'b',
      effortEstimate: 3,
      dependencies: [{ targetNodeId: 'a', type: 'SF', lag: 0 }],
    });
    const result = schedule([a, b]);
    const byId = new Map(result.map((s) => [s.nodeId, s]));

    // SF: B.end >= A.start + lag → B.start >= A.start + lag - B.duration = 0 + 0 - 3 = -3 → clamped to 0
    expect(byId.get('b')!.computedStart).toBe(0);
    expect(byId.get('b')!.computedEnd).toBe(3);
  });

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
    // start=0, required duration = 10-0 = 10 > estimate 3 → stretched
    expect(byId.get('a')!.computedStart).toBe(0);
    expect(byId.get('a')!.computedEnd).toBe(10);
    expect(byId.get('a')!.duration).toBe(10);
  });

  it('leaves duration alone when maxEnd is earlier than the estimate would finish', () => {
    const a = makeNode({ id: 'a', effortEstimate: 5 });
    const constraints = new Map([['a', { maxEnd: 3 }]]);
    const result = schedule([a], 0, constraints);
    const byId = new Map(result.map((s) => [s.nodeId, s]));
    // Required duration 3 < estimate 5 → keep the larger estimate
    expect(byId.get('a')!.duration).toBe(5);
    expect(byId.get('a')!.computedEnd).toBe(5);
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
