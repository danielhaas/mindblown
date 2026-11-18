/**
 * A PR merged to the repo's default branch → the nodes of the issues it
 * names (#152). Run by the forge webhook (`pull_request.closed` +
 * merged) and by a person's merge through MindBlown (merge_pr), so both
 * leave the same trail: closing refs → node done (claim released), merge
 * commit stamped on the link (close evidence; the reporter check's
 * discovery), node.pr_merged; `Refs #N` → the PR attributed without a
 * status change; title-only closing refs → the issue closed by us.
 *
 * Idempotent: a replay finds the node done with the sha stored and writes
 * nothing. The default-branch gate is the caller's.
 */

import { closeGitHubIssue, extractClosingIssueRefs, extractReferencedIssueRefs } from '@mindblown/integrations';
import { isForgeLink } from '@mindblown/core';
import * as nodeDb from '../db/nodes.js';
import * as events from '../db/events.js';
import { broadcast } from '../ws.js';
import type { GitHubMapContext } from '../lib/githubContext.js';

export interface MergedPr {
  number: number;
  body: string | null;
  title: string;
  merge_commit_sha?: string | null;
  html_url?: string | null;
}

export interface MergedPrTransition {
  externalId: string;
  nodeId: string;
  status: 'transitioned' | 'already_done' | 'referenced' | 'not_linked';
  /** This run wrote node.pr_merged (false on a replay). */
  recorded?: boolean;
}

export interface ApplyMergedPrOptions {
  /** Who merged: null for a forge webhook, the person for merge_pr. */
  actorUserId: string | null;
  /** Their name, kept on node.pr_merged so the trail says who merged. */
  mergedBy?: string | null;
  /** The forge client for closing title-only refs (best effort). */
  resolveForge: () => Promise<GitHubMapContext | null>;
}

