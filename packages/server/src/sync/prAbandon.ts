/**
 * The way back: a PR closed WITHOUT merging must undo the "done" it
 * caused.
 *
 * The premature-close incident has two halves. The first half is the
 * close itself — a node marked done when its PR opened, closing the
 * linked issue as COMPLETED with no merge commit behind it. That half is
 * gated in `updateGitHubIssue` (@mindblown/integrations).
 *
 * This module is the second half, and it applies to every issue closed
 * before the gate existed as well as to any that slips through: when the
 * PR that was supposed to land the work dies unmerged, the promise the
 * close was made on is broken. crm#6085 is the case in point — closed
 * 2026-07-27 because PR #6089 was opened, and PR #6089 never merged;
 * `purge_share_access_log` still writes no `RetentionPruneAuditRecord`
 * today, while the ticket reads as finished.
 *
 * So on `pull_request.closed` with `merged=false` we walk the PR's
 * `Closes #N` refs and, for each one:
 *
 *   1. Ask GitHub whether ANOTHER pull request already landed the work
 *      on the default branch. If one did, the issue is legitimately
 *      closed and we leave it alone — a superseded PR must not reopen a
 *      ticket its replacement already shipped.
 *   2. Otherwise, if the issue is closed and the close carries no merge
 *      commit, reopen it and roll the linked node back off done.
 *
 * A close that DOES carry a commit id was performed by a commit landing
 * on the default branch — GitHub's own auto-close — and is never
 * reverted here.
 */

import {
  getGitHubIssue,
  getIssueCloseEvent,
  probeIssueLanded,
  reopenGitHubIssue,
  extractClosingIssueRefs,
} from '@mindblown/integrations';

import { findNodeIdByExternalId } from '../db/nodes.js';
import { rollBackNodeOffDone } from './nodeRollback.js';

export interface AbandonedPrContext {
  owner: string;
  repo: string;
  token: string;
}

/**
 * The GitHub login whose closes this module is allowed to undo.
 *
 * This gate exists because `commit_id` does NOT tell a human's close
 * apart from MindBlown's: both are API closes, both leave it null. The
 * actor does. Without this check, a ticket a person deliberately closed
 * — including one `trashGc` closed as `not_planned` because its node was
 * deleted — would be reopened the moment any old PR carrying
 * `Closes #N` was closed unmerged. An automatic path must not write
 * against a deliberate human decision.
 *
 * Configurable because the login is per-installation (`<app-slug>[bot]`).
 * An unset or mistyped value means nothing matches and nothing is
 * reopened — the safe direction.
 */
function mindblownBotLogin(): string {
  return process.env.MINDBLOWN_BOT_LOGIN ?? 'mindblown-by-project-li[bot]';
}

export interface AbandonedPrOutcome {
  externalId: string;
  /**
   * - `reopened`      — issue reopened, node rolled back.
   * - `already_open`  — nothing to undo.
   * - `landed_elsewhere` — another PR merged this issue's work.
   * - `closed_by_commit` — GitHub's own auto-close; not ours to revert.
   * - `not_planned`   — closed as "not planned"; nobody claimed it shipped.
   * - `foreign_close` — somebody other than the MindBlown bot closed it.
   * - `pr_in_flight`  — another PR for this issue is still open.
   * - `node_not_done` — the node no longer reads as done; nothing to undo.
   * - `failed`        — GitHub call failed; the catchup is the backstop.
   */
  status:
    | 'reopened'
    | 'already_open'
    | 'landed_elsewhere'
    | 'closed_by_commit'
    | 'not_planned'
    | 'foreign_close'
    | 'pr_in_flight'
    | 'node_not_done'
    | 'failed';
  nodeId: string | null;
  error?: string;
}

/**
 * Handle one abandoned (closed-unmerged) pull request.
 *
 * Returns one outcome per `Closes #N` ref. Safe to replay: an issue that
 * is already open reports `already_open` and writes nothing.
 */
export async function handleAbandonedPr(
  ctx: AbandonedPrContext,
  pr: { number: number; title?: string | null; body: string | null },
): Promise<AbandonedPrOutcome[]> {
  const refs = extractClosingIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`);
  const repoFullName = `${ctx.owner}/${ctx.repo}`;
  const outcomes: AbandonedPrOutcome[] = [];

  for (const issueNumber of refs) {
    const externalId = `${repoFullName}#${issueNumber}`;
    const nodeId = await findNodeIdByExternalId(externalId);
    try {
      const issue = await getGitHubIssue(ctx.owner, ctx.repo, issueNumber, ctx.token);
      if (issue.state !== 'closed') {
        outcomes.push({ externalId, status: 'already_open', nodeId });
        continue;
      }

      const closeEvent = await getIssueCloseEvent(
        ctx.owner,
        ctx.repo,
        issueNumber,
        ctx.token,
      );
      if (closeEvent?.commitId) {
        outcomes.push({ externalId, status: 'closed_by_commit', nodeId });
        continue;
      }

      // Nobody claimed this work shipped. `not_planned` is a decision —
      // a dropped ticket, or a node deleted in MindBlown (trashGc closes
      // those as not_planned). Reopening it would resurrect work
      // somebody deliberately abandoned.
      if (closeEvent?.stateReason === 'not_planned') {
        outcomes.push({ externalId, status: 'not_planned', nodeId });
        continue;
      }

      // A human's close and MindBlown's close are indistinguishable by
      // `commit_id` — both null. The actor is the only thing that tells
      // them apart, and undoing a person's decision automatically is
      // strictly worse than leaving a stale close for a person to fix.
      if (closeEvent?.actor !== mindblownBotLogin()) {
        outcomes.push({ externalId, status: 'foreign_close', nodeId });
        continue;
      }

      // A replacement PR may already have shipped this issue's work, or
      // still be working on it.
      const probe = await probeIssueLanded(
        ctx.owner,
        ctx.repo,
        issueNumber,
        ctx.token,
      );
      if (probe.landed && probe.landed.number !== pr.number) {
        outcomes.push({ externalId, status: 'landed_elsewhere', nodeId });
        continue;
      }
      // Two PRs on one issue: A dies while B is still open. Reopening
      // the ticket and pulling the node off done would report B's
      // in-flight work as not started.
      if (probe.inFlight) {
        outcomes.push({ externalId, status: 'pr_in_flight', nodeId });
        continue;
      }

      await reopenGitHubIssue({ externalId }, ctx.token);
      const rollback = nodeId
        ? await rollBackNodeOffDone(nodeId, externalId)
        : null;
      console.log(
        `[pr-abandon] PR #${pr.number} closed unmerged → reopened ${externalId}` +
          (rollback === 'rolled_back'
            ? ` and rolled node ${nodeId} back off done`
            : rollback === 'not_done'
              ? ` (node ${nodeId} was already off done — left alone)`
              : ''),
      );
      outcomes.push({
        externalId,
        // The issue IS reopened either way; `node_not_done` only records
        // that the node needed no second restore.
        status: rollback === 'not_done' ? 'node_not_done' : 'reopened',
        nodeId,
      });
    } catch (err) {
      outcomes.push({
        externalId,
        status: 'failed',
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}
