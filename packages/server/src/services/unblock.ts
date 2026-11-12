/**
 * Release a "parked on human" ticket back into the pull queue — the
 * write side of the asks loop.
 *
 * A Leidang worker that gives up runs blocked.sh: status=blocked,
 * blockedReason, tag `blocked`, claim released. Three fields latch the
 * ticket out of the queue. Undoing that by hand meant three edits, and the
 * old MCP clear_blocker undid only one (blockedReason) — the node stayed
 * status=blocked, invisible to dispatch and "UNEXPLAINED" to the
 * orchestrator. This is the one call that undoes all three, with the
 * status rule in core (`planUnblock`) so the cockpit button, the MCP tool
 * and the chat tool agree.
 */
import { BLOCKED_TAG, planUnblock } from '@mindblown/core';
import type { AskWrite, Node as CoreNode } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { recordFieldChanges } from '../db/events.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { issueLinkOf, issueNumberOf, removeIssueLabels } from './issueLabels.js';

export interface UnblockOutcome {
  node: CoreNode;
  /** True when the status was moved back to the workflow's todo status. */
  statusReset: boolean;
  /** Fields the write touched — for broadcast/sync fan-out. */
  changedFields: string[];
  /**
   * The `blocked` label taken off the linked issue (#622) — set when the
   * tag came off and the map has a forge connected. `done: false` with an
   * `error` when the forge refused; the node write stands either way.
   */
  labelWrite?: AskWrite;
}

export class UnblockNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'UnblockNotFoundError';
  }
}

export async function unblockNode(mapId: string, nodeId: string, userId: string | null): Promise<UnblockOutcome> {
  const before = await nodeDb.getNode(nodeId);
  if (!before || before.mapId !== mapId) throw new UnblockNotFoundError(`Node ${nodeId}`);
  const workflow = await mapDb.getStatusWorkflow(mapId);
  if (workflow === null) throw new UnblockNotFoundError(`Map ${mapId}`);

  const plan = planUnblock(before, workflow);
  const input: nodeDb.UpdateNodeInput = { blockedReason: null };
  // `tags` is on purpose not in change_events' TRACKED_FIELDS (noise), so
  // the tag removal leaves no audit row — status + blockedReason do. The
  // field is still listed for the broadcast/GitHub-sync fan-out.
  const changedFields = ['blockedReason'];
  if (plan.tagsRemove.length > 0) {
    input.tagsRemove = plan.tagsRemove;
    changedFields.push('tags');
  }
  if (plan.status !== undefined) {
    input.status = plan.status;
    changedFields.push('status');
  }

  const updated = await nodeDb.updateNode(nodeId, input);
  if (!updated) throw new UnblockNotFoundError(`Node ${nodeId}`);
  await recordFieldChanges(mapId, nodeId, userId, before, updated);

  // Only `blocked`: a skip tag (needs-human …) is a person's step still to
  // do, and lifting a blocker must not hand that to the fleet.
  const labelWrite = plan.tagsRemove.includes(BLOCKED_TAG) ? await dropBlockedLabel(mapId, updated) : undefined;

  return { node: updated, statusReset: plan.status !== undefined, changedFields, ...(labelWrite ? { labelWrite } : {}) };
}

/**
 * The outbound sync rewrites labels only on a link with sync on, so on
 * 12.11.2026 a cleared ticket kept `blocked` on its issue (#622).
 */
async function dropBlockedLabel(mapId: string, node: CoreNode): Promise<AskWrite | undefined> {
  const num = issueNumberOf(issueLinkOf(node));
  if (num === null) return undefined;
  const ctx = await getGitHubContextForMap(mapId).catch(() => null);
  if (!ctx) return undefined;
  return removeIssueLabels(ctx, num, [BLOCKED_TAG]);
}
