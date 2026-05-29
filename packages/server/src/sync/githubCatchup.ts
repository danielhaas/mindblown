/**
 * GitHub catch-up reconciler.
 *
 * Webhooks are the realtime path for GitHub → MindBlown sync, but they're
 * best-effort: server downtime, secret mismatches, and GitHub's bounded
 * redelivery budget all leak events. This module periodically asks GitHub
 * "what's changed since the last clean sweep?" and applies any drift to
 * the linked nodes — so missed webhooks self-heal within one cycle.
 *
 * The state-update logic mirrors the webhook handler in
 * `routes/integrations.ts` (close/reopen with snapshot preservation), so
 * both paths produce identical outcomes. The catch-up sees only the
 * *current* GitHub state per issue (no action verb), so transitions are
 * inferred by comparing GitHub state against the node's MindBlown state.
 */

import { eq, and, isNotNull, sql } from 'drizzle-orm';
import type { GitHubIssue } from '@mindblown/integrations';
import { fetchChangedIssues, mintInstallationToken } from '@mindblown/integrations';
import type { ExternalLink, Node } from '@mindblown/core';

import { db } from '../db/connection.js';
import { integrations, maps, nodes, githubRepoSync } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';
import {
  parseParentReferences,
  applyRollupForFetchedIssues,
} from './parentEpicRollup.js';

// ── Types ─────────────────────────────────────────────────────────

interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  webhookSecret?: string;
}

interface RepoTarget {
  owner: string;
  repo: string;
  /** Resolves a fresh access token at fetch time (App tokens are short-lived). */
  resolveToken: () => Promise<string>;
}

export interface ReconcileResult {
  repo: string;            // "owner/repo"
  fetched: number;         // issues returned by GitHub
  applied: number;         // nodes updated
  skipped: number;         // issues with no linked node
  noTransition: number;    // linked node already in correct state
  durationMs: number;
  since: string | null;
  error?: string;          // present when reconcile failed before completion
}

// ── State helper (idempotent transition logic) ───────────────────

/**
 * Compute the node updates needed to bring `node` in line with the
 * current GitHub `issue` state. Returns null when the node is already
 * consistent (a no-op).
 *
 * Idempotency rules:
 *   - issue closed + node not done  → snapshot pct/status into the link,
 *                                     set pct=100/status=done.
 *   - issue closed + node already done → no-op (don't overwrite an
 *                                     existing snapshot with a closed-state value).
 *   - issue open  + node looks done OR has snapshot → restore from snapshot,
 *                                     clear it. (Falls back to in_progress
 *                                     if no snapshot was ever recorded.)
 *   - issue open  + node not done   → no-op.
 *
 * The webhook path snapshots unconditionally because each webhook event
 * is a single transition; we get the same effect by gating on "is the
 * node already in the target state?".
 */
export function computeStateUpdates(
  node: Pick<Node, 'percentComplete' | 'status' | 'externalLinks'>,
  issue: Pick<GitHubIssue, 'state'>,
  externalId: string,
): nodeDb.UpdateNodeInput | null {
  const linkIdx = node.externalLinks.findIndex(
    (l) => l.provider === 'github' && l.externalId === externalId,
  );
  if (linkIdx < 0) return null;

  const link = node.externalLinks[linkIdx];
  const isClosedOnGitHub = issue.state === 'closed';
  const looksDoneInMB = node.percentComplete === 100 || node.status === 'done';
  const hasSnapshot =
    (link.previousPercentComplete !== undefined && link.previousPercentComplete !== null) ||
    (link.previousStatus !== undefined && link.previousStatus !== null);

  let nextPct: number | null = node.percentComplete ?? null;
  let nextStatus: string | null = node.status ?? null;
  const nextLink: ExternalLink = { ...link, lastSyncedAt: new Date().toISOString() };
  let stateChanged = false;

  if (isClosedOnGitHub && !looksDoneInMB) {
    // Treat as a close transition.
    if (!hasSnapshot) {
      nextLink.previousPercentComplete = node.percentComplete ?? null;
      nextLink.previousStatus = node.status ?? null;
    }
    nextPct = 100;
    nextStatus = 'done';
    stateChanged = true;
  } else if (!isClosedOnGitHub && (looksDoneInMB || hasSnapshot)) {
    // Treat as a reopen transition.
    nextPct = link.previousPercentComplete ?? null;
    nextStatus = link.previousStatus ?? 'in_progress';
    nextLink.previousPercentComplete = null;
    nextLink.previousStatus = null;
    stateChanged = true;
  }

  if (!stateChanged) return null;

  const newLinks = node.externalLinks.map((l, i) => (i === linkIdx ? nextLink : l));

  return {
    percentComplete: nextPct,
    status: nextStatus,
    externalLinks: newLinks,
  };
}

