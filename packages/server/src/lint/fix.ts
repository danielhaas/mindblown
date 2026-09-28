/**
 * The write side of the plan linter: apply one of the fixes a finding
 * offers (core LINT_ACTIONS). Same shape as services/unblock.ts and
 * services/intakeActions.ts — every node write goes through nodeDb +
 * change events (field changes AND the claim trail) + broadcast + outbound
 * sync, so a fix looks exactly like the same edit made by hand: the issue
 * follows the node, the panel and the fleet see the change, the history
 * says who did it.
 *
 * Issue-side fixes (close / reopen the issue) write to the forge directly,
 * stamp the stored link state so the finding clears immediately instead
 * of after the next catch-up poll, and leave an `issueState` change event.
 */
import { buildTodoIds, isForgeLink, type ExternalLink, type LintActionId, type Node as CoreNode } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { recordClaimTransition, recordEvent, recordFieldChanges } from '../db/events.js';
import { broadcast } from '../ws.js';
import { syncNodeToGitHub } from '../routes/nodes.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { unblockNode, UnblockNotFoundError } from '../services/unblock.js';
import { buildDonePredicate } from './engine.js';

export type LintFixErrorCode = 'NODE_NOT_FOUND' | 'NO_FORGE_LINK' | 'NO_FORGE' | 'BAD_ACTION';

export class LintFixError extends Error {
  constructor(
    public readonly code: LintFixErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LintFixError';
  }
}

export interface LintFixOutcome {
  action: LintActionId;
  node: CoreNode;
  /** Fields the fix touched on the node (empty for a pure issue-side fix). */
  changedFields: string[];
  /** Set when the fix wrote to the forge. */
  issue?: { externalId: string; state: 'open' | 'closed' };
}

const PARK_REASON = 'Parked from Plan health';

/**
 * The link a finding is about — the same choice the engine's forgeLinkOf
 * makes (first issue link with a synced state), falling back to any issue
 * link so a fix still works on a link that never synced a state.
 */
export function issueLinkOf(node: Pick<CoreNode, 'externalLinks'>): ExternalLink | null {
  const issues = (node.externalLinks ?? []).filter((l) => isForgeLink(l) && !l.isPullRequest);
  return issues.find((l) => l.state != null) ?? issues[0] ?? null;
}

/** The hand-edit fan-out: history, claim trail, live update, outbound sync. */
async function fanOut(
  mapId: string,
  userId: string | null,
  before: CoreNode,
  updated: CoreNode,
  changedFields: string[],
  claim: { reason: 'done' | 'blocked' | 'release'; note?: string | null },
): Promise<void> {
  await recordFieldChanges(mapId, updated.id, userId, before, updated).catch(() => {});
  await recordClaimTransition(mapId, updated.id, userId, before, updated, claim).catch(() => {});
  broadcast(mapId, { type: 'node:updated', nodeId: updated.id, fields: changedFields, node: updated });
  // The issue follows the node (close on done, reopen on todo) — best effort.
  syncNodeToGitHub(updated, changedFields).catch(() => {});
}

