import type { Node, ComputedNodeValues } from '@mindblown/core';

/**
 * Pure selection helpers for the secondary views (Hill Chart, Workload).
 *
 * Both views used to read the raw `s.nodes` record and therefore ignored
 * the active version / sprint filters entirely (filter chip visible, view
 * still showing everything). They now consume the output of
 * `getVisibleNodes({ respectFocus: false, respectDepth: false,
 * respectCollapsed: false })` — the store's ONE scope walk with only the
 * version/sprint filter applied (incl. tag inheritance + ancestor
 * connect), while drill-down focus, depth limit, and collapse state keep
 * NOT affecting these aggregate views, exactly as before the filter fix.
 * Kept as pure functions (no store import) so they are unit-testable
 * without a DOM or the zustand store machinery.
 */

/**
 * Structural subset of the store's `VisibleNode` that these helpers need.
 * The store's type satisfies it; tests can build it from `getVisibleNodes()`
 * or by hand.
 */
export interface ScopedVisibleNode {
  node: Node;
  depth: number; // relative to the effective root (drill-down focus or map root)
  isDimmed: boolean; // sibling branches shown only for drill-down context
}

// ── Hill Chart ───────────────────────────────────────────────────

export interface HillBranch {
  node: Node;
  computed: ComputedNodeValues;
  hillPosition: number; // 0-100, after the de-overlap pass
  /** True when nobody has dragged this dot — position came from progress. */
  isDerived: boolean;
  /** Rank along the hill (left to right), for staggering labels. */
  rank: number;
}

/**
 * Where a dot sits when nobody has ever dragged it.
 *
 * `hillPosition` is a manual, drag-only field, so on a map where it was
 * never touched every branch defaults to the same value and the dots pile
 * up in one blob at the left foot of the hill — the chart reads as broken.
 * Falling back to rolled-up progress spreads them along the arc the way
 * the metaphor already implies: uphill is the unresolved part, the peak is
 * "we know how to do this", downhill is execution. A drag still wins and
 * persists, which is what makes the manual field worth keeping.
 */
export function deriveHillPosition(computed: ComputedNodeValues): number {
  return clampPosition(computed.computedProgress);
}

function clampPosition(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Minimum spacing between two dots, in hill-position units.
 *
 * The chart maps 100 units onto ~680px, so 6 units ≈ 41px — enough to
 * keep two mid-sized dots from merging into one blob. Only derived dots
 * are moved to honour it (see `spreadDerived`).
 */
export const MIN_DOT_GAP = 6;

/**
 * Nudge auto-placed dots apart so clustered progress values stay readable.
 *
 * Manually dragged dots are anchors: they never move, because a dot the
 * user parked at 50 must stay at 50. Derived dots are free to slide, since
 * their exact position was already an inference. Runs left-to-right then
 * back, so a cluster that would overflow the right edge spills leftward
 * instead of stacking on 100.
 */
function spreadDerived(branches: HillBranch[], minGap: number): void {
  const order = [...branches].sort((a, b) => a.hillPosition - b.hillPosition);

  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1];
    const cur = order[i];
    if (cur.isDerived && cur.hillPosition < prev.hillPosition + minGap) {
      cur.hillPosition = clampPosition(prev.hillPosition + minGap);
    }
  }
  for (let i = order.length - 2; i >= 0; i--) {
    const next = order[i + 1];
    const cur = order[i];
    if (cur.isDerived && cur.hillPosition > next.hillPosition - minGap) {
      cur.hillPosition = clampPosition(next.hillPosition - minGap);
    }
  }

  order.forEach((b, i) => {
    b.rank = i;
  });
}

/**
 * Select the Hill Chart dots from the visible-node set.
 *
 * Depth 1 = direct children of the walk root (the map root, since the
 * view calls the scope walk with `respectFocus: false`). Nodes outside
 * the active version/sprint filter are already excluded from
 * `visibleNodes`, so the hill only shows in-scope branches; dimmed
 * context siblings are skipped defensively should a caller ever pass a
 * focus-aware set. Preserves the sibling order `getVisibleNodes()`
 * emits (= childrenIds order).
 */
export function selectHillBranches(
  visibleNodes: ScopedVisibleNode[],
  computed: Map<string, ComputedNodeValues>,
  minGap: number = MIN_DOT_GAP,
): HillBranch[] {
  const branches: HillBranch[] = [];
  for (const vn of visibleNodes) {
    if (vn.isDimmed || vn.depth !== 1) continue;
    const comp = computed.get(vn.node.id);
    if (!comp) continue;
    const manual = vn.node.customFields?.hillPosition;
    const isDerived = typeof manual !== 'number';
    branches.push({
      node: vn.node,
      computed: comp,
      hillPosition: isDerived ? deriveHillPosition(comp) : clampPosition(manual as number),
      isDerived,
      rank: 0,
    });
  }
  spreadDerived(branches, minGap);
  return branches;
}

// ── Workload ─────────────────────────────────────────────────────

export type StatusCategoryId = 'todo' | 'in_progress' | 'done';

export interface StatusWorkflowStep {
  id: string;
  name: string;
  category: string;
}

