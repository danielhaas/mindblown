/**
 * Shared leaf-scoping for the MI tool suite (remaining_work,
 * completion_forecast, risk_scan, plan_lint).
 *
 * Scope rules:
 * - `nodeId` restricts to the leaves of that subtree.
 * - `versionId` filters by inherited tag, nearest-wins: the first non-null
 *   `versionId` on the leaf→root path decides, so an explicit assignment on
 *   the leaf beats the epic above it and a leaf never belongs to two
 *   releases at once. Combines with `nodeId` (intersection).
 * - `phaseId` filters by effective phase: nearest non-null `phaseId` on the
 *   leaf→root path decides (same explicit-assignment-wins semantics as the
 *   frontend scopeFilter.ts walk). Combines with the others (intersection).
 * - None → all leaves of the map.
 */
import { effectiveVersionId } from '@mindblown/core';
import type { MapDetail, NodeWithComputed } from './api.js';

export type ScopeResult =
  | { ok: true; leaves: NodeWithComputed[]; scopeLabel: string }
  | { ok: false; error: string };

export function scopedLeaves(
  data: MapDetail,
  opts: { nodeId?: string; versionId?: string; phaseId?: string } = {},
): ScopeResult {
  const { nodeId, versionId, phaseId } = opts;
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

  // Nearest-tag-wins membership (effectiveVersionId in core) — the same
  // rule search_nodes and the orchestrator use, so every surface agrees
  // which release a leaf belongs to.

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
    leaves = leaves.filter((n) => effectiveVersionId(n.id, nodeById) === versionId);
  }

  if (phaseId) {
    const phases = data.map.phases ?? [];
    const phase = phases.find((p) => p.id === phaseId);
    if (phases.length > 0 && !phase) {
      const known = phases.map((p) => `"${p.name}" (${p.id})`).join(', ');
      return { ok: false, error: `Phase ${phaseId} not found on map ${data.map.id}. Known phases: ${known}.` };
    }
    const phaseFragment = `phase ${phase ? `"${phase.name}"` : phaseId}`;
    scopeLabel = scopeLabel === 'whole map' ? phaseFragment : `${phaseFragment} within ${scopeLabel}`;
    const effectivePhase = (leafId: string): string | null => {
      let cur = nodeById.get(leafId);
      while (cur) {
        if (cur.phaseId != null) return cur.phaseId;
        cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
      }
      return null;
    };
    leaves = leaves.filter((n) => effectivePhase(n.id) === phaseId);
  }

  return { ok: true, leaves, scopeLabel };
}
