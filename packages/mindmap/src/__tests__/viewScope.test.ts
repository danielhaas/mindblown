import { describe, it, expect, beforeEach } from 'vitest';
import { computeTree } from '@mindblown/core';
import type { Node } from '@mindblown/core';
import { selectHillBranches, computeWorkloads } from '../viewScope.js';

// The store module reads localStorage at import time (auth-token bootstrap);
// shim it for the node test environment BEFORE the dynamic import below.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

const { useMindmapStore } = await import('../store.js');

/**
 * How HillChart/WorkloadView call the store's scope walk: only the
 * version/sprint filter applies; drill-down focus, depth limit, and
 * collapse state must NOT cut the aggregate views' data basis.
 */
const SCOPE_ONLY = { respectFocus: false, respectDepth: false, respectCollapsed: false } as const;

// ── Fixtures ─────────────────────────────────────────────────────

function makeNode(id: string, parentId: string | null, overrides: Partial<Node> = {}): Node {
  return {
    id,
    mapId: 'm1',
    parentId,
    childrenIds: [],
    text: id,
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
    priorityRank: null,
    completedAt: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    linkedPr: null,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    autoProgress: 'off',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    revision: 1,
    deletedAt: null,
    ...overrides,
  } as Node;
}

/**
 * Tree:
 *   root
 *   ├─ epicA (versionId v1)
 *   │   ├─ a1  leaf — no own tag → inherits v1; alice, 5h, todo
 *   │   └─ a2  leaf — versionId v2 (overrides); bob, 3h, in_progress
 *   └─ epicB (untagged)
 *       ├─ b1  leaf — versionId v1, cycleId c1; alice, 2h, done
 *       └─ b2  leaf — untagged; bob, 8h, todo
 */
function buildFixture(): Record<string, Node> {
  const nodes: Record<string, Node> = {
    root: makeNode('root', null, { childrenIds: ['epicA', 'epicB'] }),
    epicA: makeNode('epicA', 'root', {
      childrenIds: ['a1', 'a2'],
      versionId: 'v1',
      customFields: { hillPosition: 30 },
    }),
    epicB: makeNode('epicB', 'root', { childrenIds: ['b1', 'b2'] }),
    a1: makeNode('a1', 'epicA', { assigneeIds: ['alice'], effortEstimate: 5 }),
    a2: makeNode('a2', 'epicA', {
      versionId: 'v2',
      assigneeIds: ['bob'],
      effortEstimate: 3,
      status: 'in_progress',
    }),
    b1: makeNode('b1', 'epicB', {
      versionId: 'v1',
      cycleId: 'c1',
      assigneeIds: ['alice'],
      effortEstimate: 2,
      status: 'done',
      percentComplete: 100,
    }),
    b2: makeNode('b2', 'epicB', { assigneeIds: ['bob'], effortEstimate: 8 }),
  };
  return nodes;
}

function setStoreState(overrides: Record<string, unknown> = {}) {
  const nodes = buildFixture();
  useMindmapStore.setState({
    nodes,
    rootNodeId: 'root',
    computed: computeTree(Object.values(nodes)),
    focusNodeId: null,
    focusHistory: [],
    maxDepth: 0,
    activeVersionFilter: null,
    activeCycleFilter: null,
  });
  if (Object.keys(overrides).length > 0) {
    useMindmapStore.setState(overrides);
  }
}

/** Patch one fixture node in place (e.g. flip `collapsed`). */
function patchNode(id: string, patch: Partial<Node>) {
  const nodes = useMindmapStore.getState().nodes;
  useMindmapStore.setState({ nodes: { ...nodes, [id]: { ...nodes[id], ...patch } } });
}

const scopeIds = () =>
  useMindmapStore
    .getState()
    .getVisibleNodes(SCOPE_ONLY)
    .map((v) => v.node.id);

const hillBranchIds = () =>
  selectHillBranches(
    useMindmapStore.getState().getVisibleNodes(SCOPE_ONLY),
    useMindmapStore.getState().computed,
  ).map((b) => b.node.id);

const workflow = [
  { id: 'todo', name: 'To Do', category: 'todo' },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress' },
  { id: 'done', name: 'Done', category: 'done' },
];

const workloadsNow = () =>
  computeWorkloads(useMindmapStore.getState().getVisibleNodes(SCOPE_ONLY), workflow);

