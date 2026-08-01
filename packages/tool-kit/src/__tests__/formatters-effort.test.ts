/**
 * Bug 5e2d8930 — null-estimate leaves were silently dropping the effort
 * field entirely, so planners couldn't tell unestimated leaves apart from
 * leaves with an explicit zero. We now show `effort: —` for null leaves
 * and `effort: N` (even 0) for leaves that have been estimated.
 */

import { describe, it, expect } from 'vitest';
import { formatMapTree } from '../formatters.js';
import type { MapDetail, NodeWithComputed } from '../types.js';

function stubNode(overrides: Partial<NodeWithComputed> = {}): NodeWithComputed {
  return {
    id: 'n',
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: 'stub',
    description: null,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
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
    createdAt: '2026-06-10T10:00:00Z',
    updatedAt: '2026-06-10T10:00:00Z',
    claimedBySession: null,
    claimedAt: null,
    computedEffort: 0,
    computedProgress: 0,
    healthSignal: 'on_track',
    ...overrides,
  } as NodeWithComputed;
}

function detailWith(nodes: NodeWithComputed[]): MapDetail {
  return {
    map: {
      id: 'm1',
      workspaceId: 'ws1',
      name: 'Test Map',
      description: null,
      rootNodeId: 'root',
      effortUnit: 'hours',
      healthThreshold: 0.2,
      computedProgress: 0,
      healthSignal: 'on_track',
      createdAt: '2026-06-10T10:00:00Z',
      updatedAt: '2026-06-10T10:00:00Z',
      statusWorkflow: [],
      baselines: [],
      wipLimit: null,
    },
    nodes,
  };
}

describe('formatMapTree — leaf effort rendering', () => {
  const root = stubNode({
    id: 'root',
    text: 'Root',
    childrenIds: ['nullLeaf', 'zeroLeaf', 'estLeaf'],
    computedEffort: 5,
  });
  const nullLeaf = stubNode({
    id: 'nullLeaf',
    parentId: 'root',
    text: 'unestimated',
    effortEstimate: null,
    computedEffort: 0,
  });
  const zeroLeaf = stubNode({
    id: 'zeroLeaf',
    parentId: 'root',
    text: 'explicit zero',
    effortEstimate: 0,
    computedEffort: 0,
  });
  const estLeaf = stubNode({
    id: 'estLeaf',
    parentId: 'root',
    text: 'has-an-estimate',
    effortEstimate: 5,
    computedEffort: 5,
  });

  const out = formatMapTree(detailWith([root, nullLeaf, zeroLeaf, estLeaf]));
  const line = (substr: string) => out.split('\n').find((l) => l.includes(substr))!;

  it('renders null-estimate leaves as `effort: —`', () => {
    expect(line('unestimated')).toContain('effort: —');
  });

  it('renders explicit-zero leaves as `effort: 0` (distinct from null)', () => {
    expect(line('explicit zero')).toContain('effort: 0');
    expect(line('explicit zero')).not.toContain('effort: —');
  });

  it('renders estimated leaves as `effort: N`', () => {
    expect(line('has-an-estimate')).toContain('effort: 5');
  });

  it('still hides effort on parents when computedEffort is 0', () => {
    // Parent rendering is unchanged by this fix; only leaves got the
    // null vs zero disambiguation.
    const allNull = stubNode({
      id: 'p',
      text: 'parent-with-nulls',
      childrenIds: ['c'],
      computedEffort: 0,
    });
    const child = stubNode({ id: 'c', parentId: 'p', text: 'inner', effortEstimate: null });
    const det = detailWith([
      stubNode({ id: 'root', text: 'R', childrenIds: ['p'], computedEffort: 0 }),
      allNull,
      child,
    ]);
    const text = formatMapTree(det);
    const parentLine = text.split('\n').find((l) => l.includes('parent-with-nulls'))!;
    expect(parentLine).not.toMatch(/effort:/);
  });
});
