/**
 * #655 — parked branches: kept in the map, left out of the rollup totals,
 * the schedule, the export's timeline and the fleet's pull.
 */
import { describe, it, expect } from 'vitest';
import { computeEffort, computeProgress, computeTree, computeParkedEffort, computeHealth } from '../compute.js';
import { parkedNodeIds, withoutParked } from '../parked.js';
import { dispatchHold, PARKED_HOLD_TAG } from '../dispatch.js';
import { schedule } from '../dependencies.js';
import { renderTimelineMarkdown, timelineLater, timelineMilestones } from '../timelineExport.js';
import type { Node, NodeMap, StatusDef } from '../types.js';

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    mapId: 'map-1',
    parentId: null,
    childrenIds: [],
    text: id,
    description: null,
    x: null,
    y: null,
    collapsed: false,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: 'todo',
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
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'u1',
    reportedBy: null,
    approval: { state: 'approved', merge: 'auto', by: null, at: '2026-01-01T00:00:00Z' },
    revision: 1,
    deletedAt: null,
    ...over,
  };
}

/**
 * root ─ M5 ─ a (5d, 50%), b (3d)
 *      └ M6 (parked) ─ c (10d), d (2d, blocked)
 */
function tree(): Node[] {
  return [
    node('root', { childrenIds: ['m5', 'm6'] }),
    node('m5', { parentId: 'root', childrenIds: ['a', 'b'], text: 'M5' }),
    node('a', { parentId: 'm5', effortEstimate: 5, percentComplete: 50 }),
    node('b', { parentId: 'm5', effortEstimate: 3, dependencies: [{ targetNodeId: 'a', type: 'FS', lag: 0 }] }),
    node('m6', { parentId: 'root', childrenIds: ['c', 'd'], text: 'M6', parked: true }),
    node('c', { parentId: 'm6', effortEstimate: 10, dependencies: [{ targetNodeId: 'b', type: 'FS', lag: 0 }] }),
    node('d', { parentId: 'm6', effortEstimate: 2, blockedReason: 'waiting', dueDate: '2020-01-01' }),
  ];
}

const toMap = (nodes: Node[]): NodeMap => new Map(nodes.map((n) => [n.id, n]));

describe('rollups', () => {
  it('leaves a parked branch out of the parent total and reports it separately', () => {
    const m = toMap(tree());
    expect(computeEffort(m.get('root')!, m)).toBe(8);
    expect(computeParkedEffort(m.get('root')!, m)).toBe(12);
    // The parked branch's own totals count everything in it.
    expect(computeEffort(m.get('m6')!, m)).toBe(12);
    expect(computeParkedEffort(m.get('m6')!, m)).toBe(0);
  });

  it('progress and health ignore the parked branch', () => {
    const m = toMap(tree());
    // 5×50% / 8 = 31.25%, not diluted by the 12 parked days.
    expect(computeProgress(m.get('root')!, m)).toBeCloseTo(31.25);
    // d is overdue, but parked — it does not make the root behind.
    expect(computeHealth(m.get('root')!, m)).toBe('on_track');
    expect(computeHealth(m.get('m6')!, m)).toBe('behind');
  });

  it('computeTree carries parkedEffort and keeps the blocked count to planned work', () => {
    const cv = computeTree(tree());
    expect(cv.get('root')!.computedEffort).toBe(8);
    expect(cv.get('root')!.parkedEffort).toBe(12);
    // b waits on a; the blocked parked leaf d is not counted.
    expect(cv.get('root')!.blockedBy.blockedDescendantCount).toBe(1);
    expect(cv.get('m5')!.parkedEffort).toBe(0);
  });

  it('a parked branch nested under a non-parked node inside a parked branch still counts there', () => {
    const nodes = [
      node('p', { childrenIds: ['g'], parked: true }),
      node('g', { parentId: 'p', childrenIds: ['x', 'y'] }),
      node('x', { parentId: 'g', effortEstimate: 1 }),
      node('y', { parentId: 'g', effortEstimate: 4, parked: true }),
    ];
    const m = toMap(nodes);
    expect(computeEffort(m.get('p')!, m)).toBe(5);
  });
});

