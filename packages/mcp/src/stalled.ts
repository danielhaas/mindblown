/**
 * MCP rendering of stalled work (core findStalled — in progress, no
 * claim, no change for hours): the blocked_digest section and the
 * get_wip_status marker. The list itself comes with the map payload.
 */

import { describeStalled, formatIdle, STALLED_GROUP_LABEL, type StalledLeaf } from '@mindblown/core';

/** blocked_digest section: one line per stalled leaf with progress, idle time and the last claim holder. */
export function stalledSectionLines(
  stalled: StalledLeaf[],
  titleOf: (id: string) => string,
  now: Date = new Date(),
): string[] {
  if (stalled.length === 0) return [];
  const lines = [`## ${STALLED_GROUP_LABEL} (${stalled.length})`];
  for (const s of stalled.slice(0, 30)) {
    lines.push(`- ⏸ **${titleOf(s.nodeId)}** — ${describeStalled(s, now)} (id: ${s.nodeId})`);
  }
  if (stalled.length > 30) lines.push(`- _… and ${stalled.length - 30} more_`);
  lines.push('_Nobody is on these: park them for a person, or reopen them so the pull queue hands them out again._');
  lines.push('');
  return lines;
}

/** get_wip_status marker after an in-progress leaf: who holds it, or that nobody does. */
export function wipClaimMarker(
  node: { id: string; claimedBySession: string | null },
  stalledById: Map<string, StalledLeaf>,
  now: Date = new Date(),
): string {
  if (node.claimedBySession) return ` (claimed by ${node.claimedBySession})`;
  const s = stalledById.get(node.id);
  return s ? ` (unclaimed, stalled — no change for ${formatIdle(s.lastChangeAt, now)})` : ' (unclaimed)';
}
