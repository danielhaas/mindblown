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

import type { ExternalLink } from '@mindblown/core';
import {
  getGitHubIssue,
  getIssueCloseEvent,
  probeIssueLanded,
  reopenGitHubIssue,
  extractClosingIssueRefs,
} from '@mindblown/integrations';

import * as nodeDb from '../db/nodes.js';
import { findNodeIdByExternalId } from '../db/nodes.js';

export interface AbandonedPrContext {
  owner: string;
  repo: string;
  token: string;
}

export interface AbandonedPrOutcome {
  externalId: string;
  /**
   * - `reopened`      — issue reopened, node rolled back.
   * - `already_open`  — nothing to undo.
   * - `landed_elsewhere` — another PR merged this issue's work.
   * - `closed_by_commit` — GitHub's own auto-close; not ours to revert.
   * - `failed`        — GitHub call failed; the catchup is the backstop.
   */
  status:
    | 'reopened'
    | 'already_open'
    | 'landed_elsewhere'
    | 'closed_by_commit'
    | 'failed';
  nodeId: string | null;
  error?: string;
}

/**
 * Roll a node back off `done` after its issue was reopened.
 *
 * Restores the close-snapshot the close path captured on the link
 * (`previousPercentComplete` / `previousStatus`), exactly like the
 * `issues.reopened` webhook does, and clears the snapshot afterwards so
 * a later legitimate close captures fresh state. Falls back to
 * `in_progress` when no snapshot exists — the work is demonstrably
 * unfinished, and leaving it at 100 % is the failure mode this whole
 * module exists to end.
 */
async function rollBackNode(nodeId: string, externalId: string): Promise<void> {
  const node = await nodeDb.getNode(nodeId);
  if (!node) return;

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

      // A replacement PR may already have shipped this issue's work.
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

      await reopenGitHubIssue({ externalId }, ctx.token);
      if (nodeId) await rollBackNode(nodeId, externalId);
      console.log(
        `[pr-abandon] PR #${pr.number} closed unmerged → reopened ${externalId}` +
          (nodeId ? ` and rolled node ${nodeId} back off done` : ''),
      );
      outcomes.push({ externalId, status: 'reopened', nodeId });
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
