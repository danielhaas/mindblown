/**
 * Stalled leaves of a map (core findStalled) with their change-log
 * activity — one source for the map payload (Blocked panel, PM Cockpit,
 * blocked_digest), plan_lint and its fix re-check. An archived map is on
 * hold by design, so nothing on it counts as stalled.
 *
 * Throws when the change log cannot be read: plan_lint reports the rule
 * as skipped, the map load falls back to an empty list.
 */
import { computeIsBlocked, findStalled, isStalledCandidate, type StalledLeaf, type StatusDef } from '@mindblown/core';
import type { Node } from '@mindblown/core';
import { loadStalledActivity } from '../db/events.js';

export async function stalledForMap(
  map: { id: string; statusWorkflow?: StatusDef[] | null; archivedAt?: string | Date | null },
  nodes: Node[],
  now: Date = new Date(),
): Promise<StalledLeaf[]> {
  if (map.archivedAt) return [];
  const workflow = map.statusWorkflow ?? [];
  // A leaf waiting on an unfinished predecessor is blocked, not stalled —
  // it already sits under "Waiting on a predecessor task".
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const candidates = nodes.filter(
    (n) => isStalledCandidate(n, workflow) && !computeIsBlocked(n, nodeMap).isBlocked,
  );
  if (candidates.length === 0) return [];
  const activity = await loadStalledActivity(map.id, candidates.map((n) => n.id));
  return findStalled(candidates, workflow, activity, now);
}

/** For the map load: the stalled list is a side signal and never fails it. */
export function stalledOrEmpty(
  map: Parameters<typeof stalledForMap>[0],
  nodes: Node[],
): Promise<StalledLeaf[]> {
  return stalledForMap(map, nodes).catch((err) => {
    console.error('[stalled] change-log lookup failed', err);
    return [];
  });
}