export async function applyLintFix(
  mapId: string,
  nodeId: string,
  action: LintActionId,
  userId: string | null,
  opts: { note?: string } = {},
): Promise<LintFixOutcome> {
  const before = await nodeDb.getNode(nodeId);
  if (!before || before.mapId !== mapId) throw new LintFixError('NODE_NOT_FOUND', `Node ${nodeId} not found`);
  const isLeaf = (before.childrenIds?.length ?? 0) === 0;

  if (action === 'clear-blocker') {
    try {
      const r = await unblockNode(mapId, nodeId, userId);
      broadcast(mapId, { type: 'node:updated', nodeId, fields: r.changedFields, node: r.node });
      syncNodeToGitHub(r.node, r.changedFields).catch(() => {});
      return { action, node: r.node, changedFields: r.changedFields };
    } catch (err) {
      if (err instanceof UnblockNotFoundError) throw new LintFixError('NODE_NOT_FOUND', err.message);
      throw err;
    }
  }

  if (action === 'close-issue' || action === 'reopen-issue') {
    const link = issueLinkOf(before);
    if (!link) throw new LintFixError('NO_FORGE_LINK', `Node ${nodeId} has no linked issue`);
    const m = /#(\d+)$/.exec(link.externalId);
    if (!m) throw new LintFixError('NO_FORGE_LINK', `Cannot read an issue number from ${link.externalId}`);
    const ctx = await getGitHubContextForMap(mapId);
    if (!ctx) throw new LintFixError('NO_FORGE', 'No repository is connected to this map');
    const state = action === 'close-issue' ? 'closed' : 'open';

    // Closing the issue asserts the work is finished, so a leaf still below
    // 100 % is brought to 100 first. This also keeps the forge's `closed`
    // webhook echo on our side of its "already done here" gate (which reads
    // percentComplete === 100), so the echo cannot rewrite the node.
    let node = before;
    const changedFields: string[] = [];
    if (state === 'closed' && isLeaf && (before.percentComplete ?? 0) < 100) {
      const updated = await nodeDb.updateNode(nodeId, { percentComplete: 100 });
      if (!updated) throw new LintFixError('NODE_NOT_FOUND', `Node ${nodeId} vanished`);
      node = updated;
      changedFields.push('percentComplete');
      await recordFieldChanges(mapId, nodeId, userId, before, updated).catch(() => {});
    }

    await ctx.forge.updateIssue(ctx.owner, ctx.repo, Number(m[1]), {
      state,
      state_reason: state === 'closed' ? 'completed' : 'reopened',
    });
    await nodeDb.setExternalLinkState(nodeId, link.externalId, state);
    await recordEvent({
      mapId,
      nodeId,
      userId,
      eventType: 'node.field_changed',
      fieldName: 'issueState',
      oldValue: link.state ?? null,
      newValue: `${link.externalId} ${state}`,
    });
    node = (await nodeDb.getNode(nodeId)) ?? node;
    broadcast(mapId, { type: 'node:updated', nodeId, fields: [...changedFields, 'externalLinks'], node });
    return { action, node, changedFields, issue: { externalId: link.externalId, state } };
  }

  const workflow = (await mapDb.getStatusWorkflow(mapId)) ?? [];
  const isDoneStatus = buildDonePredicate(workflow);
  let input: nodeDb.UpdateNodeInput;
  let changedFields: string[];
  let claimReason: 'done' | 'blocked' | 'release' = 'release';
  switch (action) {
    case 'mark-done': {
      // A node already in a done-category status keeps it — only the
      // number was wrong. Parents compute their progress, so only a leaf
      // gets the 100 written.
      input = {};
      changedFields = [];
      if (!isDoneStatus(before.status)) {
        input.status = workflow.find((s) => s.category === 'done')?.id ?? 'done';
        changedFields.push('status');
      }
      if (isLeaf) {
        input.percentComplete = 100;
        changedFields.push('percentComplete');
      }
      claimReason = 'done';
      break;
    }
    case 'reopen': {
      const todoId = [...buildTodoIds(workflow)][0] ?? 'todo';
      input = { status: todoId, completedAt: null };
      changedFields = ['status'];
      if (isLeaf) {
        input.percentComplete = 0;
        changedFields.push('percentComplete');
      }
      break;
    }
    case 'park': {
      // Mirrors the fleet's blocked.sh: status + reason + tag + claim
      // released, so the queue skips it and the cockpit explains why.
      const reason = before.blockedReason?.trim() || `${PARK_REASON}${opts.note ? `: ${opts.note}` : ''}`;
      input = { status: 'blocked', blockedReason: reason, tagsAppend: ['blocked'], claimedBySession: null };
      changedFields = ['status', 'blockedReason', 'tags', 'claimedBySession'];
      claimReason = 'blocked';
      break;
    }
    default:
      throw new LintFixError('BAD_ACTION', `Unknown fix "${String(action)}"`);
  }

  if (changedFields.length === 0) return { action, node: before, changedFields };
  const updated = await nodeDb.updateNode(nodeId, input);
  if (!updated) throw new LintFixError('NODE_NOT_FOUND', `Node ${nodeId} vanished`);
  await fanOut(mapId, userId, before, updated, changedFields, {
    reason: claimReason,
    note: claimReason === 'blocked' ? updated.blockedReason : null,
  });
  return { action, node: updated, changedFields };
}
