import { computeIsBlocked } from './compute.js';
import type { Node, NodeId, NodeMap } from './types.js';

/**
 * Why a parent is blocked (#651). `computeIsBlocked` rolls a parent up to
 * blocked when any leaf below it is; this names the causes.
 *
 * A root cause is either a blocked leaf that carries its own marker (a
 * `blockedReason`, the `blocked` status or tag), or an unfinished FS
 * predecessor outside the chain of blocked leaves under the parent. A leaf
 * waiting on another blocked leaf of the same subtree inherits that leaf's
 * causes, so a chain A → B → C counts once, under A.
 */
export interface BlockedRootCause {
  /** 'reason': `nodeId` is the marked leaf. 'predecessor': `nodeId` is the unfinished task it waits on. */
  kind: 'reason' | 'predecessor';
  nodeId: NodeId;
  /** The leaf's blocker text for 'reason'; null for 'predecessor'. */
  reason: string | null;
  /** Blocked leaves under the parent that trace back to this cause, tree order. */
  waitingIds: NodeId[];
}

export interface BlockedParentExplanation {
  /** Every blocked leaf under the parent, tree order. Its length is `blockedDescendantCount`. */
  blockedLeafIds: NodeId[];
  /** Unfinished FS predecessors per blocked leaf (as `computeIsBlocked` reports them). */
  predecessorIds: Record<NodeId, NodeId[]>;
  /** Most waiting leaves first. */
  rootCauses: BlockedRootCause[];
}

function isMarkedBlocked(n: Node): boolean {
  return (
    (n.blockedReason ?? '').trim() !== '' ||
    n.tags.includes('blocked') ||
    (n.status ?? '').toLowerCase() === 'blocked'
  );
}

export function explainBlockedParent(parent: Node, nodeMap: NodeMap): BlockedParentExplanation {
  const blockedLeafIds: NodeId[] = [];
  const predecessorIds: Record<NodeId, NodeId[]> = {};
  const walk = (n: Node) => {
    for (const cid of n.childrenIds) {
      const c = nodeMap.get(cid);
      if (!c) continue;
      if (c.childrenIds.length > 0) { walk(c); continue; }
      const r = computeIsBlocked(c, nodeMap);
      if (!r.isBlocked) continue;
      blockedLeafIds.push(c.id);
      predecessorIds[c.id] = r.blockedBy.predecessorIds;
    }
  };
  walk(parent);

  const inChain = new Set(blockedLeafIds);
  // Cause keys per leaf: 'r:<leafId>' or 'p:<predecessorId>'.
  const memo = new Map<NodeId, Set<string>>();
  const visiting = new Set<NodeId>();
  const causesOf = (id: NodeId): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (visiting.has(id)) return new Set(); // dependency cycle — the caller falls back to itself
    visiting.add(id);
    const n = nodeMap.get(id)!;
    const out = new Set<string>();
    if (isMarkedBlocked(n)) {
      out.add(`r:${id}`);
    } else {
      for (const pid of predecessorIds[id] ?? []) {
        if (inChain.has(pid)) for (const k of causesOf(pid)) out.add(k);
        else out.add(`p:${pid}`);
      }
      if (out.size === 0) out.add(`r:${id}`);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };

  const groups = new Map<string, BlockedRootCause>();
  for (const id of blockedLeafIds) {
    for (const key of causesOf(id)) {
      let g = groups.get(key);
      if (!g) {
        const nodeId = key.slice(2);
        const isReason = key.startsWith('r:');
        const n = nodeMap.get(nodeId);
        g = {
          kind: isReason ? 'reason' : 'predecessor',
          nodeId,
          reason: isReason ? (n?.blockedReason?.trim() || (isMarkedBlocked(n!) ? 'marked blocked' : 'dependency cycle')) : null,
          waitingIds: [],
        };
        groups.set(key, g);
      }
      g.waitingIds.push(id);
    }
  }

  const rootCauses = [...groups.values()].sort((a, b) => b.waitingIds.length - a.waitingIds.length);
  return { blockedLeafIds, predecessorIds, rootCauses };
}

/**
 * Where `id` sits outside `parent`'s subtree, as "Branch › Title" — the
 * branch being the top node on its side below the common ancestor (e.g. the
 * other milestone). Null when `id` is inside the subtree or is that branch.
 */
export function outsideBranch(parent: Node, id: NodeId, nodeMap: NodeMap): Node | null {
  const parentLine = new Set<NodeId>();
  for (let n: Node | undefined = parent; n; n = n.parentId ? nodeMap.get(n.parentId) : undefined) parentLine.add(n.id);
  let prev: Node | null = null;
  for (let n: Node | undefined = nodeMap.get(id); n; n = n.parentId ? nodeMap.get(n.parentId) : undefined) {
    if (n.id === parent.id) return null; // inside the subtree
    if (parentLine.has(n.id)) return prev && prev.id !== id ? prev : null;
    prev = n;
  }
  return null;
}
