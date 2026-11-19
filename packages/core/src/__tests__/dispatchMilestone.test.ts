/**
 * Dispatch per milestone (#675): which milestone a node belongs to, the
 * default policy on a map planned in milestones, and the
 * `milestone:current` fence the cockpit snapshot shares with the server.
 */
import { describe, it, expect } from 'vitest';
import type { Node, PhaseDef, StatusDef } from '../types.js';
import {
  DEFAULT_DISPATCH_POLICY,
  GATE_MILESTONE_CURRENT,
  PHASED_DISPATCH_POLICY,
  defaultDispatchPolicy,
  dispatchQueueSnapshot,
  hasMilestoneRoots,
  matchesDispatchGate,
  milestoneFence,
  milestoneOrder,
  parseGateEntry,
} from '../dispatch.js';

const APPROVED = { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' } as const;

function n(p: Partial<Node> & { id: string }): Node {
  return {
    approval: APPROVED,
    mapId: 'm',
    parentId: 'root',
    childrenIds: [],
    text: p.id,
    description: null,
    effortEstimate: null,
    status: null,
    blockedReason: null,
    tags: [],
    dependencies: [],
    versionId: null,
    phaseId: null,
    claimedBySession: null,
    claimedAt: null,
    externalLinks: [{ provider: 'github', externalId: `#${p.id}`, url: 'https://github.com/o/r/issues/1' }],
    ...p,
  } as unknown as Node;
}

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'To do', category: 'todo', color: '#000', position: 0 },
  { id: 'in_progress', name: 'Doing', category: 'in_progress', color: '#000', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 2 },
];

/** root → M1 (a, b), M2 (c), in that tree order. */
function rootMap(extra: { a?: Partial<Node>; b?: Partial<Node>; c?: Partial<Node> } = {}): Node[] {
  return [
    n({ id: 'root', parentId: null, childrenIds: ['m1', 'm2'], text: 'Loke' }),
    n({ id: 'm1', childrenIds: ['a', 'b'], text: 'M1 test VM' }),
    n({ id: 'm2', childrenIds: ['c'], text: 'M2 pilot' }),
    n({ id: 'a', parentId: 'm1', ...extra.a }),
    n({ id: 'b', parentId: 'm1', ...extra.b }),
    n({ id: 'c', parentId: 'm2', ...extra.c }),
  ];
}

const PHASES: PhaseDef[] = [
  { id: 'p-late', name: 'M2 – Pilot', position: 2 },
  { id: 'p-early', name: 'M1 – Foundation', position: 1 },
];

describe('milestoneOrder', () => {
  it('without phases: the root child a node sits under, in tree order; the root has none', () => {
    const of = milestoneOrder(rootMap(), []);
    expect(of('a')).toEqual({ rank: 0, name: 'M1 test VM' });
    expect(of('m2')).toEqual({ rank: 1, name: 'M2 pilot' });
    expect(of('c')).toEqual({ rank: 1, name: 'M2 pilot' });
    expect(of('root')).toBeNull();
  });

  it('with phases: own or inherited phaseId, ranked by position; no phase = none', () => {
    const nodes = [
      n({ id: 'root', parentId: null, childrenIds: ['x', 'y', 'z'] }),
      n({ id: 'x', childrenIds: ['x1'], phaseId: 'p-late' }),
      n({ id: 'x1', parentId: 'x' }),
      n({ id: 'y', phaseId: 'p-early' }),
      n({ id: 'z', phaseId: 'gone' }),
    ];
    const of = milestoneOrder(nodes, PHASES);
    expect(of('x1')).toEqual({ rank: 1, name: 'M2 – Pilot' });
    expect(of('y')).toEqual({ rank: 0, name: 'M1 – Foundation' });
    expect(of('z')).toBeNull();
    expect(of('root')).toBeNull();
  });
});

