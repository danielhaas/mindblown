/**
 * The rule for every cross-map "waiting on a person" list — prs_waiting,
 * approvals (page, header badge, list_pending_approvals), asks (list_asks,
 * asks_digest), waiting_on_humans, the daily digest mail: an archived map
 * is on hold, so a list over several maps (all of a reader's, or a fleet's)
 * leaves it out. Only a read that names the map itself still answers for it.
 */
export function waitingMaps<T extends { archivedAt: string | Date | null }>(maps: T[]): T[] {
  return maps.filter((m) => !m.archivedAt);
}
