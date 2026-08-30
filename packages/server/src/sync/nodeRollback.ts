/**
 * Take a node back off `done` after its GitHub issue was reopened
 * because the work was never on the default branch.
 *
 * One implementation, two callers (`prAbandon`, `closedIssueAudit`).
 * They had a byte-identical copy each, which is the shape a rule drifts
 * out of: the race guard below would have had to be discovered twice.
 */

import type { ExternalLink } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';

export type RollbackOutcome =
  /** The node was done; progress/status restored from the close-snapshot. */
  | 'rolled_back'
  /** The node no longer reads as done — somebody (or our own webhook) got there first. */
  | 'not_done'
  /** The node is gone. */
  | 'gone';

/**
 * Restores the close-snapshot the close path captured on the link
 * (`previousPercentComplete` / `previousStatus`), exactly like the
 * `issues.reopened` webhook does, and clears the snapshot afterwards so
 * a later legitimate close captures fresh state. Falls back to
 * `in_progress` when no snapshot exists — the work is demonstrably
 * unfinished, and leaving it at 100 % is the failure mode this whole
 * area exists to end.
 *
 * ## Why it re-reads and checks "still done"
 *
 * Reopening the issue makes GitHub deliver `issues.reopened` back to us,
 * and that handler already restores the snapshot — correctly, from the
 * same link. If it wins the race, the node is sitting at its restored
 * progress and this function would then overwrite it with a SECOND
 * restore off a link whose snapshot the webhook has already cleared,
 * i.e. `percentComplete: null, status: 'in_progress'`. Undoing a bad
 * close must not cost the progress it was supposed to give back.
 *
 * So: if the node no longer reads as done, somebody already handled it.
 * Do nothing.
 */
export async function rollBackNodeOffDone(
  nodeId: string,
  externalId: string,
): Promise<RollbackOutcome> {
  const node = await nodeDb.getNode(nodeId);
  if (!node) return 'gone';

  const looksDone = node.percentComplete === 100 || node.status === 'done';
  if (!looksDone) return 'not_done';

  const links: ExternalLink[] = node.externalLinks.map((l) => ({ ...l }));
  const idx = links.findIndex(
    (l) => l.provider === 'github' && l.externalId === externalId,
  );

  let restoredPct: number | null = null;
  let restoredStatus = 'in_progress';
  if (idx >= 0) {
    const link = links[idx];
    restoredPct = link.previousPercentComplete ?? null;
    restoredStatus = link.previousStatus ?? 'in_progress';
    links[idx] = {
      ...link,
      previousPercentComplete: null,
      previousStatus: null,
      state: 'open',
      lastSyncedAt: new Date().toISOString(),
    };
  }

  await nodeDb.updateNode(nodeId, {
    percentComplete: restoredPct,
    status: restoredStatus,
    externalLinks: links,
  });
  return 'rolled_back';
}