/** How a leaf got attributed to a person — weakest source wins last. */
export type WorkloadSource = 'assignee' | 'claim' | 'author';

/** Who last touched a node, keyed by node id. Empty when unavailable. */
export type NodeActors = ReadonlyMap<string, { userId: string; userName: string }>;

export interface AssigneeWorkload {
  assigneeId: string;
  /** Display name — the actor's name for authored work, else the raw id. */
  label: string;
  source: WorkloadSource;
  todo: number;
  inProgress: number;
  done: number;
  total: number;
  tasksByStatus: {
    status: StatusCategoryId;
    nodes: Node[];
  }[];
}

export function statusCategory(
  node: Node,
  statusWorkflow: StatusWorkflowStep[],
): StatusCategoryId {
  if (!node.status) return 'todo';
  const def = statusWorkflow.find((s) => s.id === node.status || s.name === node.status);
  if (def) return def.category as StatusCategoryId;

  // Fallback heuristics
  const lower = node.status.toLowerCase();
  if (lower === 'done' || lower === 'completed' || lower === 'closed') return 'done';
  if (lower === 'in_progress' || lower === 'in progress' || lower === 'active' || lower === 'doing') return 'in_progress';
  return 'todo';
}

/**
 * Who a leaf's effort should count against, strongest signal first.
 *
 * `assigneeIds` is the field the model intends for this, but nothing
 * writes it — there is no assignee editor in the UI and no MCP caller has
 * ever set one — and `claimedBySession` only holds a value while an agent
 * has work in flight. Grouping on those alone left the Workload view
 * permanently empty on every real map. Authorship from the change log is
 * the fallback that actually has data: whoever last edited a node is, in
 * practice, the person carrying it. Returns `[]` when nothing attributes
 * the leaf, so it drops out rather than landing in an "unknown" bucket.
 */
function attributionFor(
  leaf: Node,
  actors: NodeActors,
): Array<{ id: string; label: string; source: WorkloadSource }> {
  if (leaf.assigneeIds.length > 0) {
    return leaf.assigneeIds.map((id) => ({ id, label: id, source: 'assignee' as const }));
  }
  if (leaf.claimedBySession) {
    return [{ id: leaf.claimedBySession, label: leaf.claimedBySession, source: 'claim' }];
  }
  const actor = actors.get(leaf.id);
  if (actor) {
    return [{ id: actor.userId, label: actor.userName, source: 'author' }];
  }
  return [];
}

/**
 * Aggregate per-person effort from the leaf nodes of the visible set.
 *
 * A leaf is a node without children (raw `childrenIds`, same notion
 * CalendarView uses); dimmed drill-down context siblings are skipped.
 * Only leaves that survived the active version/sprint filter contribute,
 * so the Workload bars reflect the same scope the filter chip announces.
 * Attribution falls back through assignee → claim → author, see
 * `attributionFor`. Result is sorted by total effort descending.
 */
export function computeWorkloads(
  visibleNodes: ScopedVisibleNode[],
  statusWorkflow: StatusWorkflowStep[],
  actors: NodeActors = new Map(),
): AssigneeWorkload[] {
  const map = new Map<
    string,
    {
      label: string;
      source: WorkloadSource;
      todo: number;
      inProgress: number;
      done: number;
      todoNodes: Node[];
      ipNodes: Node[];
      doneNodes: Node[];
    }
  >();

  for (const vn of visibleNodes) {
    if (vn.isDimmed) continue;
    const leaf = vn.node;
    if (leaf.childrenIds.length !== 0) continue;
    const effort = leaf.effortEstimate ?? 0;
    if (effort === 0) continue;

    const cat = statusCategory(leaf, statusWorkflow);

    for (const { id: assignee, label, source } of attributionFor(leaf, actors)) {
      let entry = map.get(assignee);
      if (!entry) {
        entry = {
          label,
          source,
          todo: 0,
          inProgress: 0,
          done: 0,
          todoNodes: [],
          ipNodes: [],
          doneNodes: [],
        };
        map.set(assignee, entry);
      } else if (source === 'assignee' && entry.source !== 'assignee') {
        // A stronger signal upgrades the bucket's provenance mid-walk.
        entry.source = source;
        entry.label = label;
      }
      if (cat === 'todo') {
        entry.todo += effort;
        entry.todoNodes.push(leaf);
      } else if (cat === 'in_progress') {
        entry.inProgress += effort;
        entry.ipNodes.push(leaf);
      } else {
        entry.done += effort;
        entry.doneNodes.push(leaf);
      }
    }
  }

  const result: AssigneeWorkload[] = [];
  for (const [assigneeId, data] of map.entries()) {
    result.push({
      assigneeId,
      label: data.label,
      source: data.source,
      todo: data.todo,
      inProgress: data.inProgress,
      done: data.done,
      total: data.todo + data.inProgress + data.done,
      tasksByStatus: [
        { status: 'todo', nodes: data.todoNodes },
        { status: 'in_progress', nodes: data.ipNodes },
        { status: 'done', nodes: data.doneNodes },
      ],
    });
  }

  // Sort by total effort descending
  result.sort((a, b) => b.total - a.total);
  return result;
}
