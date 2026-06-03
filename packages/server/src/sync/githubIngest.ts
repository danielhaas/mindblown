/**
 * GitHub → MindBlown auto-ingest: create a node for every new GitHub issue
 * on a repo bound to a map with `autoImportNewIssues=true`.
 *
 * Background: mindblown#58 auto-links nodes whose titles start with
 * `#NNNN <title>` to the matching GitHub issue when they're created. That
 * closes the loop for the "import once, then keep in sync" workflow, but
 * tickets opened between manual import runs never appear in MindBlown.
 * This module closes that last gap by ingesting new issues on three
 * triggers:
 *
 *   1. **Webhook** — fastest path: `issues.opened` / `issues.reopened` /
 *      `issues.edited` on a repo we recognize. Wired in
 *      `routes/integrations.ts`.
 *   2. **Catchup reconcile** — backstop for missed webhooks. Wired in
 *      `sync/githubCatchup.ts`, reuses the already-fetched issue list.
 *      Catchup ingestion is open-only — closed-without-node ingestion
 *      is reserved for the explicit backfill route.
 *   3. **Backfill endpoint** — one-shot bulk import for unlinked issues
 *      (optionally including issues closed within the last 30 days).
 *      Hard-capped at 200 per call. Wired in `routes/integrations.ts`.
 *
 * Ingested nodes:
 *   - title: `#NNNN <issue.title>` (so the create-node auto-link from
 *     mindblown#58 picks it up and writes externalLinks).
 *   - parent: the map's GitHub Inbox node (lazy-created child of root).
 *   - status: `todo` if open, `done` if closed.
 *   - percentComplete: 0 (open) or 100 (closed).
 *   - createdBy: passed in by the caller — webhook uses the map's
 *     creator since GitHub webhook senders aren't MindBlown users.
 *
 * Idempotency:
 *   - `ensureNodeForIssue` takes a Postgres advisory xact lock keyed on
 *     the externalId, then precheck-scans existing nodes for that
 *     externalId in any map's node tree. So two concurrent ingest calls
 *     for the same issue create exactly one node.
 *   - `ensureInboxNode` checks `maps.github_inbox_node_id`; if that
 *     node is gone (deleted by the user), creates a fresh one and
 *     persists the new id.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { GitHubIssue } from '@mindblown/integrations';
import type { ExternalLink } from '@mindblown/core';

import { db } from '../db/connection.js';
import { integrations, maps, nodes } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';

// ── Types ─────────────────────────────────────────────────────────

export interface IngestContext {
  owner: string;
  repo: string;
  /** UUID of the user to attribute new nodes to (used as `created_by`). */
  createdBy: string;
}

export interface IngestResult {
  status:
    | 'created'
    | 'skipped_exists'
    | 'skipped_disabled'
    | 'skipped_pr'
    | 'skipped_closed_outside_window';
  nodeId?: string;
  mapId: string;
}

/**
 * One map that has opted into auto-import for a given (owner, repo).
 * The `createdBy` here is the map's creator — used as the attribution
 * for nodes ingested for that map. Each map gets its own inbox node, so
 * the same issue can land in two maps if both opt in.
 */
