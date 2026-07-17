import type { Node, ComputedNodeValues } from '@mindblown/core';

/**
 * Pure selection helpers for the secondary views (Hill Chart, Workload).
 *
 * Both views used to read the raw `s.nodes` record and therefore ignored
 * the active version / sprint filters entirely (filter chip visible, view
 * still showing everything). They now consume the store's
 * `getVisibleNodes()` output — the same filtered set ListView and
 * CalendarView are built on — and these helpers derive each view's data
 * basis from it. Kept as pure functions (no store import) so they are
 * unit-testable without a DOM or the zustand store machinery.
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
  hillPosition: number; // 0-100
}

/**
 * Select the Hill Chart dots from the visible-node set.
 *
 * Depth 1 = direct children of the effective root (the drill-down focus,
 * or the map root when not drilled down). Dimmed context siblings and
 * nodes outside the active version/sprint filter are already excluded
 * from `visibleNodes`, so the hill only shows in-scope branches.
 * Preserves the sibling order `getVisibleNodes()` emits (= childrenIds
 * order).
 */
export function selectHillBranches(
  visibleNodes: ScopedVisibleNode[],
  computed: Map<string, ComputedNodeValues>,
): HillBranch[] {
  const branches: HillBranch[] = [];
  for (const vn of visibleNodes) {
    if (vn.isDimmed || vn.depth !== 1) continue;
    const comp = computed.get(vn.node.id);
    if (!comp) continue;
    const hp = (vn.node.customFields?.hillPosition as number) ?? 0;
    branches.push({ node: vn.node, computed: comp, hillPosition: hp });
  }
  return branches;
}

// ── Workload ─────────────────────────────────────────────────────

export type StatusCategoryId = 'todo' | 'in_progress' | 'done';

export interface StatusWorkflowStep {
  id: string;
  name: string;
  category: string;
}

export interface AssigneeWorkload {
  assigneeId: string;
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
 * Aggregate per-assignee effort from the leaf nodes of the visible set.
 *
 * A leaf is a node without children (raw `childrenIds`, same notion
 * CalendarView uses); dimmed drill-down context siblings are skipped.
 * Only leaves that survived the active version/sprint filter contribute,
 * so the Workload bars reflect the same scope the filter chip announces.
 * Result is sorted by total effort descending.
 */
export function computeWorkloads(
  visibleNodes: ScopedVisibleNode[],
  statusWorkflow: StatusWorkflowStep[],
): AssigneeWorkload[] {
  const map = new Map<
    string,
    { todo: number; inProgress: number; done: number; todoNodes: Node[]; ipNodes: Node[]; doneNodes: Node[] }
  >();

  for (const vn of visibleNodes) {
    if (vn.isDimmed) continue;
    const leaf = vn.node;
    if (leaf.childrenIds.length !== 0) continue;
    if (leaf.assigneeIds.length === 0) continue;
    const effort = leaf.effortEstimate ?? 0;
    if (effort === 0) continue;

    const cat = statusCategory(leaf, statusWorkflow);

    for (const assignee of leaf.assigneeIds) {
      let entry = map.get(assignee);
      if (!entry) {
        entry = { todo: 0, inProgress: 0, done: 0, todoNodes: [], ipNodes: [], doneNodes: [] };
        map.set(assignee, entry);
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
