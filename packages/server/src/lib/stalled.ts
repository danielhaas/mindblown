/**
 * Stalled leaves of a map (core findStalled) with their change-log
 * activity — one source for the map payload (Blocked panel, PM Cockpit,
 * blocked_digest) and plan_lint. An archived map is on hold by design, so
 * nothing on it counts as stalled.
 */
import { findStalled, isStalledCandidate, type StalledLeaf, type StatusDef } from '@mindblown/core';
import type { Node } from '@mindblown/core';
import { loadStalledActivity } from '../db/events.js';

export async function stalledForMap(
  map: { id: string; statusWorkflow?: StatusDef[] | null; archivedAt?: string | Date | null },
  nodes: Node[],
  now: Date = new Date(),
): Promise<StalledLeaf[]> {
  if (map.archivedAt) return [];
  const workflow = map.statusWorkflow ?? [];
  const candidates = nodes.filter((n) => isStalledCandidate(n, workflow));
  if (candidates.length === 0) return [];
  try {
    const activity = await loadStalledActivity(map.id, candidates.map((n) => n.id));
    return findStalled(candidates, workflow, activity, now);
  } catch (err) {
    // A side signal: never fail the map load over it.
    console.error('[stalled] change-log lookup failed', err);
    return [];
  }
}
