/**
 * Dispatch per milestone (#675) — the pull's decision core.
 *
 * An earlier milestone's tickets go out before a later one's (the
 * `milestone` policy key, default on a map planned in milestones), and
 * `milestone:current` holds a later milestone back until the earlier one
 * has no work an agent can do.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Node as CoreNode, PhaseDef, StatusDef } from '@mindblown/core';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { selectPullCandidates } from '../orchestration.js';

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
];

let seq = 0;
function node(p: Partial<CoreNode> & { id: string }): CoreNode {
  seq += 1;
  return {
    approval: { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' },
    mapId: 'map-1',
    parentId: 'root',
    childrenIds: [],
    text: `Node ${p.id}`,
    description: `Brief for ${p.id}`,
    effortEstimate: null,
    status: null,
    blockedReason: null,
    priority: null,
    priorityRank: null,
    tags: [],
    dependencies: [],
    versionId: null,
    phaseId: null,
    externalLinks: [],
    claimedBySession: null,
    claimedAt: null,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...p,
  } as CoreNode;
}

/**
 * root → M1 (m1a, m1b), M2 (m2a). M2's ticket is the OLDEST, so "age" alone
 * would hand it out first.
 */
function rootMilestones(over: Partial<Record<'m1a' | 'm1b' | 'm2a', Partial<CoreNode>>> = {}): CoreNode[] {
  const m2a = node({ id: 'm2a', parentId: 'm2', ...over.m2a });
  return [
    node({ id: 'root', parentId: null, childrenIds: ['m1', 'm2'], description: null, text: 'Loke-Support' }),
    node({ id: 'm1', childrenIds: ['m1a', 'm1b'], text: 'M1 test VM' }),
    node({ id: 'm2', childrenIds: ['m2a'], text: 'M2 pilot' }),
    m2a,
    node({ id: 'm1a', parentId: 'm1', ...over.m1a }),
    node({ id: 'm1b', parentId: 'm1', ...over.m1b }),
  ];
}

function pull(nodes: CoreNode[], opts: { gate?: string[]; policy?: string[]; phases?: PhaseDef[] } = {}) {
  return selectPullCandidates(nodes, {
    workflow: WORKFLOW,
    cap: 10,
    gate: opts.gate ?? [],
    policy: opts.policy ?? [],
    phases: opts.phases ?? [],
  });
}

const ids = (d: ReturnType<typeof pull>) => d.ranked.map((n) => n.id);

describe('milestone policy key', () => {
  it("hands out M1's tickets before M2's on a map whose root children are milestones (default policy)", () => {
    expect(ids(pull(rootMilestones()))).toEqual(['m1a', 'm1b', 'm2a']);
  });

  it('the same with phases instead of root children', () => {
    const phases: PhaseDef[] = [
      { id: 'p2', name: 'Pilot', position: 2 },
      { id: 'p1', name: 'Foundation', position: 1 },
    ];
    // Root children named for function, not milestones: the phases decide.
    const nodes = [
      node({ id: 'root', parentId: null, childrenIds: ['ui', 'api'], description: null }),
      node({ id: 'ui', childrenIds: ['late', 'early'], text: 'Frontend' }),
      node({ id: 'api', childrenIds: ['inherits'], text: 'Backend', phaseId: 'p1' }),
      node({ id: 'late', parentId: 'ui', phaseId: 'p2' }),
      node({ id: 'early', parentId: 'ui', phaseId: 'p1' }),
      node({ id: 'inherits', parentId: 'api' }),
      node({ id: 'nophase', parentId: 'ui' }),
    ];
    nodes[1] = { ...nodes[1], childrenIds: ['late', 'early', 'nophase'] };
    expect(ids(pull(nodes, { phases }))).toEqual(['early', 'inherits', 'late', 'nophase']);
  });

  it('without milestones in the map or the policy, age decides as before', () => {
    const nodes = rootMilestones();
    nodes[1] = { ...nodes[1], text: 'Frontend' };
    nodes[2] = { ...nodes[2], text: 'Backend' };
    expect(ids(pull(nodes))).toEqual(['m2a', 'm1a', 'm1b']);
    // An explicit milestone key ranks by root children all the same.
    expect(ids(pull(nodes, { policy: ['milestone', 'age'] }))).toEqual(['m1a', 'm1b', 'm2a']);
  });

  it('bugs and P0/P1 still come first when they are ahead of milestone in the policy', () => {
    expect(ids(pull(rootMilestones({ m2a: { tags: ['bug'] } })))[0]).toBe('m2a');
    expect(ids(pull(rootMilestones({ m2a: { priority: 'P1' } })))[0]).toBe('m2a');
    // …and not when milestone is ahead of them.
    expect(ids(pull(rootMilestones({ m2a: { tags: ['bug'] } }), { policy: ['milestone', 'bugs', 'age'] }))[0]).toBe('m1a');
  });
});

describe('milestone:current gate', () => {
  const gate = ['milestone:current'];

  it("does not hand out M2 while M1 has pullable leaves, and says what it waits for", () => {
    const d = pull(rootMilestones({ m2a: { tags: ['bug'] } }), { gate });
    expect(ids(d)).toEqual(['m1a', 'm1b']);
    expect(d.milestoneWait?.current.name).toBe('M1 test VM');
    expect(d.milestoneWait?.nodes.map((n) => n.id)).toEqual(['m2a']);
  });

  it('hands out M2 once every remaining M1 leaf is held (needs-human, blocker, approval)', () => {
    const d = pull(
      rootMilestones({
        m1a: { tags: ['needs-human'] },
        m1b: { blockedReason: 'Waiting on the customer VM' },
      }),
      { gate },
    );
    expect(ids(d)).toEqual(['m2a']);
    expect(d.milestoneWait).toBeUndefined();
    expect(d.humanOnly.map((h) => h.node.id).sort()).toEqual(['m1a', 'm1b']);
  });

  it('keeps M2 back while an agent is still running on M1', () => {
    const d = pull(rootMilestones({ m1a: { claimedBySession: 'w1', status: 'in_progress' }, m1b: { status: 'done' } }), { gate });
    expect(ids(d)).toEqual([]);
    expect(d.milestoneWait?.nodes.map((n) => n.id)).toEqual(['m2a']);
  });

  it('a parked M1 branch stays out (#655) and does not hold the gate', () => {
    const nodes = rootMilestones();
    nodes[1] = { ...nodes[1], parked: true };
    const d = pull(nodes, { gate });
    expect(ids(d)).toEqual(['m2a']);
  });
});
