/**
 * The shared MI-suite scoping helper: subtree scoping, inherited-version
 * scoping, and their combination. Extracted from remaining_work /
 * completion_forecast / risk_scan when plan_lint became its 4th consumer.
 */

import { describe, it, expect } from 'vitest';
import { scopedLeaves } from '../scope.js';
import type { MapDetail, NodeWithComputed } from '../api.js';

function makeNode(overrides: Partial<NodeWithComputed> & { id: string }): NodeWithComputed {
  return {
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
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
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    collapsed: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    claimedBySession: null,
    claimedAt: null,
    computedEffort: 0,
    computedProgress: 0,
    healthSignal: 'on_track',
    isBlocked: false,
    blockedBy: { manual: false, predecessorIds: [], blockedDescendantCount: 0 },
    ...overrides,
  };
}

/**
 * Tree:
 *   root
 *   ├── a (versionId: v1)
 *   │   ├── a1 (leaf)
 *   │   └── a2 (leaf, versionId: v2)
 *   └── b
 *       └── b1 (leaf)
 */
function makeMap(): MapDetail {
  const nodes = [
    makeNode({ id: 'root', childrenIds: ['a', 'b'] }),
    makeNode({ id: 'a', parentId: 'root', childrenIds: ['a1', 'a2'], versionId: 'v1' }),
    makeNode({ id: 'a1', parentId: 'a' }),
    makeNode({ id: 'a2', parentId: 'a', versionId: 'v2' }),
    makeNode({ id: 'b', parentId: 'root', childrenIds: ['b1'] }),
    makeNode({ id: 'b1', parentId: 'b' }),
  ];
  return { map: { id: 'm1' }, nodes } as unknown as MapDetail;
}

describe('scopedLeaves', () => {
  it('returns all leaves for an unscoped call', () => {
    const res = scopedLeaves(makeMap());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leaves.map((l) => l.id).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(res.scopeLabel).toBe('whole map');
  });

  it('scopes to a subtree via nodeId', () => {
    const res = scopedLeaves(makeMap(), { nodeId: 'a' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leaves.map((l) => l.id).sort()).toEqual(['a1', 'a2']);
    expect(res.scopeLabel).toContain('subtree');
  });

  it('treats a scoped leaf node as its own single-leaf subtree', () => {
    const res = scopedLeaves(makeMap(), { nodeId: 'b1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leaves.map((l) => l.id)).toEqual(['b1']);
  });

  it('scopes by version with ancestor inheritance', () => {
    // a1 inherits v1 from parent a; a2 carries v2 directly but also inherits v1.
    const v1 = scopedLeaves(makeMap(), { versionId: 'v1' });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.leaves.map((l) => l.id).sort()).toEqual(['a1', 'a2']);

    const v2 = scopedLeaves(makeMap(), { versionId: 'v2' });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.leaves.map((l) => l.id)).toEqual(['a2']);
  });

  it('intersects nodeId and versionId scopes', () => {
    const res = scopedLeaves(makeMap(), { nodeId: 'b', versionId: 'v1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.leaves).toEqual([]);
  });

  it('errors on an unknown nodeId', () => {
    const res = scopedLeaves(makeMap(), { nodeId: 'nope' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('nope');
  });
});
