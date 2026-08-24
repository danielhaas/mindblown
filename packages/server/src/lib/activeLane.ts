/**
 * THE active-lane pick, shared by every surface that defaults to "the
 * lane currently being worked": ingest lane routing
 * (sync/githubIngest.ts::resolveIngestVersionId) and the plan-lint
 * default scope (routes/lint.ts). One policy — a change here changes
 * both, which is the point: ingest routing and lint scoping diverging
 * on what "the active lane" means would silently lint one lane while
 * filling another.
 *
 * Policy: status 'active', highest sortOrder wins (= the latest lane
 * being worked), id as the deterministic tie-break — nothing enforces
 * unique sortOrder, and hand-created lanes commonly all sit at the
 * default 0.
 */
export function pickActiveLane<
  T extends { id: string; status: string; sortOrder: number },
>(versions: T[]): T | null {
  const active = versions.filter((v) => v.status === 'active');
  if (active.length === 0) return null;
  active.sort((a, b) => b.sortOrder - a.sortOrder || a.id.localeCompare(b.id));
  return active[0];
}
