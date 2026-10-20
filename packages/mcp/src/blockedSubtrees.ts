/**
 * blocked_digest "Blocked subtrees": blocked leaves below each ancestor,
 * counted from the digest's own (done-filtered) leaf list — the core rollup
 * `blockedDescendantCount` still counts a done leaf whose blockedReason stayed.
 */
export function blockedBelowCounts(
  blockedLeaves: Array<{ parentId: string | null }>,
  nodes: Array<{ id: string; parentId: string | null }>,
): Map<string, number> {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  const counts = new Map<string, number>();
  for (const leaf of blockedLeaves) {
    for (let p = leaf.parentId; p; p = parentOf.get(p) ?? null) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return counts;
}
