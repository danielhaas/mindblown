/**
 * Canonical release ordering.
 *
 * Versions are ordered chronologically by target date, with undated
 * versions last — an undated version is one nobody has committed to a
 * date for, so it belongs after everything that has one.
 *
 * The order is load-bearing, not cosmetic: computeReleaseForecast walks
 * versions with a running cursor, chaining each non-shipped release onto
 * the previous one's finish. Two surfaces disagreeing on the order would
 * produce two different forecasts for the same map.
 *
 * Ties fall back to sortOrder (the manual override), then to the semver
 * parsed from the name so undated V2/V10 don't sort lexically, then to
 * the name itself for stability.
 */
export interface VersionOrderFields {
  name: string;
  sortOrder: number;
  targetDate?: string | null;
}

/** "V1" → [1, 0]; "V1.5" → [1, 5]; "MVP: Onboarding" → [∞, ∞] (sorts last). */
function parseSemver(name: string): [number, number] {
  const m = name.match(/^V(\d+)(?:\.(\d+))?/i);
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
}

export function compareVersions(a: VersionOrderFields, b: VersionOrderFields): number {
  const at = a.targetDate ?? null;
  const bt = b.targetDate ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return at < bt ? -1 : 1;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const [aMaj, aMin] = parseSemver(a.name);
  const [bMaj, bMin] = parseSemver(b.name);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return a.name.localeCompare(b.name);
}

// ── Effective version membership ───────────────────────────────────
//
// Which release does a node belong to? The tree is organised by *what*
// (functional area), releases are an orthogonal tag, so membership has to
// be inherited down the tree. The only real question is what happens when
// more than one ancestor carries a tag.
//
// NEAREST WINS. Walking up from the node, the first non-null versionId
// decides — an explicit assignment on a leaf overrides the epic above it,
// which is the whole point of being able to pull one item out of a release.
//
// The alternative (collect every tagged ancestor into a set, node belongs
// to all of them) was in use on the effort surfaces and is wrong for any
// kind of accounting: the same leaf got counted into two releases, so its
// effort was spent twice in the chained forecast and it showed up in both
// releases' remaining-work totals. You only do the work once.

/** Minimal node shape for the membership walk. */
export interface VersionMembershipNode {
  parentId: string | null;
  versionId?: string | null;
}

/**
 * The single release a node belongs to: the first non-null `versionId`
 * on its path to the root, or null when nothing on the path is tagged.
 *
 * Cycle-guarded — a malformed parent chain returns null rather than
 * hanging the request.
 */
export function effectiveVersionId<T extends VersionMembershipNode>(
  nodeId: string,
  nodeById: Map<string, T>,
): string | null {
  const seen = new Set<string>();
  let cur: T | undefined = nodeById.get(nodeId);
  while (cur) {
    if (cur.versionId != null) return cur.versionId;
    const parentId: string | null = cur.parentId;
    if (parentId == null || seen.has(parentId)) return null;
    seen.add(parentId);
    cur = nodeById.get(parentId);
  }
  return null;
}