export interface MapTarget {
  mapId: string;
  createdBy: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function buildExternalId(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

/**
 * Take a Postgres advisory xact lock keyed on the externalId so two
 * concurrent ingest calls for the same issue can't both pass the
 * precheck and create duplicate nodes. The lock is released at the
 * end of the *given transaction* — callers MUST be inside a tx, or the
 * lock releases immediately and the race protection is illusory.
 *
 * We use `hashtextextended(text, seed)` to fit the externalId into a
 * bigint key (Postgres requires advisory-lock keys to be int8 / two
 * int4s, not arbitrary text).
 */
async function takeIngestLock(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  externalId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${externalId}, 0))`,
  );
}

/**
 * Look up every node in the given map whose externalLinks contain a
 * GitHub link with the given externalId. Used as the existence precheck
 * inside ensureNodeForIssue. We scan node rows for `mapId` because the
 * same issue may be linked in many maps and we only care about this one.
 *
 * The handle is `tx` so the SELECT participates in the same xact as the
 * advisory lock; if a precheck-then-create sequence ran outside the tx,
 * a concurrent ingest could still slip a duplicate past us.
 */
async function findNodeInMapByExternalId(
  tx: { select: typeof db.select },
  mapId: string,
  externalId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: nodes.id, externalLinks: nodes.externalLinks })
    .from(nodes)
    .where(eq(nodes.mapId, mapId));
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    if (links.some((l) => l.provider === 'github' && l.externalId === externalId)) {
      return row.id;
    }
  }
  return null;
}

/**
 * Find every node anywhere whose externalLinks reference the given
 * externalId. Used by the backfill candidate filter (we want "not
 * already linked to *any* node anywhere") and by tests.
 */
export async function findNodesByExternalIds(
  externalIds: string[],
): Promise<Set<string>> {
  const wanted = new Set(externalIds);
  const found = new Set<string>();
  if (wanted.size === 0) return found;

  const rows = await db
    .select({ externalLinks: nodes.externalLinks })
    .from(nodes);
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    for (const l of links) {
      if (l.provider === 'github' && l.externalId && wanted.has(l.externalId)) {
        found.add(l.externalId);
      }
    }
  }
  return found;
}

// ── Target discovery ──────────────────────────────────────────────

/**
 * Returns every map that has `autoImportNewIssues=true` AND is bound to
 * the given `(owner, repo)`. Covers both binding flavours:
 *
 *   - GitHub App: `maps.githubRepoOwner` / `githubRepoName` set directly.
 *   - PAT integrations: `integrations.config` records `{ owner, repo }`
 *     at the workspace level; every map in that workspace that has
 *     `autoImportNewIssues=true` is treated as bound to the repo. (PAT
 *     integrations are global to a workspace — there's no per-map
 *     binding row to filter on.)
 *
 * Deduplicated by mapId. Order is unspecified.
 */
export async function findIngestTargetMaps(
  owner: string,
  repo: string,
): Promise<MapTarget[]> {
  const targets = new Map<string, MapTarget>();

  // (1) App-bound maps with the flag on.
  const appMaps = await db
    .select({
      id: maps.id,
      createdBy: maps.createdBy,
    })
    .from(maps)
    .where(
      and(
        eq(maps.githubRepoOwner, owner),
        eq(maps.githubRepoName, repo),
        eq(maps.autoImportNewIssues, true),
      ),
    );
  for (const m of appMaps) {
    targets.set(m.id, { mapId: m.id, createdBy: m.createdBy as string });
  }

  // (2) PAT integrations whose (owner, repo) matches → every map in
  // that workspace with autoImportNewIssues=true.
  const patIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, 'github'), eq(integrations.enabled, true)));
  for (const integ of patIntegrations) {
    const cfg = integ.config as { owner?: string; repo?: string } | null;
    if (cfg?.owner !== owner || cfg?.repo !== repo) continue;
    const wsMaps = await db
      .select({ id: maps.id, createdBy: maps.createdBy })
      .from(maps)
      .where(
        and(
          eq(maps.workspaceId, integ.workspaceId),
          eq(maps.autoImportNewIssues, true),
        ),
      );
    for (const m of wsMaps) {
      if (targets.has(m.id)) continue;
      targets.set(m.id, { mapId: m.id, createdBy: m.createdBy as string });
    }
  }

  return [...targets.values()];
}

// ── Inbox node lifecycle ──────────────────────────────────────────

const INBOX_NODE_TITLE = 'GitHub Inbox';

/**
 * Return the map's inbox node id, lazy-creating it if absent OR if the
 * stored id points to a deleted node. The inbox is always a direct
 * child of the map's root node.
 *
 * Race note: two concurrent calls on the same map may both detect a
 * missing inbox and both insert. Outer callers serialise per-issue via
 * the advisory lock in `ensureNodeForIssue`, so in practice two inboxes
 * can only race when two *different* issues are ingested at the same
 * instant before either inbox is persisted. That's a real (but minor)
 * edge case; we accept it because the duplicate is harmless (one inbox
 * just ends up empty) and any user-visible cleanup is trivial.
 */
export async function ensureInboxNode(
  mapId: string,
  createdBy: string,
): Promise<string> {
  const [mapRow] = await db
    .select({
      rootNodeId: maps.rootNodeId,
      inboxId: maps.githubInboxNodeId,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  if (!mapRow) throw new Error(`ensureInboxNode: map ${mapId} not found`);
  if (!mapRow.rootNodeId) {
    throw new Error(`ensureInboxNode: map ${mapId} has no root node`);
  }

  // (1) Cached id present + node still exists → reuse.
  if (mapRow.inboxId) {
    const existing = await nodeDb.getNode(mapRow.inboxId);
    if (existing && existing.mapId === mapId) {
      return mapRow.inboxId;
    }
    // Cached id is stale — fall through to recreate.
  }

  const inbox = await nodeDb.createNode({
    mapId,
    parentId: mapRow.rootNodeId,
    text: INBOX_NODE_TITLE,
    createdBy,
  });
  await db
    .update(maps)
    .set({ githubInboxNodeId: inbox.id, updatedAt: new Date() })
    .where(eq(maps.id, mapId));
  return inbox.id;
}

// ── Per-issue ingest ──────────────────────────────────────────────

const DEFAULT_CLOSED_WINDOW_DAYS = 30;

function isClosedWithinWindow(
  issue: GitHubIssue,
  allowClosedWithinDays: number,
): boolean {
  if (issue.state !== 'closed') return false;
  if (!issue.closed_at) {
    // GitHub omitted closed_at — be permissive and accept it (we wouldn't
    // see a closed issue in practice without this field; the fallback
    // covers test fixtures that don't populate it).
    return true;
  }
  const closedAt = new Date(issue.closed_at).getTime();
  if (Number.isNaN(closedAt)) return true;
  const windowMs = allowClosedWithinDays * 24 * 60 * 60 * 1000;
  return Date.now() - closedAt <= windowMs;
}

export interface EnsureNodeOpts {
  /**
   * How recent a closed issue must be (in days since close) for ingestion
   * to proceed. Defaults to 0 — i.e. closed issues are skipped. The
   * backfill route raises this to 30. The catchup pass leaves it at 0
   * to prevent repopulating "what shipped last month" if `lastSyncedAt`
   * is ever lost.
   */
  allowClosedWithinDays?: number;
}

/**
 * Create a node for the given issue under the inbox, unless one already
 * exists or one of the skip conditions fires.
 *
 * Skip reasons:
 *   - `skipped_pr`: GitHub's issues endpoint returns PRs too; we filter.
 *   - `skipped_exists`: a node in this map already references this
 *     externalId (could be a manually-linked node or a previous ingest).
 *   - `skipped_closed_outside_window`: issue is closed and either no
 *     window allowance was given or it's older than the window.
 */
export async function ensureNodeForIssue(
  mapId: string,
  inboxNodeId: string,
  issue: GitHubIssue,
  ctx: IngestContext,
  opts: EnsureNodeOpts = {},
): Promise<IngestResult> {
  // (1) Drop PRs — the issues endpoint returns both.
  if (issue.pull_request) {
    return { status: 'skipped_pr', mapId };
  }

  const externalId = buildExternalId(ctx.owner, ctx.repo, issue.number);

  // (2) Closed-issue window filter.
  if (issue.state === 'closed') {
    const window = opts.allowClosedWithinDays ?? 0;
    if (window <= 0 || !isClosedWithinWindow(issue, window)) {
      return { status: 'skipped_closed_outside_window', mapId };
    }
  }

  // (3) Wrap lock + precheck + create in a Postgres transaction.
  // pg_advisory_xact_lock only holds for the duration of the current
  // transaction; without an explicit tx, drizzle commits between every
  // statement and the lock releases immediately — making the race
  // protection illusory. By wrapping here, the second concurrent call
  // for the same externalId blocks at takeIngestLock until the first
  // call's tx commits, at which point its precheck reads the freshly-
  // inserted externalLink and returns skipped_exists.
  const isClosed = issue.state === 'closed';
  const text = `#${issue.number} ${issue.title}`;
  type TxResult = { kind: 'created'; nodeId: string; link: ExternalLink } | { kind: 'exists'; nodeId: string };
  const result: TxResult = await db.transaction(async (tx) => {
    await takeIngestLock(tx, externalId);
    const existingNodeId = await findNodeInMapByExternalId(tx, mapId, externalId);
    if (existingNodeId) {
      return { kind: 'exists', nodeId: existingNodeId };
    }
    // The create-node auto-link runs on the HTTP route, not here, so we
    // attach the externalLink ourselves so downstream sync paths
    // (reconcile, webhook close/reopen) can find the node by externalId.
    const created = await nodeDb.createNode({
      mapId,
      parentId: inboxNodeId,
      text,
      createdBy: ctx.createdBy,
      percentComplete: isClosed ? 100 : 0,
      status: isClosed ? 'done' : 'todo',
    });
    const link: ExternalLink = {
      provider: 'github',
      externalId,
      url: issue.html_url,
      syncEnabled: true,
      lastSyncedAt: new Date().toISOString(),
    };
    await nodeDb.updateNode(created.id, {
      externalLinks: [link],
      description: issue.body ?? null,
    });
    return { kind: 'created', nodeId: created.id, link };
  });

