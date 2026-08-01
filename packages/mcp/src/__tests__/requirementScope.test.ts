/**
 * Version-scoping for the requirements register: requirements_overview's
 * versionId filter mirrors RequirementsView.tsx's release filter/slider —
 * a requirement matches a release if its own versionId is that release, OR
 * any node anywhere below it (not just direct children) carries it.
 */

import { describe, it, expect } from 'vitest';
import { descendantVersionIds, requirementMatchesVersion } from '../requirementScope.js';
import type { NodeWithComputed } from '../api.js';

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
    attachments: [],
    collapsed: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    revision: 1,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    verificationVideoPosterUrl: null,
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
 *   ├── req-a (requirementId: A, versionId: null)
 *   │   ├── a1 (leaf, versionId: v1)
 *   │   └── a2
 *   │       └── a2-req (requirementId: A2, versionId: v2)  -- nested requirement
 *   ├── req-b (requirementId: B, versionId: v1)             -- own versionId set
 *   │   └── b1 (leaf, no version)
 *   └── req-c (requirementId: C, versionId: null)            -- version nowhere below
 *       └── c1 (leaf, no version)
 */
function makeNodeById(): Map<string, NodeWithComputed> {
  const nodes = [
    makeNode({ id: 'root', childrenIds: ['req-a', 'req-b', 'req-c'] }),
    makeNode({ id: 'req-a', parentId: 'root', childrenIds: ['a1', 'a2'], requirementId: 'A' }),
    makeNode({ id: 'a1', parentId: 'req-a', versionId: 'v1' }),
    makeNode({ id: 'a2', parentId: 'req-a', childrenIds: ['a2-req'] }),
    makeNode({ id: 'a2-req', parentId: 'a2', requirementId: 'A2', versionId: 'v2' }),
    makeNode({ id: 'req-b', parentId: 'root', childrenIds: ['b1'], requirementId: 'B', versionId: 'v1' }),
    makeNode({ id: 'b1', parentId: 'req-b' }),
    makeNode({ id: 'req-c', parentId: 'root', childrenIds: ['c1'], requirementId: 'C' }),
    makeNode({ id: 'c1', parentId: 'req-c' }),
  ];
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('descendantVersionIds', () => {
  it('collects a version on a direct-child leaf', () => {
    const nodeById = makeNodeById();
    expect(descendantVersionIds(nodeById, 'req-a')).toContain('v1');
  });

  it('collects a version several levels down, past a nested requirement node', () => {
    const nodeById = makeNodeById();
    // v2 sits on a2-req, which is a grandchild of req-a AND its own
    // requirement — the walk must not stop or special-case at it.
    expect(descendantVersionIds(nodeById, 'req-a')).toContain('v2');
  });

  it('returns both versions for a requirement split across releases', () => {
    const nodeById = makeNodeById();
    const versions = descendantVersionIds(nodeById, 'req-a');
    expect(versions.sort()).toEqual(['v1', 'v2']);
  });

  it('does not leak a sibling subtree\'s version', () => {
    const nodeById = makeNodeById();
    // req-b's own versionId is v1, but nothing BELOW req-b carries a
    // version — descendantVersionIds only walks children, so this must
    // be empty (req-b's own versionId is a separate check).
    expect(descendantVersionIds(nodeById, 'req-b')).toEqual([]);
  });

  it('returns empty when no version exists anywhere below', () => {
    const nodeById = makeNodeById();
    expect(descendantVersionIds(nodeById, 'req-c')).toEqual([]);
  });

  it('returns empty for an unknown node id', () => {
    const nodeById = makeNodeById();
    expect(descendantVersionIds(nodeById, 'does-not-exist')).toEqual([]);
  });
});

describe('requirementMatchesVersion', () => {
  it('matches via descendant versionId when the requirement itself has none', () => {
    const nodeById = makeNodeById();
    expect(requirementMatchesVersion(nodeById, 'req-a', 'v1')).toBe(true);
    expect(requirementMatchesVersion(nodeById, 'req-a', 'v2')).toBe(true);
  });

  it('matches via the requirement\'s own versionId even with no tagged descendants', () => {
    const nodeById = makeNodeById();
    expect(requirementMatchesVersion(nodeById, 'req-b', 'v1')).toBe(true);
  });

  it('does not match an unrelated version', () => {
    const nodeById = makeNodeById();
    expect(requirementMatchesVersion(nodeById, 'req-b', 'v2')).toBe(false);
    expect(requirementMatchesVersion(nodeById, 'req-c', 'v1')).toBe(false);
  });
});