export async function applyMergedPr(
  repoFullName: string,
  pr: MergedPr,
  opts: ApplyMergedPrOptions,
): Promise<MergedPrTransition[]> {
  // The one piece of durable proof that this issue's work shipped.
  // Stamped onto the link so the outbound sync can close the issue as
  // COMPLETED later on local evidence — without it, a done-node whose
  // mirror was already cleared looks exactly like a node that never
  // had a PR, which is how the premature-close incident got its
  // COMPLETED/commit_id=null closes.
  const mergeCommitSha = pr.merge_commit_sha ?? null;
  const refs = extractClosingIssueRefs(`${pr.title ?? ''} ${pr.body ?? ''}`);
  const transitions: MergedPrTransition[] = [];

  for (const issueNumber of refs) {
    const externalId = `${repoFullName}#${issueNumber}`;
    const nodeId = await nodeDb.findNodeIdByExternalId(externalId);
    if (!nodeId) {
      transitions.push({ externalId, nodeId: '', status: 'not_linked' });
      continue;
    }
    const node = await nodeDb.getNode(nodeId);
    if (!node) {
      transitions.push({ externalId, nodeId, status: 'not_linked' });
      continue;
    }
    // Idempotency: replay → no second transition.
    //
    // The node is normally ALREADY done here — the coding agent marks
    // it done when it opens the PR — so this is the branch the merge
    // evidence has to be recorded on, not an edge case. Guarded on
    // "sha not yet stored" so a webhook replay still writes nothing.
    if (node.status === 'done' && node.percentComplete === 100) {
      let recorded = false;
      if (mergeCommitSha) {
        const links = node.externalLinks.map((l) => ({ ...l }));
        const idx = links.findIndex(
          (l) => isForgeLink(l) && l.externalId === externalId,
        );
        if (idx >= 0 && links[idx].mergeCommitSha !== mergeCommitSha) {
          links[idx] = {
            ...links[idx],
            mergeCommitSha,
            mergedPrNumber: pr.number,
          };
          await nodeDb.updateNode(nodeId, { externalLinks: links });
          recorded = true;
          // Same replay guard as the stamp: the delivery row lands once.
          events
            .recordPrMerged(node.mapId, nodeId, opts.actorUserId, {
              prNumber: pr.number,
              repo: repoFullName,
              url: pr.html_url ?? null,
              ...(opts.mergedBy ? { mergedBy: opts.mergedBy } : {}),
              mergeCommitSha,
              externalId,
              alreadyDone: true,
            })
            .catch(() => {});
        }
      }
      transitions.push({ externalId, nodeId, status: 'already_done', recorded });
      continue;
    }
    const links = node.externalLinks.map((l) => ({ ...l }));
    const linkIdx = links.findIndex(
      (l) => isForgeLink(l) && l.externalId === externalId,
    );
    if (linkIdx >= 0) {
      links[linkIdx] = {
        ...links[linkIdx],
        previousPercentComplete: node.percentComplete,
        previousStatus: node.status,
        lastSyncedAt: new Date().toISOString(),
        ...(mergeCommitSha
          ? { mergeCommitSha, mergedPrNumber: pr.number }
          : {}),
      };
    }
    const updates: nodeDb.UpdateNodeInput = {
      percentComplete: 100,
      status: 'done',
      externalLinks: links,
    };
    const updated = await nodeDb.updateNode(nodeId, updates);
    if (updated) {
      broadcast(updated.mapId, {
        type: 'node:updated',
        nodeId,
        fields: Object.keys(updates),
        node: updated,
        source: 'github_webhook_pr_merge',
      });
      // This write bypasses the PUT route, so the history it keeps has
      // to be written here too: the status/percent change, the claim
      // the DB layer just cleared, and the merge itself.
      events.recordFieldChanges(updated.mapId, nodeId, opts.actorUserId, node, updated).catch(() => {});
      events
        .recordClaimTransition(updated.mapId, nodeId, opts.actorUserId, node, updated, {
          reason: 'done',
          note: `PR #${pr.number} merged${opts.mergedBy ? ` by ${opts.mergedBy}` : ''}`,
        })
        .catch(() => {});
      events
        .recordPrMerged(updated.mapId, nodeId, opts.actorUserId, {
          prNumber: pr.number,
          repo: repoFullName,
          url: pr.html_url ?? null,
          ...(opts.mergedBy ? { mergedBy: opts.mergedBy } : {}),
          mergeCommitSha,
          externalId,
          alreadyDone: false,
        })
        .catch(() => {});
    }
    console.log(
      `[gh-webhook] PR #${pr.number} merged → transitioned node ${nodeId} (${externalId}) to done`,
    );
    transitions.push({ externalId, nodeId, status: 'transitioned', recorded: !!updated });
  }

  // `Refs #N` (no closing keyword) — the fleet's own convention, its
  // workers close the issue themselves. The PR still delivered that
  // ticket, so it is attributed to the node: node.pr_merged plus the
  // PR number on the link. Never a status change or an issue close —
  // a reference does not promise the work is finished. The node may
  // not be done yet (the worker's done-write can land after the
  // merge), so the event is recorded either way; the merge commit is
  // stamped only on a done node, since it is close evidence for the
  // outbound sync. `mergedPrNumber` is the replay guard.
  const referenceOnly = extractReferencedIssueRefs(`${pr.title ?? ''} ${pr.body ?? ''}`).filter(
    (n) => !refs.includes(n),
  );
  for (const issueNumber of referenceOnly) {
    const externalId = `${repoFullName}#${issueNumber}`;
    const nodeId = await nodeDb.findNodeIdByExternalId(externalId);
    const node = nodeId ? await nodeDb.getNode(nodeId) : null;
    if (!nodeId || !node) {
      transitions.push({ externalId, nodeId: nodeId ?? '', status: 'not_linked' });
      continue;
    }
    const links = node.externalLinks.map((l) => ({ ...l }));
    const idx = links.findIndex((l) => isForgeLink(l) && l.externalId === externalId);
    let recorded = false;
    if (idx >= 0 && links[idx].mergedPrNumber !== pr.number) {
      recorded = true;
      const done = node.status === 'done' && node.percentComplete === 100;
      links[idx] = {
        ...links[idx],
        mergedPrNumber: pr.number,
        ...(done && mergeCommitSha ? { mergeCommitSha } : {}),
      };
      await nodeDb.updateNode(nodeId, { externalLinks: links });
      events
        .recordPrMerged(node.mapId, nodeId, opts.actorUserId, {
          prNumber: pr.number,
          repo: repoFullName,
          url: pr.html_url ?? null,
          ...(opts.mergedBy ? { mergedBy: opts.mergedBy } : {}),
          mergeCommitSha,
          externalId,
          alreadyDone: done,
        })
        .catch(() => {});
    }
    transitions.push({ externalId, nodeId, status: 'referenced', recorded });
  }

  // GitHub's own auto-close honors closing keywords only in the PR
  // BODY. Title-only refs leave the issue open after the merge —
  // and since handlePrClosed just cleared the mirror and the node
  // is now done, the next catchup tick would read "issue open +
  // node done + no PR" as a reopen and revert the shipped work.
  // Close those issues ourselves, best-effort (the catchup is the
  // backstop if this fetch fails).
  const bodyRefs = new Set(extractClosingIssueRefs(pr.body ?? ''));
  const titleOnlyRefs = refs.filter((n) => !bodyRefs.has(n));
  if (titleOnlyRefs.length > 0) {
    (async () => {
      const ctx = await opts.resolveForge();
      if (!ctx) return;
      for (const n of titleOnlyRefs) {
        try {
          await closeGitHubIssue(
            {
              provider: ctx.forge.endpoint.kind,
              externalId: `${repoFullName}#${n}`,
              url: ctx.forge.issueWebUrl(ctx.owner, ctx.repo, n),
              syncEnabled: true,
              lastSyncedAt: null,
            },
            ctx.forge,
            'completed',
          );
        } catch (err) {
          console.warn(
            `[gh-webhook] closing title-only ref ${repoFullName}#${n} after merge failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    })().catch(() => {});
  }

  return transitions;
}