  if (result.kind === 'exists') {
    return { status: 'skipped_exists', nodeId: result.nodeId, mapId };
  }

  broadcast(mapId, {
    type: 'node:created',
    nodeId: result.nodeId,
    source: 'github_ingest',
  });

  return { status: 'created', nodeId: result.nodeId, mapId };
}

// ── Top-level fan-out helper ──────────────────────────────────────

export interface IngestSummary {
  /** Count of new nodes created across all target maps. */
  created: number;
  /** Count of issues that didn't produce a node (already linked, closed, PR, etc.). */
  skipped: number;
  /** Per-map count of created nodes. */
  perMap: Record<string, number>;
}

export interface IngestOpts {
  allowClosedWithinDays?: number;
}

/**
 * For each map that has auto-import enabled on the given (owner, repo),
 * ensure an inbox node and ensure a node for every issue.
 *
 * Callers:
 *   - Catchup: passes the already-fetched changed-issues slice with
 *     `allowClosedWithinDays=0` (open-only).
 *   - Webhook: passes a single-element array for the just-opened issue
 *     with `allowClosedWithinDays=0` (the webhook only fires on opened
 *     / reopened / edited, all of which produce an `open` state).
 *   - Backfill: passes the full repo issue list with
 *     `allowClosedWithinDays=30`.
 *
 * Errors per map don't abort the sweep — each map is independent.
 */
