/**
 * A PR merged to the repo's default branch → the nodes of the issues it
 * names (#152). Run by the forge webhook (`pull_request.closed` +
 * merged) and by a person's merge through MindBlown (merge_pr), so both
 * leave the same trail: closing refs → node done (claim released), merge
 * commit stamped on the link (close evidence; the reporter check's
 * discovery), node.pr_merged; `Refs #N` → the PR attributed without a
 * status change; title-only closing refs → the issue closed by us.
 * A PR without a forge issue names its node instead — `MindBlown: <id>`
 * closes it, `MindBlown refs: <id>` attributes it (applyNodeIdRefs).
 *
 * Idempotent: a replay finds the node done with the sha stored and writes
 * nothing. The default-branch gate is the caller's.
 */

import {
  closeGitHubIssue,
  extractClosingIssueRefs,
  extractClosingNodeRefs,
  extractReferencedIssueRefs,
  extractReferencedNodeRefs,
} from '@mindblown/integrations';
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

  await applyNodeIdRefs(repoFullName, pr, opts, transitions);

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

/**
 * `MindBlown: <id>` (and the fleet's `MindBlown node: <id>`) closes the
 * node it names, `MindBlown refs: <id>` attributes the PR to it — the
 * same trail as `Closes #N` / `Refs #N`, for PRs made without a forge
 * issue. The id (full or a prefix) is looked up only on maps bound to
 * this repo; unknown or ambiguous → not_linked. A node an issue ref of
 * the same PR already handled is skipped. The replay guard is the node's
 * own node.pr_merged row for this PR, so it is written awaited.
 * Appends to `transitions`.
 */
async function applyNodeIdRefs(
  repoFullName: string,
  pr: MergedPr,
  opts: ApplyMergedPrOptions,
  transitions: MergedPrTransition[],
): Promise<void> {
  const text = `${pr.title ?? ''} ${pr.body ?? ''}`;
  const closing = extractClosingNodeRefs(text);
  const refs = [
    ...closing.map((ref) => ({ ref, closes: true })),
    ...extractReferencedNodeRefs(text)
      .filter((r) => !closing.includes(r))
      .map((ref) => ({ ref, closes: false })),
  ];
  if (refs.length === 0) return;
  const mergeCommitSha = pr.merge_commit_sha ?? null;
  const handled = new Set(transitions.map((t) => t.nodeId).filter(Boolean));

  for (const { ref, closes } of refs) {
    const externalId = `mindblown:${ref}`;
    const ids = await nodeDb.findNodeIdsByIdOnRepoMaps(ref, repoFullName);
    const node = ids.length === 1 ? await nodeDb.getNode(ids[0]) : null;
    if (!node) {
      console.log(
        `[gh-webhook] PR #${pr.number} in ${repoFullName} names MindBlown node ${ref}: ${ids.length > 1 ? 'ambiguous' : 'no such node'} on this repo's maps → not_linked`,
      );
      transitions.push({ externalId, nodeId: '', status: 'not_linked' });
      continue;
    }
    const nodeId = node.id;
    if (handled.has(nodeId)) continue;
    handled.add(nodeId);

    const wasDone = node.status === 'done' && node.percentComplete === 100;
    const status: MergedPrTransition['status'] = !closes ? 'referenced' : wasDone ? 'already_done' : 'transitioned';
    const seen = (
      await events.listEvents({ mapId: node.mapId, nodeId, eventType: 'node.pr_merged', limit: 50 })
    ).some((e) => {
      const v = e.newValue as { prNumber?: number; repo?: string } | null;
      return v?.prNumber === pr.number && v?.repo === repoFullName;
    });
    if (seen) {
      // A replay writes nothing — not even a node reopened since the merge.
      transitions.push({ externalId, nodeId, status: closes ? 'already_done' : 'referenced', recorded: false });
      continue;
    }

    // The node's forge links of this repo carry the merge as close
    // evidence for the outbound sync, as on the closing-ref branch.
    const doneAfter = wasDone || closes;
    const links = node.externalLinks.map((l) =>
      isForgeLink(l) && l.externalId.toLowerCase().startsWith(`${repoFullName.toLowerCase()}#`)
        ? { ...l, mergedPrNumber: pr.number, ...(doneAfter && mergeCommitSha ? { mergeCommitSha } : {}) }
        : l,
    );
    const linksChanged = JSON.stringify(links) !== JSON.stringify(node.externalLinks);
    const updates: nodeDb.UpdateNodeInput =
      status === 'transitioned'
        ? { percentComplete: 100, status: 'done', ...(linksChanged ? { externalLinks: links } : {}) }
        : linksChanged ? { externalLinks: links } : {};
    const updated = Object.keys(updates).length > 0 ? await nodeDb.updateNode(nodeId, updates) : null;
    if (status === 'transitioned' && updated) {
      broadcast(updated.mapId, {
        type: 'node:updated',
        nodeId,
        fields: Object.keys(updates),
        node: updated,
        source: 'github_webhook_pr_merge',
      });
      events.recordFieldChanges(updated.mapId, nodeId, opts.actorUserId, node, updated).catch(() => {});
      events
        .recordClaimTransition(updated.mapId, nodeId, opts.actorUserId, node, updated, {
          reason: 'done',
          note: `PR #${pr.number} merged${opts.mergedBy ? ` by ${opts.mergedBy}` : ''}`,
        })
        .catch(() => {});
      console.log(`[gh-webhook] PR #${pr.number} merged → transitioned node ${nodeId} (${externalId}) to done`);
    }
    await events.recordPrMerged(node.mapId, nodeId, opts.actorUserId, {
      prNumber: pr.number,
      repo: repoFullName,
      url: pr.html_url ?? null,
      ...(opts.mergedBy ? { mergedBy: opts.mergedBy } : {}),
      mergeCommitSha,
      externalId,
      alreadyDone: wasDone,
    });
    transitions.push({ externalId, nodeId, status, recorded: true });
  }
}
