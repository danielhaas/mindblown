/**
 * What the intake card can do with an EXISTING ticket instead of creating a
 * new one (#409): add the new information as a comment, or reopen it. Both
 * work on a map node (with or without a linked issue) and on a forge-only
 * issue the pre-search surfaced. Forge writes carry the acting person's
 * identity when they have one (same rule as filing an issue).
 */

import { buildTodoIds, type Node as CoreNode, type MindMap } from '@mindblown/core';
import { commentOnGitHubIssue } from '@mindblown/integrations';
import * as nodeDb from '../db/nodes.js';
import * as commentDb from '../db/comments.js';
import * as events from '../db/events.js';
import { getGitHubContextForMap } from '../lib/githubContext.js';
import { broadcast } from '../ws.js';
import { syncNodeToGitHub } from '../routes/nodes.js';
import { userForgeForMap, type IssueAuthor } from './forgeIssue.js';
import { forgeLinkOf } from '../ai/intakeExisting.js';

export interface ExistingTarget {
  nodeId?: string | null;
  issueNumber?: number | null;
}

export interface ExistingActionResult {
  nodeId: string | null;
  issueNumber: number | null;
  /** The forge comment, when one was written. */
  commentUrl: string | null;
  author: IssueAuthor | null;
  /** The node after the action (reopen changes it). */
  node: CoreNode | null;
  warnings: string[];
}

export class ExistingNotFoundError extends Error {
  readonly code = 'EXISTING_NOT_FOUND' as const;
}

function issueNumberFromLink(node: CoreNode): number | null {
  const link = forgeLinkOf(node);
  const m = link ? /#(\d+)$/.exec(link.externalId) : null;
  return m ? Number(m[1]) : null;
}

async function resolveTarget(mapId: string, target: ExistingTarget): Promise<{ node: CoreNode | null; issueNumber: number | null }> {
  let node: CoreNode | null = null;
  if (target.nodeId) {
    node = await nodeDb.getNode(target.nodeId);
    if (!node || node.mapId !== mapId) throw new ExistingNotFoundError(`Node ${target.nodeId} is not on this map`);
  }
  const issueNumber = node ? issueNumberFromLink(node) : (target.issueNumber ?? null);
  if (!node && issueNumber == null) throw new ExistingNotFoundError('Nothing to act on: no node and no issue number');
  return { node, issueNumber };
}

/** A forge comment as the acting person, else as the binding; null without an integration. */
async function forgeComment(
  mapId: string,
  userId: string,
  issueNumber: number,
  body: string,
  warnings: string[],
): Promise<{ url: string | null; author: IssueAuthor | null }> {
  const ctx = await getGitHubContextForMap(mapId);
  if (!ctx) {
    warnings.push('no repo connected — comment written on the node only');
    return { url: null, author: null };
  }
  let forge = ctx.forge;
  let author: IssueAuthor = { as: 'binding', login: null };
  try {
    const mine = await userForgeForMap(mapId, userId);
    if (mine.forge) {
      forge = mine.forge;
      author = { as: 'user', login: mine.login };
    } else {
      author.fallbackReason = mine.reason;
    }
  } catch (err) {
    author.fallbackReason = err instanceof Error ? err.message : String(err);
  }
  try {
    const c = await commentOnGitHubIssue(ctx.owner, ctx.repo, issueNumber, body, forge);
    return { url: c.html_url, author };
  } catch (err) {
    if (author.as === 'user') {
      const reason = err instanceof Error ? err.message : String(err);
      const c = await commentOnGitHubIssue(ctx.owner, ctx.repo, issueNumber, body, ctx.forge);
      return { url: c.html_url, author: { as: 'binding', login: null, fallbackReason: reason } };
    }
    throw err;
  }
}

/**
 * Add the new information to an existing ticket: a node comment (when
 * there is a node) and a forge comment (when there is an issue).
 */
export async function commentOnExisting(
  mapId: string,
  userId: string,
  target: ExistingTarget,
  note: string,
): Promise<ExistingActionResult> {
  const text = note.trim();
  if (!text) throw new Error('note is required');
  const { node, issueNumber } = await resolveTarget(mapId, target);
  const warnings: string[] = [];
  if (node) {
    const comment = await commentDb.createComment({ nodeId: node.id, userId, text });
    broadcast(mapId, { type: 'comment:created', nodeId: node.id, comment });
  }
  let commentUrl: string | null = null;
  let author: IssueAuthor | null = null;
  if (issueNumber != null) {
    const c = await forgeComment(mapId, userId, issueNumber, text, warnings);
    commentUrl = c.url;
    author = c.author;
  }
  return { nodeId: node?.id ?? null, issueNumber, commentUrl, author, node, warnings };
}

/**
 * Put an existing ticket back to work: status to the workflow's first
 * "todo" state, progress to 0 (the outbound sync then reopens the issue),
 * plus the note as a comment. A forge-only issue is reopened directly.
 */
export async function reopenExisting(
  mapId: string,
  userId: string,
  map: MindMap,
  target: ExistingTarget,
  note: string,
): Promise<ExistingActionResult> {
  const text = note.trim();
  if (!text) throw new Error('note is required');
  const { node, issueNumber } = await resolveTarget(mapId, target);
  const warnings: string[] = [];
  let updated: CoreNode | null = null;

  if (node) {
    const todo = [...buildTodoIds(map.statusWorkflow ?? [])][0] ?? 'todo';
    updated = await nodeDb.updateNode(node.id, { status: todo, percentComplete: 0, completedAt: null });
    if (!updated) throw new ExistingNotFoundError(`Node ${node.id} vanished`);
    events.recordFieldChanges(mapId, node.id, userId, node, updated).catch(() => {});
    broadcast(mapId, { type: 'node:updated', nodeId: node.id, fields: ['status', 'percentComplete'], node: updated });
    // Reopens the linked issue (state follows the node) — best effort.
    syncNodeToGitHub(updated, ['status', 'percentComplete']).catch((err) => {
      warnings.push(`issue reopen via sync failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const comment = await commentDb.createComment({ nodeId: node.id, userId, text });
    broadcast(mapId, { type: 'comment:created', nodeId: node.id, comment });
  } else if (issueNumber != null) {
    const ctx = await getGitHubContextForMap(mapId);
    if (!ctx) throw new Error('No repo connected — cannot reopen a forge-only issue');
    await ctx.forge.updateIssue(ctx.owner, ctx.repo, issueNumber, { state: 'open', state_reason: 'reopened' });
  }

  let commentUrl: string | null = null;
  let author: IssueAuthor | null = null;
  if (issueNumber != null) {
    const c = await forgeComment(mapId, userId, issueNumber, text, warnings);
    commentUrl = c.url;
    author = c.author;
  }
  return { nodeId: node?.id ?? null, issueNumber, commentUrl, author, node: updated ?? node, warnings };
}