export async function ingestNewIssuesForRepo(
  target: { owner: string; repo: string },
  issues: GitHubIssue[],
  opts: IngestOpts = {},
): Promise<IngestSummary> {
  const summary: IngestSummary = { created: 0, skipped: 0, perMap: {} };

  // Open-only pre-filter for catchup (the dominant caller). For the
  // backfill path the caller raises allowClosedWithinDays, which makes
  // ensureNodeForIssue accept closed issues whose closed_at is recent.
  // We don't filter PRs here because ensureNodeForIssue handles that.
  const targets = await findIngestTargetMaps(target.owner, target.repo);
  if (targets.length === 0) return summary;

  for (const t of targets) {
    summary.perMap[t.mapId] = 0;
    let inboxId: string;
    try {
      inboxId = await ensureInboxNode(t.mapId, t.createdBy);
    } catch (err) {
      console.warn(
        `[github-ingest] ensureInboxNode failed for map ${t.mapId}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const issue of issues) {
      try {
        const result = await ensureNodeForIssue(
          t.mapId,
          inboxId,
          issue,
          { owner: target.owner, repo: target.repo, createdBy: t.createdBy },
          opts,
        );
        if (result.status === 'created') {
          summary.created++;
          summary.perMap[t.mapId]++;
        } else {
          summary.skipped++;
        }
      } catch (err) {
        summary.skipped++;
        console.warn(
          `[github-ingest] ensureNodeForIssue failed for ${target.owner}/${target.repo}#${issue.number} in map ${t.mapId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return summary;
}
