/**
 * Shared version-scoping for the requirements register (requirements_overview,
 * RequirementsView.tsx's release filter/slider mirrors this in the frontend).
 *
 * A requirement matches a release if its OWN versionId is that release, OR
 * ANY node anywhere below it in the tree carries that versionId — a
 * requirement can be split across releases (part of it ships in MVP, the
 * rest in V1), so this is a full descendant walk, not just direct children.
 */
import type { NodeWithComputed } from './api.js';

export function descendantVersionIds(
  nodeById: Map<string, NodeWithComputed>,
  id: string,
): string[] {
  const found = new Set<string>();
  const stack = [...(nodeById.get(id)?.childrenIds ?? [])];
  while (stack.length) {
    const cid = stack.pop()!;
    const n = nodeById.get(cid);
    if (!n) continue;
    if (n.versionId) found.add(n.versionId);
    stack.push(...(n.childrenIds ?? []));
  }
  return [...found];
}

export function requirementMatchesVersion(
  nodeById: Map<string, NodeWithComputed>,
  requirementId: string,
  versionId: string,
): boolean {
  const own = nodeById.get(requirementId)?.versionId;
  return own === versionId || descendantVersionIds(nodeById, requirementId).includes(versionId);
}
