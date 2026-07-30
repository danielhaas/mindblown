/**
 * Unit tests for the orchestration substrate (#111).
 *
 * Covers:
 * - isReady() predicate: all 4 dependency types
 * - scopeOverlap(): symmetric, empty-empty=false, identical=full overlap
 */

import { describe, it, expect } from 'vitest';
import { isReady, scopeOverlap } from '../dependencies.js';
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
    verificationVideoUrl: null,
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

/** Simple isDone: status === 'done' */
const isDone = (status: string | null) => status === 'done';

// ── isReady() tests ─────────────────────────────────────────────

describe('isReady()', () => {
  it('returns true for a node with no dependencies', () => {
    const node = makeNode({ id: 'A', status: null });
    const map = toMap([node]);
    expect(isReady(node, map, isDone)).toBe(true);
  });

  it('returns false for a claimed node (even with no deps)', () => {
    const node = makeNode({ id: 'A', claimedBySession: 'sess-001' });
    const map = toMap([node]);
    expect(isReady(node, map, isDone)).toBe(false);
  });

  it('returns false when claimedAt is set but claimedBySession is set', () => {
    const node = makeNode({ id: 'A', claimedBySession: 'sess-002', claimedAt: '2026-01-01T00:00:00Z' });
    const map = toMap([node]);
    expect(isReady(node, map, isDone)).toBe(false);
  });

  describe('FS dependency (Finish-to-Start)', () => {
    it('returns false when FS predecessor is not done', () => {
      const pred = makeNode({ id: 'pred', status: 'in_progress' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'FS', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(false);
    });

    it('returns true when FS predecessor is done', () => {
      const pred = makeNode({ id: 'pred', status: 'done' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'FS', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(true);
    });

    it('returns false when one FS predecessor is done but another is not', () => {
      const pred1 = makeNode({ id: 'pred1', status: 'done' });
      const pred2 = makeNode({ id: 'pred2', status: null });
      const node = makeNode({
        id: 'A',
        dependencies: [
          { targetNodeId: 'pred1', type: 'FS', lag: 0 },
          { targetNodeId: 'pred2', type: 'FS', lag: 0 },
        ],
      });
      const map = toMap([pred1, pred2, node]);
      expect(isReady(node, map, isDone)).toBe(false);
    });
  });

  describe('SS dependency (Start-to-Start)', () => {
    it('returns false when SS predecessor is not done', () => {
      const pred = makeNode({ id: 'pred', status: 'todo' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'SS', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(false);
    });

    it('returns true when SS predecessor is done', () => {
      const pred = makeNode({ id: 'pred', status: 'done' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'SS', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(true);
    });
  });

  describe('FF dependency (Finish-to-Finish)', () => {
    it('returns false when FF predecessor is not done', () => {
      const pred = makeNode({ id: 'pred', status: null });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'FF', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(false);
    });

    it('returns true when FF predecessor is done', () => {
      const pred = makeNode({ id: 'pred', status: 'done' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'FF', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(true);
    });
  });

  describe('SF dependency (Start-to-Finish)', () => {
    it('returns false when SF predecessor is not done', () => {
      const pred = makeNode({ id: 'pred', status: 'in_progress' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'SF', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(false);
    });

    it('returns true when SF predecessor is done', () => {
      const pred = makeNode({ id: 'pred', status: 'done' });
      const node = makeNode({
        id: 'A',
        dependencies: [{ targetNodeId: 'pred', type: 'SF', lag: 0 }],
      });
      const map = toMap([pred, node]);
      expect(isReady(node, map, isDone)).toBe(true);
    });
  });

  it('skips missing predecessors (external deps not in nodeMap)', () => {
    const node = makeNode({
      id: 'A',
      dependencies: [{ targetNodeId: 'external-not-in-map', type: 'FS', lag: 0 }],
    });
    const map = toMap([node]);
    // External dep not in nodeMap → skip → still ready
    expect(isReady(node, map, isDone)).toBe(true);
  });

  it('chain: A blocks B blocks C — C is not ready until B is done', () => {
    const a = makeNode({ id: 'A', status: 'done' });
    const b = makeNode({
      id: 'B',
      status: null,
      dependencies: [{ targetNodeId: 'A', type: 'FS', lag: 0 }],
    });
    const c = makeNode({
      id: 'C',
      status: null,
      dependencies: [{ targetNodeId: 'B', type: 'FS', lag: 0 }],
    });
    const map = toMap([a, b, c]);
    expect(isReady(b, map, isDone)).toBe(true); // B is ready (A is done)
    expect(isReady(c, map, isDone)).toBe(false); // C is not ready (B is not done)
  });

  it('auto-release test: node with claimedBySession=null is ready', () => {
    // Simulates a node whose claim was auto-released when set_status('done')
    // was called on its predecessor. The node itself is todo + unclaimed.
    const pred = makeNode({ id: 'pred', status: 'done', claimedBySession: null });
    const node = makeNode({
      id: 'A',
      status: null,
      claimedBySession: null,
      dependencies: [{ targetNodeId: 'pred', type: 'FS', lag: 0 }],
    });
    const map = toMap([pred, node]);
    expect(isReady(node, map, isDone)).toBe(true);
  });
});

// ── scopeOverlap() tests ─────────────────────────────────────────

describe('scopeOverlap()', () => {
  it('empty-empty → no overlap', () => {
    expect(scopeOverlap([], [])).toEqual([]);
  });

  it('empty-nonempty → no overlap', () => {
    expect(scopeOverlap([], ['apps/workflows'])).toEqual([]);
    expect(scopeOverlap(['apps/workflows'], [])).toEqual([]);
  });

  it('disjoint sets → no overlap', () => {
    expect(scopeOverlap(['a', 'b'], ['c', 'd'])).toEqual([]);
  });

  it('single overlap', () => {
    const result = scopeOverlap(['apps/workflows', 'model:Mandate'], ['apps/workflows', 'frontend:contacts']);
    expect(result).toEqual(['apps/workflows']);
  });

  it('full overlap — identical sets', () => {
    const scopes = ['apps/workflows', 'model:Mandate'];
    const result = scopeOverlap(scopes, [...scopes]);
    expect(result.sort()).toEqual(['apps/workflows', 'model:Mandate']);
  });

  it('is symmetric', () => {
    const a = ['apps/workflows', 'model:Mandate'];
    const b = ['apps/workflows', 'frontend:contacts', 'model:Mandate'];
    const ab = scopeOverlap(a, b).sort();
    const ba = scopeOverlap(b, a).sort();
    expect(ab).toEqual(ba);
  });

  it('order in result matches second array order', () => {
    // scopeOverlap returns elements in the order they appear in b
    const result = scopeOverlap(['z', 'a', 'b'], ['a', 'b', 'z']);
    expect(result).toEqual(['a', 'b', 'z']);
  });
});
