import { describe, it, expect } from 'vitest';
import {
  computeEffort,
  computeProgress,
  computeHealth,
  computeTree,
  leafHealth,
} from '../compute.js';
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
    percentComplete: null,
    status: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    customFields: {},
    dependencies: [],
    isMilestone: false,
    cycleId: null,
    externalLinks: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

function toMap(nodes: Node[]): NodeMap {
  const map: NodeMap = new Map();
  for (const n of nodes) map.set(n.id, n);
  return map;
}

// ── Website Redesign example from the product vision ────────────
//
//   Website Redesign (root)
//   ├── Backend
//   │   ├── API Endpoints   effort=7, progress=0%
//   │   └── DB Migration    effort=5, progress=0%
//   └── Design
//       ├── Wireframes      effort=3, progress=100%
//       ├── Visual Design   effort=5, progress=80%
//       └── Design System   effort=4, progress=25%
//
// Expected:
//   Backend:   effort=12, progress=0%
//   Design:    effort=12, progress=(3*100 + 5*80 + 4*25)/12 = (300+400+100)/12 = 66.67%
//   Root:      effort=24, progress=(12*0 + 12*66.67)/24 = 800/24 = 33.33%

function buildWebsiteRedesign() {
  const apiEndpoints = makeNode({
    id: 'api-endpoints',
    parentId: 'backend',
    effortEstimate: 7,
    percentComplete: 0,
  });
  const dbMigration = makeNode({
    id: 'db-migration',
    parentId: 'backend',
    effortEstimate: 5,
    percentComplete: 0,
  });
  const wireframes = makeNode({
    id: 'wireframes',
    parentId: 'design',
    effortEstimate: 3,
    percentComplete: 100,
  });
  const visualDesign = makeNode({
    id: 'visual-design',
    parentId: 'design',
    effortEstimate: 5,
    percentComplete: 80,
  });
  const designSystem = makeNode({
    id: 'design-system',
    parentId: 'design',
    effortEstimate: 4,
    percentComplete: 25,
  });
  const backend = makeNode({
    id: 'backend',
    parentId: 'root',
    childrenIds: ['api-endpoints', 'db-migration'],
  });
  const design = makeNode({
    id: 'design',
    parentId: 'root',
    childrenIds: ['wireframes', 'visual-design', 'design-system'],
  });
  const root = makeNode({
    id: 'root',
    childrenIds: ['backend', 'design'],
  });

  const allNodes = [
    root,
    backend,
    design,
    apiEndpoints,
    dbMigration,
    wireframes,
    visualDesign,
    designSystem,
  ];
  const nodeMap = toMap(allNodes);

  return { root, backend, design, apiEndpoints, dbMigration, wireframes, visualDesign, designSystem, allNodes, nodeMap };
}

// ── Effort rollup tests ─────────────────────────────────────────

describe('computeEffort', () => {
  it('returns effortEstimate for leaf nodes', () => {
    const { apiEndpoints, nodeMap } = buildWebsiteRedesign();
    expect(computeEffort(apiEndpoints, nodeMap)).toBe(7);
  });

  it('returns 0 for unestimated leaf nodes', () => {
    const node = makeNode({ id: 'leaf', effortEstimate: null });
    const nm = toMap([node]);
    expect(computeEffort(node, nm)).toBe(0);
  });

  it('sums children effort for parent nodes', () => {
    const { backend, design, nodeMap } = buildWebsiteRedesign();
    expect(computeEffort(backend, nodeMap)).toBe(12);
    expect(computeEffort(design, nodeMap)).toBe(12);
  });

  it('sums all descendants for root', () => {
    const { root, nodeMap } = buildWebsiteRedesign();
    expect(computeEffort(root, nodeMap)).toBe(24);
  });

  it('returns 0 for milestone nodes regardless of children', () => {
    const child = makeNode({ id: 'child', parentId: 'ms', effortEstimate: 5 });
    const milestone = makeNode({
      id: 'ms',
      isMilestone: true,
      childrenIds: ['child'],
    });
    const nm = toMap([milestone, child]);
    expect(computeEffort(milestone, nm)).toBe(0);
  });
});

// ── Progress rollup tests ───────────────────────────────────────

describe('computeProgress', () => {
  it('returns percentComplete for leaf nodes', () => {
    const { wireframes, nodeMap } = buildWebsiteRedesign();
    expect(computeProgress(wireframes, nodeMap)).toBe(100);
  });

  it('returns 0 for unset percentComplete', () => {
    const node = makeNode({ id: 'leaf', percentComplete: null });
    const nm = toMap([node]);
    expect(computeProgress(node, nm)).toBe(0);
  });

  it('computes weighted progress for Backend (all 0%)', () => {
    const { backend, nodeMap } = buildWebsiteRedesign();
    expect(computeProgress(backend, nodeMap)).toBe(0);
  });

  it('computes weighted progress for Design', () => {
    const { design, nodeMap } = buildWebsiteRedesign();
    // (3*100 + 5*80 + 4*25) / 12 = (300 + 400 + 100) / 12 = 66.666...
    const progress = computeProgress(design, nodeMap);
    expect(progress).toBeCloseTo(66.67, 1);
  });

  it('computes weighted progress for root (Website Redesign)', () => {
    const { root, nodeMap } = buildWebsiteRedesign();
    // Backend effort=12, progress=0%; Design effort=12, progress=66.67%
    // (12*0 + 12*66.67) / 24 = 33.33%
    const progress = computeProgress(root, nodeMap);
    expect(progress).toBeCloseTo(33.33, 1);
  });

  it('returns 0 when all children have 0 effort', () => {
    const c1 = makeNode({ id: 'c1', parentId: 'p', effortEstimate: 0, percentComplete: 50 });
    const c2 = makeNode({ id: 'c2', parentId: 'p', effortEstimate: null, percentComplete: 80 });
    const parent = makeNode({ id: 'p', childrenIds: ['c1', 'c2'] });
    const nm = toMap([parent, c1, c2]);
    expect(computeProgress(parent, nm)).toBe(0);
  });
});