describe('scheduling', () => {
  it('parkedNodeIds covers the parked node and its whole subtree', () => {
    expect([...parkedNodeIds(tree())].sort()).toEqual(['c', 'd', 'm6']);
  });

  it('withoutParked prunes the branch, the child ids and dependencies into it', () => {
    const nodes = tree();
    nodes.find((n) => n.id === 'b')!.dependencies.push({ targetNodeId: 'c', type: 'FS', lag: 0 });
    const planned = withoutParked(nodes);
    expect(planned.map((n) => n.id)).toEqual(['root', 'm5', 'a', 'b']);
    expect(planned.find((n) => n.id === 'root')!.childrenIds).toEqual(['m5']);
    expect(planned.find((n) => n.id === 'b')!.dependencies.map((d) => d.targetNodeId)).toEqual(['a']);
  });

  it('the total duration ends with the planned work', () => {
    const all = schedule(tree());
    const planned = schedule(withoutParked(tree()));
    const end = (s: typeof all) => Math.max(...s.map((x) => x.computedEnd));
    expect(end(all)).toBeGreaterThan(end(planned));
    // a (5d, half done → 2.5 left) then b (3d).
    expect(planned.find((s) => s.nodeId === 'root')!.computedEnd).toBe(end(planned));
    expect(planned.some((s) => ['m6', 'c', 'd'].includes(s.nodeId))).toBe(false);
  });

  it('returns the same array when nothing is parked', () => {
    const nodes = tree().map((n) => ({ ...n, parked: false }));
    expect(withoutParked(nodes)).toBe(nodes);
  });
});

describe('dispatch', () => {
  const isDone = (s: string | null) => s === 'done';

  it('a parked node is held like a skip tag', () => {
    const hold = dispatchHold(node('x', { parked: true }));
    expect(hold?.tag).toBe(PARKED_HOLD_TAG);
    expect(hold?.heldBy).toBeNull();
  });

  it('a parked open ancestor holds its whole subtree', () => {
    const m = toMap(tree());
    const hold = dispatchHold(m.get('c')!, { nodeMap: m, isDone });
    expect(hold).toMatchObject({ tag: PARKED_HOLD_TAG, heldBy: { id: 'm6', text: 'M6' } });
    expect(dispatchHold(m.get('a')!, { nodeMap: m, isDone })).toBeNull();
  });

  it('a skip tag on the node still names the skip tag', () => {
    expect(dispatchHold(node('x', { parked: true, tags: ['needs-human'] }))?.tag).toBe('needs-human');
  });
});

describe('timeline export', () => {
  const statusWorkflow: StatusDef[] = [
    { id: 'todo', name: 'To do', color: '#000', category: 'todo', position: 0 },
    { id: 'done', name: 'Done', color: '#000', category: 'done', position: 1 },
  ];
  const input = () => ({
    mapName: 'Loke-Support',
    nodes: tree(),
    statusWorkflow,
    rootNodeId: 'root',
    spans: new Map([
      ['root', { start: '2026-11-19', end: '2026-11-24' }],
      ['m5', { start: '2026-11-19', end: '2026-11-24' }],
    ]),
    generatedAt: new Date('2026-11-19T08:00:00Z'),
  });

  it('lists parked branches under "Later", not as milestones', () => {
    expect(timelineMilestones(input()).map((m) => m.node.id)).toEqual(['m5']);
    expect(timelineLater(input()).map((n) => n.id)).toEqual(['m6']);
    const md = renderTimelineMarkdown(input());
    const later = md.slice(md.indexOf('## Later'));
    expect(md).toContain('## Later');
    expect(later).toContain('- M6');
    expect(later).not.toMatch(/\d{4}/); // no dates
    expect(md).not.toContain('| M6 |');
    expect(md).toContain('projected end Tue 24 Nov 2026');
  });

  it('a parked leaf deeper in a milestone moves to "Later" too', () => {
    const nodes = tree();
    nodes.find((n) => n.id === 'm6')!.parked = false;
    nodes.find((n) => n.id === 'd')!.parked = true;
    const i = { ...input(), nodes };
    expect(timelineLater(i).map((n) => n.id)).toEqual(['d']);
    const m6 = timelineMilestones(i).find((m) => m.node.id === 'm6')!;
    expect(m6.waiting).toEqual([]);
    expect(m6.open.map((n) => n.id)).toEqual(['c']);
  });

  it('exporting a parked branch itself shows its content, no "Later" section', () => {
    const i = { ...input(), rootNodeId: 'm6' };
    expect(timelineLater(i)).toEqual([]);
    expect(timelineMilestones(i).map((m) => m.node.id)).toEqual(['c', 'd']);
  });
});