describe('scope-only getVisibleNodes as the data basis for HillChart/WorkloadView', () => {
  beforeEach(() => setStoreState());

  it('without filters, every node is in scope', () => {
    expect(scopeIds().sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'epicA', 'epicB', 'root']);
  });

  it('active version filter keeps only nodes of that version, incl. scope inheritance and connecting ancestors', () => {
    useMindmapStore.setState({ activeVersionFilter: 'v1' });
    // a1 inherits v1 from epicA; a2 overrides with v2 → out.
    // b1 is tagged v1 directly; epicB survives only as its connecting ancestor; b2 → out.
    expect(scopeIds().sort()).toEqual(['a1', 'b1', 'epicA', 'epicB', 'root']);
  });

  describe('HillChart branch selection', () => {
    it('shows all top-level branches without filters', () => {
      const branches = selectHillBranches(
        useMindmapStore.getState().getVisibleNodes(SCOPE_ONLY),
        useMindmapStore.getState().computed,
      );
      expect(branches.map((b) => b.node.id)).toEqual(['epicA', 'epicB']);
      expect(branches[0].hillPosition).toBe(30); // customFields passthrough
      expect(branches[1].hillPosition).toBe(0); // default
      // Aggregates come from computeTree, over the branch subtree
      expect(branches[0].computed.computedEffort).toBe(8); // a1 5h + a2 3h
    });

    it('drops branches outside the active version filter', () => {
      useMindmapStore.setState({ activeVersionFilter: 'v2' });
      // Only epicA contains a v2 node (a2); epicB has none.
      expect(hillBranchIds()).toEqual(['epicA']);
    });

    it('drops branches outside the active cycle filter', () => {
      useMindmapStore.setState({ activeCycleFilter: 'c1' });
      // Only b1 is in sprint c1 → epicB survives as its ancestor branch.
      expect(hillBranchIds()).toEqual(['epicB']);
    });

    it('keeps showing the root branches under drill-down focus, depth limit, and collapse', () => {
      useMindmapStore.setState({ focusNodeId: 'epicA', maxDepth: 1 });
      patchNode('epicA', { collapsed: true });
      // Unchanged: the hill is root-branch level regardless of drill-down state.
      expect(hillBranchIds()).toEqual(['epicA', 'epicB']);
    });
  });

  describe('Workload aggregation', () => {
    it('aggregates all assigned leaves without filters', () => {
      const w = workloadsNow();
      expect(w.map((x) => x.assigneeId)).toEqual(['bob', 'alice']); // sorted by total desc
      const bob = w.find((x) => x.assigneeId === 'bob')!;
      expect(bob.total).toBe(11); // a2 3h + b2 8h
      const alice = w.find((x) => x.assigneeId === 'alice')!;
      expect(alice).toMatchObject({ todo: 5, inProgress: 0, done: 2, total: 7 });
    });

    it('with an active version filter, only leaves of that version contribute (incl. inheritance)', () => {
      useMindmapStore.setState({ activeVersionFilter: 'v1' });
      const w = workloadsNow();
      // bob's leaves (a2: v2, b2: untagged) are out of scope entirely.
      expect(w.map((x) => x.assigneeId)).toEqual(['alice']);
      // a1 (5h, inherits v1 from epicA) + b1 (2h, tagged v1 directly)
      expect(w[0]).toMatchObject({ todo: 5, inProgress: 0, done: 2, total: 7 });
      // The surviving ancestor epicB must not contribute (it is no leaf).
      expect(
        w.flatMap((x) => x.tasksByStatus.flatMap((g) => g.nodes.map((n) => n.id))).sort(),
      ).toEqual(['a1', 'b1']);
    });

    it('with an active cycle filter, only leaves of that sprint contribute', () => {
      useMindmapStore.setState({ activeCycleFilter: 'c1' });
      const w = workloadsNow();
      expect(w.map((x) => x.assigneeId)).toEqual(['alice']);
      expect(w[0]).toMatchObject({ todo: 0, inProgress: 0, done: 2, total: 2 });
    });

    it('keeps aggregating ALL leaves under drill-down focus, depth limit, and collapse', () => {
      useMindmapStore.setState({ focusNodeId: 'epicA', maxDepth: 1 });
      patchNode('epicB', { collapsed: true });
      const w = workloadsNow();
      // Unchanged from the unfiltered case: deep, collapsed, or out-of-focus
      // leaves must not vanish from the workload bars.
      expect(w.map((x) => x.assigneeId)).toEqual(['bob', 'alice']);
      expect(w.find((x) => x.assigneeId === 'bob')!.total).toBe(11);
      expect(w.find((x) => x.assigneeId === 'alice')!.total).toBe(7);
    });
  });

  describe('default getVisibleNodes() semantics stay intact for existing callers', () => {
    it('respects maxDepth by default', () => {
      useMindmapStore.setState({ maxDepth: 1 });
      const ids = useMindmapStore
        .getState()
        .getVisibleNodes()
        .map((v) => v.node.id)
        .sort();
      expect(ids).toEqual(['epicA', 'epicB', 'root']); // leaves cut at depth 1
    });

    it('respects collapse by default', () => {
      patchNode('epicA', { collapsed: true });
      const ids = useMindmapStore
        .getState()
        .getVisibleNodes()
        .map((v) => v.node.id)
        .sort();
      expect(ids).toEqual(['b1', 'b2', 'epicA', 'epicB', 'root']); // a1/a2 hidden
    });

    it('respects drill-down focus by default (incl. dimmed context siblings)', () => {
      useMindmapStore.setState({ focusNodeId: 'epicA' });
      const vns = useMindmapStore.getState().getVisibleNodes();
      expect(
        vns
          .filter((v) => !v.isDimmed)
          .map((v) => v.node.id)
          .sort(),
      ).toEqual(['a1', 'a2', 'epicA']);
      expect(vns.filter((v) => v.isDimmed).map((v) => v.node.id)).toEqual(['epicB']);
    });
  });
});