// ── Health signal tests ─────────────────────────────────────────

describe('leafHealth', () => {
  it('returns on_track when no dueDate', () => {
    const node = makeNode({ id: 'a' });
    expect(leafHealth(node)).toBe('on_track');
  });

  it('returns behind when overdue and not complete', () => {
    const node = makeNode({
      id: 'a',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 50,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const now = new Date('2026-04-01T00:00:00Z');
    expect(leafHealth(node, 0.2, now)).toBe('behind');
  });

  it('returns on_track when overdue but 100% complete', () => {
    const node = makeNode({
      id: 'a',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 100,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const now = new Date('2026-04-01T00:00:00Z');
    expect(leafHealth(node, 0.2, now)).toBe('on_track');
  });

  it('returns at_risk when progress is 20%+ behind pace', () => {
    const node = makeNode({
      id: 'a',
      startDate: '2026-01-01T00:00:00Z',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 10,
      createdAt: '2026-01-01T00:00:00Z',
    });
    // 50% of time elapsed (Jan 1 to Mar 1 = ~59 days; Feb 1 = ~31 days elapsed ~ 52%)
    // Progress = 10% → ratio diff = 0.52 - 0.10 = 0.42 > 0.2
    const now = new Date('2026-02-01T00:00:00Z');
    expect(leafHealth(node, 0.2, now)).toBe('at_risk');
  });

  it('returns on_track when progress is keeping pace', () => {
    const node = makeNode({
      id: 'a',
      startDate: '2026-01-01T00:00:00Z',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 50,
      createdAt: '2026-01-01T00:00:00Z',
    });
    // ~52% elapsed, 50% progress → diff ~0.02, under 0.2 threshold
    const now = new Date('2026-02-01T00:00:00Z');
    expect(leafHealth(node, 0.2, now)).toBe('on_track');
  });
});

describe('computeHealth (propagation)', () => {
  it('propagates worst-child-wins: behind child makes parent behind', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const c1 = makeNode({
      id: 'c1',
      parentId: 'p',
      // on_track: no due date
    });
    const c2 = makeNode({
      id: 'c2',
      parentId: 'p',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 50,
      // overdue → behind
    });
    const parent = makeNode({ id: 'p', childrenIds: ['c1', 'c2'] });
    const nm = toMap([parent, c1, c2]);

    expect(computeHealth(parent, nm, 0.2, now)).toBe('behind');
  });

  it('propagates at_risk when no behind children', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    const c1 = makeNode({
      id: 'c1',
      parentId: 'p',
      // on_track
    });
    const c2 = makeNode({
      id: 'c2',
      parentId: 'p',
      startDate: '2026-01-01T00:00:00Z',
      dueDate: '2026-03-01T00:00:00Z',
      percentComplete: 10,
      createdAt: '2026-01-01T00:00:00Z',
      // at_risk
    });
    const parent = makeNode({ id: 'p', childrenIds: ['c1', 'c2'] });
    const nm = toMap([parent, c1, c2]);

    expect(computeHealth(parent, nm, 0.2, now)).toBe('at_risk');
  });

  it('returns on_track when all children are on_track', () => {
    const c1 = makeNode({ id: 'c1', parentId: 'p' });
    const c2 = makeNode({ id: 'c2', parentId: 'p' });
    const parent = makeNode({ id: 'p', childrenIds: ['c1', 'c2'] });
    const nm = toMap([parent, c1, c2]);

    expect(computeHealth(parent, nm)).toBe('on_track');
  });
});

// ── computeTree (full integration) ──────────────────────────────

describe('computeTree', () => {
  it('computes all values for the Website Redesign example', () => {
    const { allNodes } = buildWebsiteRedesign();
    const result = computeTree(allNodes);

    // Root
    const rootVals = result.get('root')!;
    expect(rootVals.computedEffort).toBe(24);
    expect(rootVals.computedProgress).toBeCloseTo(33.33, 1);
    expect(rootVals.healthSignal).toBe('on_track'); // no due dates set

    // Backend
    const backendVals = result.get('backend')!;
    expect(backendVals.computedEffort).toBe(12);
    expect(backendVals.computedProgress).toBe(0);

    // Design
    const designVals = result.get('design')!;
    expect(designVals.computedEffort).toBe(12);
    expect(designVals.computedProgress).toBeCloseTo(66.67, 1);

    // Leaves
    expect(result.get('api-endpoints')!.computedEffort).toBe(7);
    expect(result.get('api-endpoints')!.computedProgress).toBe(0);
    expect(result.get('wireframes')!.computedProgress).toBe(100);
  });

  it('returns a result for every input node', () => {
    const { allNodes } = buildWebsiteRedesign();
    const result = computeTree(allNodes);
    expect(result.size).toBe(allNodes.length);
  });
});
