/**
 * Parked branches (#655): a node flagged `parked` stays in the map for
 * context, but it and its whole subtree are "later" — no dates, not in the
 * total duration, not in the export's timeline, never pulled by the fleet.
 */
import type { Node, NodeId } from './types.js';

type TreeNode = Pick<Node, 'id' | 'parentId'> & { parked?: boolean };

/** The ids of every node in a parked branch: a parked node and all below it. */
export function parkedNodeIds<T extends TreeNode>(nodes: T[]): Set<NodeId> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<NodeId, boolean>();
  const inParked = (start: T): boolean => {
    const path: NodeId[] = [];
    let result = false;
    for (let n: T | undefined = start; n; n = n.parentId ? byId.get(n.parentId) : undefined) {
      const known = memo.get(n.id);
      if (known !== undefined) {
        result = known;
        break;
      }
      if (path.includes(n.id)) break; // a cycle in bad data — not parked
      path.push(n.id);
      if (n.parked === true) {
        result = true;
        break;
      }
    }
    for (const id of path) memo.set(id, result);
    return result;
  };
  return new Set(nodes.filter(inParked).map((n) => n.id));
}

/** Whether a node sits in a parked branch (itself or an ancestor parked). */
export function isInParkedBranch(node: TreeNode, byId: Map<NodeId, TreeNode>): boolean {
  const seen = new Set<NodeId>();
  for (let n: TreeNode | undefined = node; n && !seen.has(n.id); n = n.parentId ? byId.get(n.parentId) : undefined) {
    if (n.parked === true) return true;
    seen.add(n.id);
  }
  return false;
}

/**
 * The nodes the scheduler plans: parked branches removed, and the
 * children and dependencies that point into them pruned, so the tree and
 * the dependency graph stay valid. A dependency on parked work is dropped:
 * the parked work has no dates to wait for.
 */
export function withoutParked(nodes: Node[]): Node[] {
  const parked = parkedNodeIds(nodes);
  if (parked.size === 0) return nodes;
  return nodes
    .filter((n) => !parked.has(n.id))
    .map((n) => ({
      ...n,
      childrenIds: n.childrenIds.filter((id) => !parked.has(id)),
      dependencies: n.dependencies.filter((d) => !parked.has(d.targetNodeId)),
    }));
}