describe('defaultDispatchPolicy', () => {
  it('adds milestone on a map with phases or milestone-shaped roots, not otherwise', () => {
    expect(defaultDispatchPolicy([])).toEqual(DEFAULT_DISPATCH_POLICY);
    expect(defaultDispatchPolicy(PHASES)).toEqual(PHASED_DISPATCH_POLICY);
    expect(PHASED_DISPATCH_POLICY).toEqual(['bugs', 'priority', 'milestone', 'age']);
    expect(defaultDispatchPolicy([], rootMap())).toEqual(PHASED_DISPATCH_POLICY);
  });

  it('functional root children are not milestones', () => {
    const nodes = [
      n({ id: 'root', parentId: null, childrenIds: ['f1', 'f2', 'f3'] }),
      n({ id: 'f1', text: 'Frontend' }),
      n({ id: 'f2', text: 'Backend' }),
      n({ id: 'f3', text: 'M1 spike' }),
    ];
    expect(hasMilestoneRoots(nodes)).toBe(false);
    expect(defaultDispatchPolicy([], nodes)).toEqual(DEFAULT_DISPATCH_POLICY);
  });
});

describe('milestone:current gate entry', () => {
  it('parses on its own and passes the per-node gate (the fence applies it)', () => {
    expect(parseGateEntry(GATE_MILESTONE_CURRENT).kind).toBe('milestone');
    const nodes = rootMap();
    const map = new Map(nodes.map((x) => [x.id, x]));
    expect(matchesDispatchGate(nodes[5], [GATE_MILESTONE_CURRENT], map)).toBe(true);
  });
});

describe('milestoneFence', () => {
  const gate = [GATE_MILESTONE_CURRENT];

  it('no gate entry: nothing waits', () => {
    const f = milestoneFence(rootMap(), { workflow: WORKFLOW, gate: [] });
    expect(f.current).toBeNull();
    expect(f.waits('c')).toBe(false);
  });

  it('M2 waits while M1 has ready work', () => {
    const f = milestoneFence(rootMap(), { workflow: WORKFLOW, gate });
    expect(f.current?.name).toBe('M1 test VM');
    expect(f.waits('c')).toBe(true);
    expect(f.waits('a')).toBe(false);
  });

  it('a leaf an agent is running on keeps M1 current', () => {
    const f = milestoneFence(
      rootMap({ a: { claimedBySession: 'w1', status: 'in_progress' }, b: { status: 'done' } }),
      { workflow: WORKFLOW, gate },
    );
    expect(f.current?.name).toBe('M1 test VM');
    expect(f.waits('c')).toBe(true);
  });

  it('M1 held for people (needs-human, blocker, no brief, dependency) moves the gate to M2', () => {
    const f = milestoneFence(
      rootMap({
        a: { tags: ['needs-human'] },
        b: { dependencies: [{ targetNodeId: 'c', type: 'FS', lag: 0 }] },
      }),
      { workflow: WORKFLOW, gate },
    );
    expect(f.current?.name).toBe('M2 pilot');
    expect(f.waits('c')).toBe(false);

    const g = milestoneFence(rootMap({ a: { blockedReason: 'waits for the VM' }, b: { externalLinks: [] } }), { workflow: WORKFLOW, gate });
    expect(g.current?.name).toBe('M2 pilot');
  });

  it("a worker's claim waiting on PR review does not keep the milestone", () => {
    const f = milestoneFence(
      rootMap({
        a: { claimedBySession: 'w1', status: 'in_progress', blockedReason: 'Fleet worker abc: PR #9 waits for review' },
        b: { status: 'done' },
      }),
      { workflow: WORKFLOW, gate },
    );
    expect(f.current?.name).toBe('M2 pilot');
  });

  it('a parked M1 branch stays out (#655): M2 is current', () => {
    const nodes = rootMap();
    nodes[1] = { ...nodes[1], parked: true } as Node;
    const f = milestoneFence(nodes, { workflow: WORKFLOW, gate });
    expect(f.current?.name).toBe('M2 pilot');
  });
});

describe('dispatchQueueSnapshot with milestone:current', () => {
  it('counts the later milestone as waiting, not grantable, and names the current one', () => {
    const s = dispatchQueueSnapshot(rootMap(), { workflow: WORKFLOW, cap: 3, gate: [GATE_MILESTONE_CURRENT] });
    expect(s.inGateIds.sort()).toEqual(['a', 'b']);
    expect(s.milestoneWaiting).toBe(1);
    expect(s.currentMilestone).toBe('M1 test VM');
  });

  it('without the entry nothing waits', () => {
    const s = dispatchQueueSnapshot(rootMap(), { workflow: WORKFLOW, cap: 3, gate: [] });
    expect(s.inGate).toBe(3);
    expect(s.milestoneWaiting).toBe(0);
    expect(s.currentMilestone).toBeNull();
  });
});