// ── Per-repo reconcile ────────────────────────────────────────────

async function findNodesByExternalIds(
  externalIds: string[],
): Promise<Map<string, { nodeId: string; mapId: string }>> {
  // Single sweep over all nodes that have any github link. We dedupe
  // by externalId once, then only return mappings for the IDs we were
  // asked about. Tradeoff: O(n) per cycle, fine up to ~50k nodes.
  const wanted = new Set(externalIds);
  const result = new Map<string, { nodeId: string; mapId: string }>();
  if (wanted.size === 0) return result;

  const rows = await db
    .select({ id: nodes.id, mapId: nodes.mapId, externalLinks: nodes.externalLinks })
    .from(nodes);
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    for (const l of links) {
      if (l.provider !== 'github' || !l.externalId) continue;
      if (!wanted.has(l.externalId)) continue;
      // First match wins — duplicates are unusual but possible.
      if (!result.has(l.externalId)) {
        result.set(l.externalId, { nodeId: row.id, mapId: row.mapId });
      }
    }
  }
  return result;
}

async function getLastSyncedAt(owner: string, repo: string): Promise<string | null> {
  const [row] = await db
    .select({ lastSyncedAt: githubRepoSync.lastSyncedAt })
    .from(githubRepoSync)
    .where(and(eq(githubRepoSync.owner, owner), eq(githubRepoSync.repo, repo)));
  return row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null;
}

