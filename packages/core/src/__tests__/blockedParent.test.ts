import { describe, it, expect } from 'vitest';
import { computeIsBlocked } from '../compute.js';
import { explainBlockedParent, outsideBranch } from '../blockedParent.js';
import type { Node, NodeMap } from '../types.js';

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
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    verificationVideoPosterUrl: null,
    // Orchestration substrate (#111)
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    reportedBy: null,
    approval: null,
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

const toMap = (nodes: Node[]): NodeMap => new Map(nodes.map((n) => [n.id, n]));
const fs = (id: string) => [{ targetNodeId: id, type: 'FS' as const, lag: 0 }];

describe('explainBlockedParent', () => {
  it('a chain A (blocked, external) → B → C gives one root cause, A, with B and C counted', () => {
    const p = makeNode({ id: 'p', childrenIds: ['a', 'b', 'c'] });
    const a = makeNode({ id: 'a', parentId: 'p', blockedReason: 'External: vendor VM' });
    const b = makeNode({ id: 'b', parentId: 'p', dependencies: fs('a') });
    const c = makeNode({ id: 'c', parentId: 'p', dependencies: fs('b') });
    const map = toMap([p, a, b, c]);
    const r = explainBlockedParent(p, map);
    expect(r.blockedLeafIds).toEqual(['a', 'b', 'c']);
    expect(r.blockedLeafIds.length).toBe(computeIsBlocked(p, map).blockedBy.blockedDescendantCount);
    expect(r.rootCauses).toEqual([
      { kind: 'reason', nodeId: 'a', reason: 'External: vendor VM', waitingIds: ['a', 'b', 'c'] },
    ]);
  });

  it('an unfinished predecessor in another milestone is the root cause, named with its branch', () => {
    const root = makeNode({ id: 'root', childrenIds: ['m1', 'm2'] });
    const m1 = makeNode({ id: 'm1', parentId: 'root', childrenIds: ['setup', 'deploy'] });
    const m2 = makeNode({ id: 'm2', parentId: 'root', childrenIds: ['vm'] });
    const vm = makeNode({ id: 'vm', parentId: 'm2', percentComplete: 0 });
    const setup = makeNode({ id: 'setup', parentId: 'm1', dependencies: fs('vm') });
    const deploy = makeNode({ id: 'deploy', parentId: 'm1', dependencies: fs('setup') });
    const map = toMap([root, m1, m2, vm, setup, deploy]);
    const r = explainBlockedParent(m1, map);
    expect(r.rootCauses).toEqual([
      { kind: 'predecessor', nodeId: 'vm', reason: null, waitingIds: ['setup', 'deploy'] },
    ]);
    expect(outsideBranch(m1, 'vm', map)?.id).toBe('m2');
    expect(outsideBranch(m1, 'setup', map)).toBeNull();
  });

  it('a leaf waiting on two causes counts under both', () => {
    const p = makeNode({ id: 'p', childrenIds: ['a', 'x', 'b'] });
    const a = makeNode({ id: 'a', parentId: 'p', status: 'blocked', dependencies: fs('x') });
    const x = makeNode({ id: 'x', parentId: 'p', percentComplete: 10 });
    const b = makeNode({ id: 'b', parentId: 'p', dependencies: [...fs('a'), ...fs('x')] });
    const r = explainBlockedParent(p, toMap([p, a, x, b]));
    expect(r.rootCauses).toEqual([
      { kind: 'predecessor', nodeId: 'x', reason: null, waitingIds: ['b'] },
      { kind: 'reason', nodeId: 'a', reason: 'marked blocked', waitingIds: ['a', 'b'] },
    ].sort((m, n) => n.waitingIds.length - m.waitingIds.length));
  });

  it('survives a dependency cycle', () => {
    const p = makeNode({ id: 'p', childrenIds: ['a', 'b'] });
    const a = makeNode({ id: 'a', parentId: 'p', dependencies: fs('b') });
    const b = makeNode({ id: 'b', parentId: 'p', dependencies: fs('a') });
    const r = explainBlockedParent(p, toMap([p, a, b]));
    expect(r.blockedLeafIds).toEqual(['a', 'b']);
    expect(r.rootCauses.length).toBeGreaterThan(0);
  });
});
