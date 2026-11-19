/**
 * MCP rendering of stalled work (core findStalled — in progress, no
 * claim, no change for hours): the blocked_digest section and the
 * get_wip_status marker. The list itself comes with the map payload.
 */

import { describeStalled, formatIdle, STALLED_GROUP_LABEL, ticketPhases, ticketPhaseText, type StalledLeaf } from '@mindblown/core';

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

/** Each fleet ticket's "phase · elapsed" from a fleet read, by node id; stale hosts say nothing. */
export function wipPhaseTexts(hosts: Parameters<typeof ticketPhases>[0], now: Date): Map<string, string> {
  const out = new Map<string, string>();
  for (const [nodeId, p] of ticketPhases(hosts, now)) {
    out.set(nodeId, ticketPhaseText(p, now) + (p.prNumber ? `, PR #${p.prNumber}` : ''));
  }
  return out;
}

/**
 * get_wip_status marker after an in-progress leaf: who holds it, or that
 * nobody does. `phase` = where the fleet is with it (#546), e.g.
 * "Waiting for CI · 12m".
 */
export function wipClaimMarker(
  node: { id: string; claimedBySession: string | null },
  stalledById: Map<string, StalledLeaf>,
  now: Date = new Date(),
  phase?: string,
): string {
  if (node.claimedBySession) return ` (claimed by ${node.claimedBySession}${phase ? ` — ${phase}` : ''})`;
  const s = stalledById.get(node.id);
  return s ? ` (unclaimed, stalled — no change for ${formatIdle(s.lastChangeAt, now)})` : ' (unclaimed)';
}