async function setLastSyncedAt(owner: string, repo: string, when: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO github_repo_sync (owner, repo, last_synced_at, updated_at)
    VALUES (${owner}, ${repo}, ${when.toISOString()}, NOW())
    ON CONFLICT (owner, repo) DO UPDATE
      SET last_synced_at = EXCLUDED.last_synced_at,
          updated_at = NOW()
  `);
}

export async function reconcileRepo(target: RepoTarget): Promise<ReconcileResult> {
  const startedAt = new Date();
  const repoLabel = `${target.owner}/${target.repo}`;
  const since = await getLastSyncedAt(target.owner, target.repo);

  // Small overlap buffer: re-fetch the last 60s before `since` to absorb
  // GitHub's eventual-consistency on the `updated_at` index. Cheap (most
  // cycles return zero issues anyway).
  const sinceWithOverlap = since
    ? new Date(new Date(since).getTime() - 60_000).toISOString()
    : null;

  let token: string;
  try {
    token = await target.resolveToken();
  } catch (err) {
    return {
      repo: repoLabel,
      fetched: 0, applied: 0, skipped: 0, noTransition: 0,
      durationMs: Date.now() - startedAt.getTime(),
      since,
      error: `token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let issues: GitHubIssue[];
  try {
    issues = await fetchChangedIssues(target.owner, target.repo, token, sinceWithOverlap);
  } catch (err) {
    return {
      repo: repoLabel,
      fetched: 0, applied: 0, skipped: 0, noTransition: 0,
      durationMs: Date.now() - startedAt.getTime(),
      since,
      error: `fetch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const externalIds = issues.map((i) => `${target.owner}/${target.repo}#${i.number}`);
  const linkIndex = await findNodesByExternalIds(externalIds);

  let applied = 0;
  let skipped = 0;
  let noTransition = 0;

  for (const issue of issues) {
    const externalId = `${target.owner}/${target.repo}#${issue.number}`;
    const hit = linkIndex.get(externalId);
    if (!hit) { skipped++; continue; }

    const node = await nodeDb.getNode(hit.nodeId);
    if (!node) { skipped++; continue; }

    const updates = computeStateUpdates(node, issue, externalId);
    if (!updates) { noTransition++; continue; }

    const updated = await nodeDb.updateNode(hit.nodeId, updates);
    if (updated) {
      applied++;
      broadcast(updated.mapId, {
        type: 'node:updated',
        nodeId: hit.nodeId,
        fields: Object.keys(updates),
        node: updated,
        source: 'github_catchup',
      });
    }
  }

  // ── Parent-epic rollup (#57) ─────────────────────────────────
  // For every changed issue whose title matches one of our child-PR
  // patterns, recompute its parent epic's progress. We dedupe parent
  // numbers across the batch and fetch the full repo issue list at most
  // once (parent rollup needs the WHOLE sibling set, not just the changed
  // slice). On a sleepy repo this is a single extra fetch per cycle; on a
  // busy one with multiple parent matches it's still just one fetch.
  const parentNumbers = new Set<number>();
  for (const issue of issues) {
    for (const n of parseParentReferences(issue.title)) {
      parentNumbers.add(n);
    }
  }
  if (parentNumbers.size > 0) {
    try {
      // since=null → full issue list for accurate sibling counts.
      const allIssues = await fetchChangedIssues(target.owner, target.repo, token, null);
      await applyRollupForFetchedIssues(
        [...parentNumbers],
        allIssues,
        { owner: target.owner, repo: target.repo },
      );
    } catch (err) {
      // Rollup failures don't taint the reconcile result — they just mean
      // parent percentages stay stale until next cycle.
      console.warn(
        '[catchup] Parent-epic rollup failed for',
        repoLabel,
        ':',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Only bump `lastSyncedAt` on success — partial failures retry next tick.
  await setLastSyncedAt(target.owner, target.repo, startedAt);

  return {
    repo: repoLabel,
    fetched: issues.length,
    applied,
    skipped,
    noTransition,
    durationMs: Date.now() - startedAt.getTime(),
    since,
  };
}

// ── Driver: enumerate every repo we know how to reach ────────────

interface DiscoveredTarget extends RepoTarget {
  source: 'app' | 'pat';
}

/**
 * Build the list of repos to reconcile across the deployment.
 *
 * - GitHub App-bound maps contribute (owner, repo) tuples; the token is
 *   minted from the installation_id at fetch time.
 * - Workspace PAT integrations contribute their (owner, repo) with the
 *   stored token.
 *
 * Deduplicated by `${owner}/${repo}` — a repo only needs one fetch per
 * cycle, regardless of how many maps reference it.
 */
async function discoverTargets(): Promise<DiscoveredTarget[]> {
  const seen = new Map<string, DiscoveredTarget>();

  // App-installation maps
  const appMaps = await db
    .select({
      installationId: maps.githubInstallationId,
      owner: maps.githubRepoOwner,
      repo: maps.githubRepoName,
    })
    .from(maps)
    .where(
      and(
        isNotNull(maps.githubInstallationId),
        isNotNull(maps.githubRepoOwner),
        isNotNull(maps.githubRepoName),
      ),
    );
  for (const m of appMaps) {
    if (!m.installationId || !m.owner || !m.repo) continue;
    const key = `${m.owner}/${m.repo}`;
    if (seen.has(key)) continue;
    const installationId = m.installationId;
    seen.set(key, {
      source: 'app',
      owner: m.owner,
      repo: m.repo,
      resolveToken: () => mintInstallationToken(installationId),
    });
  }

  // Legacy PAT integrations
  const patIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, 'github'), eq(integrations.enabled, true)));
  for (const integ of patIntegrations) {
    const cfg = integ.config as unknown as GitHubConfig;
    if (!cfg?.owner || !cfg?.repo || !cfg?.token) continue;
    const key = `${cfg.owner}/${cfg.repo}`;
    if (seen.has(key)) continue;
    const token = cfg.token;
    seen.set(key, {
      source: 'pat',
      owner: cfg.owner,
      repo: cfg.repo,
      resolveToken: async () => token,
    });
  }

  return [...seen.values()];
}

/**
 * Reconcile every known GitHub repo. Errors on one repo don't abort the
 * sweep — each repo is independent.
 */
export async function runAllCatchups(): Promise<ReconcileResult[]> {
  const targets = await discoverTargets();
  const results: ReconcileResult[] = [];
  for (const t of targets) {
    try {
      results.push(await reconcileRepo(t));
    } catch (err) {
      results.push({
        repo: `${t.owner}/${t.repo}`,
        fetched: 0, applied: 0, skipped: 0, noTransition: 0,
        durationMs: 0,
        since: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
