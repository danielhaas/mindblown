/**
 * Inventory sweep: which issues are closed as COMPLETED without a merge
 * commit behind them?
 *
 * The gate in `updateGitHubIssue` and the reopen path in `prAbandon`
 * stop new cases. Neither touches the ones already on the board, and
 * those are the expensive ones: a `CLOSED / COMPLETED` ticket ends the
 * search. crm#8400 sat two weeks in the "done" column while its gap was
 * wide open; crm#6085's `purge_share_access_log` still writes no
 * `RetentionPruneAuditRecord` today, because its PR (#6089) never
 * merged and nobody looked again.
 *
 * The check, per issue:
 *
 *   1. It is closed with `state_reason = completed`.
 *   2. Its most recent `closed` event carries `commit_id = null` — i.e.
 *      the close came from an API call, not from a commit landing on the
 *      default branch. (Optionally filtered to a specific actor, e.g.
 *      `mindblown-by-project-li[bot]`.)
 *   3. No pull request that references the issue with a closing keyword
 *      has merged into the default branch.
 *
 * All three true ⇒ the issue claims work that is not on the default
 * branch. It gets reopened, and its MindBlown node rolled back off done.
 *
 * **`dryRun` defaults to true.** The run reports; it does not write
 * unless a caller explicitly asks it to. Nothing about a first look at
 * this data should mutate a hundred tickets.
 */

import {
  fetchChangedIssues,
  getIssueCloseEvent,
  probeIssueLanded,
  reopenGitHubIssue,
} from '@mindblown/integrations';
import type { GitHubIssue } from '@mindblown/integrations';

import * as nodeDb from '../db/nodes.js';
import { findNodeIdByExternalId } from '../db/nodes.js';

export interface AuditOptions {
  owner: string;
  repo: string;
  token: string;
  /**
   * Write mode. `true` (the default) reports only. `false` reopens every
   * issue the check condemns and rolls its node back off done.
   */
  dryRun?: boolean;
  /**
   * Only consider issues closed by this GitHub login (e.g.
   * `mindblown-by-project-li[bot]`). Omit to audit every API close
   * regardless of who made it.
   */
  closedBy?: string;
  /** Only look at issues updated at/after this ISO timestamp. */
  since?: string | null;
  /** Hard ceiling on issues INSPECTED (API budget). Default 200. */
  limit?: number;
}

export type AuditVerdict =
  /** Closed COMPLETED, no merge commit, no merged PR → must reopen. */
  | 'unbacked'
  /** A merged PR on the default branch backs the close. */
  | 'backed_by_pr'
  /** GitHub's own commit-driven auto-close. */
  | 'backed_by_commit'
  /** Closed for another reason (not_planned) or by another actor. */
  | 'skipped'
  /** A GitHub call failed for this issue. */
  | 'error';

export interface AuditFinding {
  externalId: string;
  issueNumber: number;
  title: string;
  url: string;
  verdict: AuditVerdict;
  closedAt: string | null;
  closedBy: string | null;
  /** Merge commit backing the close, when one exists. */
  mergeCommitSha: string | null;
  /** PR numbers that reference the issue with a closing keyword. */
  closingPrs: number[];
  nodeId: string | null;
  /** True when this run actually reopened the issue (never in dryRun). */
  reopened: boolean;
  error?: string;
}

export interface AuditResult {
  repo: string;
  dryRun: boolean;
  /** Issues fetched and inspected. */
  inspected: number;
  /** Issues that failed the check. */
  unbacked: number;
  /** Issues reopened by this run (0 in dryRun). */
  reopened: number;
  findings: AuditFinding[];
}

/**
 * Roll a node back off done after its issue was reopened. Mirrors
 * `prAbandon.rollBackNode` — restore the close-snapshot when the close
 * path captured one, otherwise land on `in_progress`, because the one
 * thing we know for certain is that the work is not on the default
 * branch.
 */
