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
