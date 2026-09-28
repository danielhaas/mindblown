/**
 * The write side of the plan linter: apply one of the fixes a finding
 * offers (engine.ts LINT_ACTIONS). Same shape as services/unblock.ts and
 * services/intakeActions.ts — every node write goes through nodeDb +
 * change events + broadcast + outbound sync, so a fix looks exactly like
 * the same edit made by hand: the issue follows the node, the panel and
 * the fleet see the change, the history says who did it.
 *
 * Issue-side fixes (close / reopen the issue) write to the forge directly
 * and stamp the stored link state, so the finding clears immediately
 * instead of after the next catch-up poll.
 */
import { buildTodoIds, isForgeLink, type Node as CoreNode } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { recordFieldChanges } from '../db/events.js';
import { broadcast } from '../ws.js';
import { syncNodeToGitHub } from '../routes/nodes.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { unblockNode, UnblockNotFoundError } from '../services/unblock.js';
import type { LintActionId } from './engine.js';

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
  /** Fields the fix touched on the node (empty for an issue-side fix). */
  changedFields: string[];
  /** Set when the fix wrote to the forge. */
  issue?: { externalId: string; state: 'open' | 'closed' };
}

const PARK_REASON = 'Parked from Plan health';

export async function applyLintFix(
  mapId: string,
  nodeId: string,
  action: LintActionId,
  userId: string | null,
  opts: { note?: string } = {},
): Promise<LintFixOutcome> {
  const before = await nodeDb.getNode(nodeId);
  if (!before || before.mapId !== mapId) throw new LintFixError('NODE_NOT_FOUND', `Node ${nodeId} not found`);

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
    const link = before.externalLinks.find(isForgeLink);
    if (!link) throw new LintFixError('NO_FORGE_LINK', `Node ${nodeId} has no linked issue`);
    const m = /#(\d+)$/.exec(link.externalId);
    if (!m) throw new LintFixError('NO_FORGE_LINK', `Cannot read an issue number from ${link.externalId}`);
    const ctx = await getGitHubContextForMap(mapId);
    if (!ctx) throw new LintFixError('NO_FORGE', 'No repository is connected to this map');
    const state = action === 'close-issue' ? 'closed' : 'open';
    await ctx.forge.updateIssue(ctx.owner, ctx.repo, Number(m[1]), {
      state,
      state_reason: state === 'closed' ? 'completed' : 'reopened',
    });
    await nodeDb.setExternalLinkState(nodeId, link.externalId, state);
    const node = (await nodeDb.getNode(nodeId)) ?? before;
    broadcast(mapId, { type: 'node:updated', nodeId, fields: ['externalLinks'], node });
    return { action, node, changedFields: [], issue: { externalId: link.externalId, state } };
  }

  const workflow = (await mapDb.getStatusWorkflow(mapId)) ?? [];
  let input: nodeDb.UpdateNodeInput;
  let changedFields: string[];
  switch (action) {
    case 'mark-done': {
      const doneId = workflow.find((s) => s.category === 'done')?.id ?? 'done';
      input = { status: doneId, percentComplete: 100 };
      changedFields = ['status', 'percentComplete'];
      break;
    }
    case 'reopen': {
      const todoId = [...buildTodoIds(workflow)][0] ?? 'todo';
      input = { status: todoId, percentComplete: 0, completedAt: null };
      changedFields = ['status', 'percentComplete'];
      break;
    }
    case 'park': {
      // Mirrors the fleet's blocked.sh: status + reason + tag + claim
      // released, so the queue skips it and the cockpit explains why.
      const reason = before.blockedReason?.trim() || `${PARK_REASON}${opts.note ? `: ${opts.note}` : ''}`;
      input = { status: 'blocked', blockedReason: reason, tagsAppend: ['blocked'], claimedBySession: null };
      changedFields = ['status', 'blockedReason', 'tags', 'claimedBySession'];
      break;
    }
    default:
      throw new LintFixError('BAD_ACTION', `Unknown fix "${String(action)}"`);
  }

  const updated = await nodeDb.updateNode(nodeId, input);
  if (!updated) throw new LintFixError('NODE_NOT_FOUND', `Node ${nodeId} vanished`);
  recordFieldChanges(mapId, nodeId, userId, before, updated).catch(() => {});
  broadcast(mapId, { type: 'node:updated', nodeId, fields: changedFields, node: updated });
  // The issue follows the node (close on done, reopen on todo) — best effort.
  syncNodeToGitHub(updated, changedFields).catch(() => {});
  return { action, node: updated, changedFields };
}
