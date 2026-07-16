/**
 * Shared leaf-scoping for the MI tool suite (remaining_work,
 * completion_forecast, risk_scan, plan_lint).
 *
 * Scope rules:
 * - `nodeId` restricts to the leaves of that subtree.
 * - `versionId` filters by inherited tag: a leaf is in scope if it OR any
 *   ancestor carries the version. Combines with `nodeId` (intersection).
 * - Neither → all leaves of the map.
 */
import type { MapDetail, NodeWithComputed } from './api.js';

export type ScopeResult =
  | { ok: true; leaves: NodeWithComputed[]; scopeLabel: string }
  | { ok: false; error: string };

export function scopedLeaves(
  data: MapDetail,
  opts: { nodeId?: string; versionId?: string } = {},
): ScopeResult {
  const { nodeId, versionId } = opts;
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

  const ancestorVersions = (leafId: string): Set<string> => {
    const versions = new Set<string>();
    let cur = nodeById.get(leafId);
    while (cur) {
      if (cur.versionId) versions.add(cur.versionId);
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return versions;
  };

  let leaves: NodeWithComputed[];
  let scopeLabel = 'whole map';

  if (nodeId) {
    const root = nodeById.get(nodeId);
    if (!root) return { ok: false, error: `Node ${nodeId} not found in map ${data.map.id}.` };
    scopeLabel = `subtree of "${root.text}" (${nodeId})`;
    const subtreeLeaves: NodeWithComputed[] = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if ((n.childrenIds?.length ?? 0) === 0) {
        subtreeLeaves.push(n);
      } else {
        for (const cid of n.childrenIds) {
          const c = nodeById.get(cid);
          if (c) stack.push(c);
        }
      }
    }
    leaves = subtreeLeaves;
  } else {
    leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
  }

  if (versionId) {
    scopeLabel = `version ${versionId}` + (nodeId ? ` within ${scopeLabel}` : '');
    leaves = leaves.filter((n) => ancestorVersions(n.id).has(versionId));
  }

  return { ok: true, leaves, scopeLabel };
}