async function rollBackNode(nodeId: string, externalId: string): Promise<void> {
  const node = await nodeDb.getNode(nodeId);
  if (!node) return;

  const links = node.externalLinks.map((l) => ({ ...l }));
  const idx = links.findIndex(
    (l) => l.provider === 'github' && l.externalId === externalId,
  );

  let restoredPct: number | null = null;
  let restoredStatus = 'in_progress';
  if (idx >= 0) {
    restoredPct = links[idx].previousPercentComplete ?? null;
    restoredStatus = links[idx].previousStatus ?? 'in_progress';
    links[idx] = {
      ...links[idx],
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
 * Classify one already-fetched issue. Split out from the loop so the
 * decision — the part worth testing — needs no repo scan around it.
 */
export async function auditOneIssue(
  opts: Pick<AuditOptions, 'owner' | 'repo' | 'token' | 'closedBy'>,
  issue: Pick<GitHubIssue, 'number' | 'title' | 'html_url' | 'state' | 'state_reason'>,
): Promise<AuditFinding> {
  const repoFullName = `${opts.owner}/${opts.repo}`;
  const externalId = `${repoFullName}#${issue.number}`;
  const base: AuditFinding = {
    externalId,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.html_url,
    verdict: 'skipped',
    closedAt: null,
    closedBy: null,
    mergeCommitSha: null,
    closingPrs: [],
    nodeId: null,
    reopened: false,
  };

  // `state_reason` is absent on older payloads. GitHub fills an
  // unqualified close with `completed`, which is exactly the population
  // we are after, so absent counts as completed rather than as a skip.
  if (issue.state !== 'closed') return base;
  if (issue.state_reason === 'not_planned') return base;

  try {
    const closeEvent = await getIssueCloseEvent(
      opts.owner,
      opts.repo,
      issue.number,
      opts.token,
    );
    base.closedAt = closeEvent?.createdAt ?? null;
    base.closedBy = closeEvent?.actor ?? null;

    if (opts.closedBy && closeEvent?.actor !== opts.closedBy) return base;

    if (closeEvent?.commitId) {
      base.verdict = 'backed_by_commit';
      base.mergeCommitSha = closeEvent.commitId;
      return base;
    }

    const probe = await probeIssueLanded(
      opts.owner,
      opts.repo,
      issue.number,
      opts.token,
    );
    base.closingPrs = probe.closingPrs.map((p) => p.number);
    if (probe.landed) {
      base.verdict = 'backed_by_pr';
      base.mergeCommitSha = probe.landed.mergeCommitSha;
      return base;
    }

    base.verdict = 'unbacked';
    base.nodeId = await findNodeIdByExternalId(externalId);
    return base;
  } catch (err) {
    base.verdict = 'error';
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  }
}

/**
 * Sweep a repo's closed issues for closes that claim completed work with
 * nothing merged behind them.
 *
 * Read-only unless `dryRun: false` is passed explicitly.
 */
export async function auditClosedIssues(opts: AuditOptions): Promise<AuditResult> {
  const dryRun = opts.dryRun !== false;
  const limit = opts.limit ?? 200;
  const repoFullName = `${opts.owner}/${opts.repo}`;

  const all = await fetchChangedIssues(
    opts.owner,
    opts.repo,
    opts.token,
    opts.since ?? null,
  );
  const closed = all.filter((i) => i.state === 'closed').slice(0, limit);

  const findings: AuditFinding[] = [];
  for (const issue of closed) {
    const finding = await auditOneIssue(opts, issue);
    if (finding.verdict === 'unbacked' && !dryRun) {
      try {
        await reopenGitHubIssue({ externalId: finding.externalId }, opts.token);
        if (finding.nodeId) await rollBackNode(finding.nodeId, finding.externalId);
        finding.reopened = true;
        console.log(
          `[closed-issue-audit] reopened ${finding.externalId} — closed COMPLETED with no merge commit`,
        );
      } catch (err) {
        finding.verdict = 'error';
        finding.error = err instanceof Error ? err.message : String(err);
      }
    }
    findings.push(finding);
  }

  return {
    repo: repoFullName,
    dryRun,
    inspected: closed.length,
    unbacked: findings.filter((f) => f.verdict === 'unbacked').length,
    reopened: findings.filter((f) => f.reopened).length,
    findings,
  };
}
