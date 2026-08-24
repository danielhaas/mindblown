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

import { and, eq, ne, sql } from 'drizzle-orm';
import type { GitHubIssue } from '@mindblown/integrations';
import { extractVersionFromMilestone, importGitHubIssues, mintInstallationToken } from '@mindblown/integrations';
import type { ExternalLink } from '@mindblown/core';

import { stampMirrorHash } from '../lib/descriptionMirror.js';
import { pickActiveLane } from '../lib/activeLane.js';
import { db } from '../db/connection.js';
import { integrations, maps, nodes, triageDecisions, versions } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';
import { buildMapContext } from './mapContext.js';
import { recordTriageHistory } from './triageHistory.js';
import { applyTriageLabel } from './triageLabelWriteback.js';
import {
  triageIssue,
  TRIAGE_AUTO_APPLY_CONFIDENCE,
  shouldAutoConfirmSkip,
  computeInputHash,
  isWithinDebounceWindow,
  markTriageDebounce,
  type TriageDecision,
} from './triage.js';

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
    | 'skipped_closed_outside_window'
    | 'triaged_skip'
    | 'triaged_uncertain'
    | 'triaged_low_confidence'
    // #142 cost-opt short-circuits — all three skip the LLM call but
    // still update decided_at on the existing row (so dashboards can
    // tell "we re-checked, same outcome" apart from "stale row").
    | 'triaged_hash_match'
    | 'triaged_debounced'
    | 'metadata_only_skipped';
  nodeId?: string;
  mapId: string;
  /**
   * Set when the triage pipeline ran for this issue (i.e. the map has
   * `triage_enabled = true`). Carries the LLM's decision + the id of
   * the persisted triage_decisions row. Useful for callers that want
   * to render a "what just happened?" line in the operator UI.
   */
  triage?: {
    decisionId: string;
    decision: TriageDecision['decision'];
    confidence: number;
  };
}

/**
 * One map that has opted into auto-import for a given (owner, repo).
 * The `createdBy` here is the map's creator — used as the attribution
 * for nodes ingested for that map. Each map gets its own inbox node, so
 * the same issue can land in two maps if both opt in.
 *
 * `triageEnabled` is carried alongside so `ensureNodeForIssue` doesn't
 * need to re-SELECT `maps.triage_enabled` per issue — for a 200-issue
 * backfill that's 200 round-trips saved.
 */
export interface MapTarget {
  mapId: string;
  createdBy: string;
  triageEnabled: boolean;
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
    .where(and(eq(nodes.mapId, mapId), nodeDb.notDeleted));
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
    .from(nodes)
    .where(nodeDb.notDeleted);
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

  // (1) App-bound maps with the flag on. We pull triageEnabled in the
  // same SELECT so callers don't have to re-query it per issue.
  const appMaps = await db
    .select({
      id: maps.id,
      createdBy: maps.createdBy,
      triageEnabled: maps.triageEnabled,
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
    targets.set(m.id, {
      mapId: m.id,
      createdBy: m.createdBy as string,
      triageEnabled: m.triageEnabled === true,
    });
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
      .select({
        id: maps.id,
        createdBy: maps.createdBy,
        triageEnabled: maps.triageEnabled,
      })
      .from(maps)
      .where(
        and(
          eq(maps.workspaceId, integ.workspaceId),
          eq(maps.autoImportNewIssues, true),
        ),
      );
    for (const m of wsMaps) {
      if (targets.has(m.id)) continue;
      targets.set(m.id, {
        mapId: m.id,
        createdBy: m.createdBy as string,
        triageEnabled: m.triageEnabled === true,
      });
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
  /**
   * Whether the map has triage opted in. When provided, the caller
   * already knows the value (e.g. it was loaded as part of
   * `findIngestTargetMaps`) and `ensureNodeForIssue` skips the
   * per-issue `SELECT maps.triage_enabled` round-trip. When omitted
   * (legacy callers / explicit single-map paths like backfill), the
   * function falls back to reading the column itself.
   */
  triageEnabled?: boolean;
}

// ── Triage-mode ingest helper ────────────────────────────────────

/**
 * Build the create-input for a triaged node. Same defaults as the
 * non-triage path (status from open/closed, percentComplete 0/100,
 * `#NNNN <title>` text so existing webhook handlers still find it via
 * the parsed issue number), but with a configurable parent so place-
 * decisions can land directly under an epic rather than the inbox.
 */
function buildTriagedCreateInput(
  mapId: string,
  parentId: string,
  issue: GitHubIssue,
  ctx: IngestContext,
): Parameters<typeof nodeDb.createNode>[0] {
  const isClosed = issue.state === 'closed';
  return {
    mapId,
    parentId,
    text: `#${issue.number} ${issue.title}`,
    createdBy: ctx.createdBy,
    percentComplete: isClosed ? 100 : 0,
    status: isClosed ? 'done' : 'todo',
  };
  // (tags are populated in the post-create updateNode call, since
  // CreateNodeInput doesn't accept tags. See ensureNodeForIssue and
  // the auto-place path.)
}

/**
 * GH labels → tag list (raw names, sorted).
 *
 * MindBlown does bidirectional `tags ↔ labels` sync (see
 * `routes/nodes.ts` SYNC_FIELDS + `integrations/src/github.ts`
 * updateGitHubIssue). The convention is "node.tags mirrors GH labels."
 * We match that convention here: write raw label names directly.
 *
 * The `priority:*` family is filtered out because MindBlown stores
 * priority in its own `node.priority` field — the bulk-import path at
 * `routes/integrations.ts:821` uses the same filter, so we keep the
 * established contract.
 *
 * An earlier draft of this code used a `gh-label:<name>` prefix scheme,
 * which fought the bidirectional sync: prefixed entries pushed back to
 * GH as new labels, polluting the issue and triggering a webhook loop.
 * Reverted to raw names for that reason.
 *
 * Result is sorted for stable diffing in the caller's no-op check.
 */
export function ghLabelsToTags(
  labels: Array<{ name: string }> | undefined,
): string[] {
  return (labels ?? [])
    .map((l) => l.name)
    .filter((n) => !n.startsWith('priority:'))
    .sort();
}

/**
 * Resolve the release lane (versionId) for a freshly ingested node.
 *
 * Only OPEN work gets a lane — callers skip this for closed issues:
 * the fallback's whole purpose is dispatch visibility, and stamping
 * historical done-work into the current lane would inflate that
 * release's scope, rollup, and completion forecast for nothing.
 *
 * Order of precedence (all candidates limited to planning/active —
 * released AND archived lanes are retired; "a new issue never belongs
 * to an already-shipped release"):
 *   1. `suggestedVersionId` — the triage LLM's pick, when it named one.
 *      Re-validated here (the map-context cache the LLM saw may be up
 *      to 5 minutes stale).
 *   2. `milestoneTitle` — a GH milestone whose `V*:`-prefix matches a
 *      lane by name. Practically dead on the primary repo (0 of 1200
 *      sampled issues carry a milestone), but bulk-import-bootstrapped
 *      maps get their lanes FROM milestone prefixes (status planning),
 *      and for those this is the only signal that routes correctly.
 *   3. The map's active lane: `status='active'` with the highest
 *      sortOrder (= the latest lane currently being worked; id as
 *      deterministic tie-break — nothing enforces unique sortOrder).
 *   4. null — the map has no active lane; the node lands unversioned.
 *
 * The active-lane fallback is deliberate policy, not a shrug: an
 * unversioned node is invisible to the dispatch queue (get_schedule /
 * get_next_ticket filter on version), so "park it unversioned for later
 * review" quietly buries the ticket — and that review queue demonstrably
 * never drains. A node in the wrong lane is visible and trivially
 * movable (`bulk_assign_to_version`); the error costs are asymmetric.
 *
 * Runs on the caller's tx/db handle so it shares visibility and lock
 * state with the rest of the ingest tx.
 */
export async function resolveIngestVersionId(
  handle: nodeDb.DbHandle,
  mapId: string,
  opts: {
    suggestedVersionId?: string | null;
    milestoneTitle?: string | null;
  } = {},
): Promise<string | null> {
  const rows = await handle
    .select({
      id: versions.id,
      name: versions.name,
      status: versions.status,
      sortOrder: versions.sortOrder,
    })
    .from(versions)
    .where(and(eq(versions.mapId, mapId), ne(versions.status, 'released')));
  const eligible = rows.filter(
    (r) => r.status === 'active' || r.status === 'planning',
  );

  if (
    opts.suggestedVersionId &&
    eligible.some((r) => r.id === opts.suggestedVersionId)
  ) {
    return opts.suggestedVersionId;
  }

  if (opts.milestoneTitle) {
    const versionName = extractVersionFromMilestone(opts.milestoneTitle);
    const byMilestone = versionName
      ? eligible.find((r) => r.name === versionName)
      : undefined;
    if (byMilestone) return byMilestone.id;
  }

  const lane = pickActiveLane(eligible);
  return lane?.id ?? null;
}

/**
 * Sync the GH issue's current labels onto every MindBlown node that links
 * to this externalId, in every map. No-op when no node references the
 * externalId. Used by the webhook handler so label changes (which the
 * triage layer skips as cost-opt) still keep node tags fresh.
 *
 * The write replaces the tags array entirely (overwriting any user-set
 * tags). This matches MindBlown's existing convention that tags mirror
 * GH labels — user-set tags don't survive bulk import either.
 *
 * Returns the number of nodes updated.
 */
export async function syncIssueLabelsToNodes(
  externalId: string,
  ghLabels: Array<{ name: string }> | undefined,
): Promise<number> {
  const matches = await findNodesByExternalIdAcrossMaps(externalId);
  if (matches.length === 0) return 0;
  const nextTags = ghLabelsToTags(ghLabels);
  let updated = 0;
  for (const { id, tags } of matches) {
    const cur = (tags ?? []).slice().sort();
    const same =
      cur.length === nextTags.length &&
      cur.every((t, i) => t === nextTags[i]);
    if (same) continue;
    await nodeDb.updateNode(id, { tags: nextTags });
    updated += 1;
  }
  return updated;
}

/**
 * Sibling of findNodeInMapByExternalId that scans ALL maps for nodes
 * referencing the given externalId. Used by the label-sync path which
 * doesn't know which maps care about this issue.
 */
async function findNodesByExternalIdAcrossMaps(
  externalId: string,
): Promise<Array<{ id: string; mapId: string; tags: string[] }>> {
  const rows = await db
    .select({
      id: nodes.id,
      mapId: nodes.mapId,
      tags: nodes.tags,
      externalLinks: nodes.externalLinks,
    })
    .from(nodes)
    .where(nodeDb.notDeleted);
  const out: Array<{ id: string; mapId: string; tags: string[] }> = [];
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    if (links.some((l) => l.provider === 'github' && l.externalId === externalId)) {
      out.push({
        id: row.id,
        mapId: row.mapId as string,
        tags: (row.tags as string[]) ?? [],
      });
    }
  }
  return out;
}

/**
 * Triage-enabled fork of `ensureNodeForIssue`. Runs the LLM, persists
 * the decision in `triage_decisions` (upserting on the unique key so
 * re-triage is idempotent), then either creates a node (high-confidence
 * place) or returns the decision-only result for the caller to surface.
 *
 * The decision row is persisted in ALL cases — even on triage_error.
 * That's deliberate: an operator looking at the unreviewed-decisions
 * queue should see "Claude couldn't decide" as a first-class entry,
 * not a silent gap.
 */
async function ensureNodeForIssueViaTriage(
  mapId: string,
  issue: GitHubIssue,
  ctx: IngestContext,
  externalId: string,
): Promise<IngestResult> {
  // ── Cost-opt #142 layer 2: per-issue debounce ─────────────────
  // If the same (mapId, externalId) was triaged inside the debounce
  // window (default 60 s), short-circuit BEFORE the precheck tx +
  // LLM call. This catches burst webhook deliveries (the GitHub
  // label-bot fires multiple `issues.edited` events in a second when
  // multiple labels change at once) and is the cheapest layer to
  // hit — no DB I/O at all. Hash-match (layer 3) still runs when
  // the window expires; the two layers work together to keep
  // long-running churn cheap.
  //
  // Debounced calls never touch the DB, so we don't bump decided_at
  // here either — the LLM wasn't re-evaluated. The dashboard's "last
  // re-checked at" remains the prior call's timestamp, which is the
  // honest answer.
  if (isWithinDebounceWindow(mapId, externalId)) {
    return { status: 'triaged_debounced', mapId };
  }

  // Pre-compute the canonical input hash for cost-opt #142 layer 3
  // (body-hash idempotency). We pass this into the precheck tx so the
  // hash comparison shares the advisory lock — a concurrent winner
  // whose hash equals this one (e.g. catchup re-running the same
  // issue) will have committed last_input_hash before we read it.
  const incomingHash = computeInputHash(issue);

  // ── Race-safety prelude (mindblown#99 fix 1) ────────────────────
  // We do *two* things inside a transaction BEFORE paying for an LLM
  // call:
  //   a) `pg_advisory_xact_lock` keyed on the externalId, so two
  //      concurrent webhook deliveries for the same issue serialize.
  //   b) The existence precheck — both for "a node already references
  //      this externalId" (operator added it manually, or an earlier
  //      ingest landed it) AND for "an existing triage_decisions row
  //      is operator-reviewed" (mindblown#99 fix 2 — never re-triage
  //      an operator-curated row).
  //
  // If either precheck wins, we return early WITHOUT calling the LLM.
  // That's the fast path; it also means the second of two racing
  // webhook deliveries doesn't pay tokens. The fact-checks are also
  // run inside the tx (sharing the lock) so a concurrent winner that
  // commits in between sees its row visible from this tx as well.
  type PrecheckResult =
    | { kind: 'exists'; nodeId: string }
    | { kind: 'operator_reviewed'; decisionId: string; nodeId: string | null;
        decision: TriageDecision['decision']; confidence: number }
    | { kind: 'hash_match'; decisionId: string; nodeId: string | null;
        decision: TriageDecision['decision']; confidence: number }
    | { kind: 'proceed' };
  const precheck: PrecheckResult = await db.transaction(async (tx) => {
    await takeIngestLock(tx, externalId);

    // (a) Node-existence precheck — uses the same tx-scoped helper as
    // the non-triage path so it sees a concurrent winner's just-
    // committed externalLink.
    const existingNodeId = await findNodeInMapByExternalId(tx, mapId, externalId);
    if (existingNodeId) {
      return { kind: 'exists', nodeId: existingNodeId };
    }

    // (b) Operator-reviewed precheck. Once an operator has reviewed a
    // triage decision, automatic re-triage doesn't overwrite it —
    // explicit reclassify from the UI is required. This contract
    // closes the regression where `issues.edited` webhook fired by an
    // edit on GitHub would wipe a careful operator decision back to
    // `reviewed=false, decidedBy='auto'` (mindblown#99 fix 2).
    const [existingDecision] = await tx
      .select({
        id: triageDecisions.id,
        reviewed: triageDecisions.reviewed,
        decidedBy: triageDecisions.decidedBy,
        decision: triageDecisions.decision,
        confidence: triageDecisions.confidence,
        placedNodeId: triageDecisions.placedNodeId,
        lastInputHash: triageDecisions.lastInputHash,
      })
      .from(triageDecisions)
      .where(
        and(
          eq(triageDecisions.mapId, mapId),
          eq(triageDecisions.externalId, externalId),
        ),
      );
    if (
      existingDecision &&
      existingDecision.reviewed === true &&
      existingDecision.decidedBy === 'operator'
    ) {
      return {
        kind: 'operator_reviewed',
        decisionId: existingDecision.id as string,
        nodeId: (existingDecision.placedNodeId as string | null) ?? null,
        decision: existingDecision.decision as TriageDecision['decision'],
        confidence: existingDecision.confidence as number,
      };
    }

    // (c) Body-hash idempotency (#142 layer 3). If a prior row exists
    // for this (mapId, externalId) AND its stored hash matches the
    // incoming one, the inputs that drive a triage decision haven't
    // changed since last time — skip the LLM call, bump decided_at
    // only (to record "we re-checked at T, same outcome"). First-
    // time triage (no row) and rows with NULL hash (lazy-migrated
    // legacy rows) fall through to the LLM call so the column
    // populates on the next pass.
    if (
      existingDecision &&
      typeof existingDecision.lastInputHash === 'string' &&
      existingDecision.lastInputHash === incomingHash
    ) {
      const decisionId = existingDecision.id as string;
      // Bump decided_at inside the same tx so the timestamp is
      // visible to the next ingest under the lock. We don't touch
      // decision/confidence/placedNodeId — the existing values are
      // by definition still authoritative.
      await tx
        .update(triageDecisions)
        .set({ decidedAt: new Date() })
        .where(eq(triageDecisions.id, decisionId));
      return {
        kind: 'hash_match',
        decisionId,
        nodeId: (existingDecision.placedNodeId as string | null) ?? null,
        decision: existingDecision.decision as TriageDecision['decision'],
        confidence: existingDecision.confidence as number,
      };
    }
    return { kind: 'proceed' };
  });

  if (precheck.kind === 'exists') {
    return { status: 'skipped_exists', nodeId: precheck.nodeId, mapId };
  }
  if (precheck.kind === 'hash_match') {
    // Hash-match short-circuit (#142 layer 3). Stamp the debounce so
    // a burst of identical-payload webhooks rides on this single
    // decision for the next debounce window. Map to the same
    // status code the original decision would have produced; the
    // dashboard treats hash-matches as "we re-checked, same answer".
    markTriageDebounce(mapId, externalId);
    if (precheck.decision === 'place' && precheck.nodeId) {
      return {
        status: 'triaged_hash_match',
        nodeId: precheck.nodeId,
        mapId,
        triage: {
          decisionId: precheck.decisionId,
          decision: precheck.decision,
          confidence: precheck.confidence,
        },
      };
    }
    return {
      status: 'triaged_hash_match',
      mapId,
      triage: {
        decisionId: precheck.decisionId,
        decision: precheck.decision,
        confidence: precheck.confidence,
      },
    };
  }
  if (precheck.kind === 'operator_reviewed') {
    // Treat operator-reviewed rows as authoritative. Map the persisted
    // decision back to the appropriate IngestResult shape so callers
    // (catchup / webhook) see the same status code as if Claude had
    // just produced the same decision — minus the LLM call.
    if (precheck.decision === 'place' && precheck.nodeId) {
      return {
        status: 'created',
        nodeId: precheck.nodeId,
        mapId,
        triage: {
          decisionId: precheck.decisionId,
          decision: precheck.decision,
          confidence: precheck.confidence,
        },
      };
    }
    const status: IngestResult['status'] =
      precheck.decision === 'skip'
        ? 'triaged_skip'
        : precheck.decision === 'uncertain'
          ? 'triaged_uncertain'
          : 'triaged_low_confidence';
    return {
      status,
      mapId,
      triage: {
        decisionId: precheck.decisionId,
        decision: precheck.decision,
        confidence: precheck.confidence,
      },
    };
  }

  // Build the map-context summary and call the LLM. `buildMapContext`
  // is cached (5-min TTL) so back-to-back ingests don't re-fetch the
  // same depth-1 nodes.
  const mapContext = await buildMapContext(mapId);
  const decision = await triageIssue({ issue, mapContext });

  // Validate the proposed parentNodeId one more time before we trust
  // it for a create. `triageIssue` already filters hallucinations
  // against the offered epic list, but the cache might be stale so a
  // belt-and-braces re-check costs nothing.
  const validEpicIds = new Set(mapContext.epics.map((e) => e.nodeId));
  if (
    decision.decision === 'place' &&
    (!decision.parentNodeId || !validEpicIds.has(decision.parentNodeId))
  ) {
    decision.decision = 'uncertain';
    decision.parentNodeId = undefined;
    if (!decision.reason.startsWith('triage_error')) {
      decision.reason = `parent node no longer exists; ${decision.reason}`;
    }
  }

  const shouldAutoApply =
    decision.decision === 'place' &&
    decision.confidence >= TRIAGE_AUTO_APPLY_CONFIDENCE &&
    decision.parentNodeId != null;

  // Persist the decision first, then (if auto-apply) create the node
  // and update placed_node_id. We do this in a single tx (and re-take
  // the advisory lock on the externalId for the duration of this tx)
  // so a crash between the insert and the update can't leave a
  // "place" row with no node, AND so a concurrent racing webhook
  // delivery (rare since we already serialized on the precheck tx
  // above) still serializes on this one.
  type TxResult =
    | {
        kind: 'auto_placed';
        decisionId: string;
        nodeId: string;
        node: Awaited<ReturnType<typeof nodeDb.getNode>>;
        previous: PriorDecisionSnapshot | null;
      }
    | {
        kind: 'decision_only';
        decisionId: string;
        previous: PriorDecisionSnapshot | null;
      }
    | { kind: 'lost_race'; nodeId: string }
    | {
        kind: 'operator_reviewed_late';
        decisionId: string;
        nodeId: string | null;
        decision: TriageDecision['decision'];
        confidence: number;
      };

  // Captured for the audit-history write (#96 Phase 3). When the upsert
  // tx finds no existing row, previous is null → history records 'created'.
  // Otherwise we keep the prior decision/confidence/placedNode so the
  // history row carries a proper before/after delta.
  interface PriorDecisionSnapshot {
    decision: string;
    confidence: number;
    placedNodeId: string | null;
  }

  const result: TxResult = await db.transaction(async (tx) => {
    await takeIngestLock(tx, externalId);

    // Re-run the node-existence precheck inside this tx, in case a
    // concurrent worker landed a node between the precheck tx above
    // and this tx (window during which the lock was released).
    // Cheap insurance; the happy path returns immediately.
    const existingNodeId = await findNodeInMapByExternalId(tx, mapId, externalId);
    if (existingNodeId) {
      return { kind: 'lost_race', nodeId: existingNodeId };
    }

    // Mirror the operator-reviewed precheck inside this tx (Ray's
    // #100 Round 2 fix — lost-race operator-protect). The precheck tx
    // above checks "node exists" AND "operator-reviewed row exists",
    // but during the LLM-call window between Tx A and Tx B an
    // operator can mark a row reviewed=true, decidedBy='operator'.
    // Without this re-check, the upsert's SET clause below would
    // overwrite that decision back to auto + unreviewed, wiping the
    // operator's curation. The cost is one extra index lookup —
    // cheaper than a wasted LLM round-trip, cheaper than losing the
    // operator decision. We re-fetch (don't reuse the precheck row)
    // because the precheck tx is long-since closed; the visibility
    // we need is "what's committed NOW," and the advisory lock above
    // means no other ingest tx can stomp before we exit this block.
    const [existingDecisionInUpsertTx] = await tx
      .select({
        id: triageDecisions.id,
        reviewed: triageDecisions.reviewed,
        decidedBy: triageDecisions.decidedBy,
        decision: triageDecisions.decision,
        confidence: triageDecisions.confidence,
        placedNodeId: triageDecisions.placedNodeId,
      })
      .from(triageDecisions)
      .where(
        and(
          eq(triageDecisions.mapId, mapId),
          eq(triageDecisions.externalId, externalId),
        ),
      );
    if (
      existingDecisionInUpsertTx &&
      existingDecisionInUpsertTx.reviewed === true &&
      existingDecisionInUpsertTx.decidedBy === 'operator'
    ) {
      return {
        kind: 'operator_reviewed_late',
        decisionId: existingDecisionInUpsertTx.id as string,
        nodeId: (existingDecisionInUpsertTx.placedNodeId as string | null) ?? null,
        decision: existingDecisionInUpsertTx.decision as TriageDecision['decision'],
        confidence: existingDecisionInUpsertTx.confidence as number,
      };
    }

    // Snapshot the prior decision (if any) so the post-tx history write
    // can record a proper before/after delta. When no row existed, the
    // snapshot is null → history records 'created' rather than
    // 'overridden'. Captured here while we already hold the row in memory.
    const priorSnapshot: PriorDecisionSnapshot | null =
      existingDecisionInUpsertTx
        ? {
            decision: existingDecisionInUpsertTx.decision as string,
            confidence: existingDecisionInUpsertTx.confidence as number,
            placedNodeId:
              (existingDecisionInUpsertTx.placedNodeId as string | null) ?? null,
          }
        : null;

    // Upsert the decision row. ON CONFLICT updates the existing row in
    // place so re-triage (operator hits `POST .../reclassify`) doesn't
    // accumulate duplicates.
    //
    // The operator-reviewed precheck above already short-circuits when
    // existingDecision.reviewed=true && decidedBy='operator', so by the
    // time we reach this upsert we know the row (if any) is either
    // auto-decided or operator-touched-but-not-reviewed. The SET clause
    // therefore overwrites the auto fields freely.
    // Capture the LLM's suggested parent for both branches of the
    // upsert. Always reflects the latest auto-triage call: a `place`
    // decision carries the suggested epic, a `skip`/`uncertain` decision
    // carries null. The column is intentionally distinct from
    // placed_node_id (which only flips when a node is actually created)
    // so the Override modal can pre-select the LLM's pick on
    // low-confidence places.
    const suggestedParentNodeId =
      decision.decision === 'place' ? (decision.parentNodeId ?? null) : null;
    // Sibling persistence for the lane pick — dropping it here meant
    // every deferred decision lost the lane the LLM read from the
    // issue, and the operator-confirm paths fell back to the plain
    // active lane.
    const suggestedVersionId =
      decision.decision === 'place' ? (decision.versionId ?? null) : null;

    // Persist the canonical input hash so the next webhook can short-
    // circuit via the hash-match precheck (#142 layer 3). We DON'T
    // write the hash on triage_error so a transient LLM failure can
    // be retried on the next webhook — locking in the hash would
    // mean a 500 from Anthropic permanently muted re-triage for an
    // unchanged issue, which is the opposite of what we want.
    const isTriageError = decision.reason.startsWith('triage_error');
    const nextInputHash: string | null = isTriageError ? null : incomingHash;

    // Auto-confirm-skip lever: a high-confidence skip on a CLOSED issue
    // is persisted already-reviewed so it never queues for the operator.
    // decidedBy stays 'auto' — the operator-protect precheck above only
    // shields decidedBy='operator' rows, so a later webhook can still
    // overwrite this decision.
    const autoConfirmSkip = shouldAutoConfirmSkip(decision, issue.state);

    const [decisionRow] = await tx
      .insert(triageDecisions)
      .values({
        mapId,
        externalId,
        issueTitle: issue.title,
        issueState: issue.state,
        decision: decision.decision,
        reason: decision.reason,
        confidence: decision.confidence,
        placedNodeId: null,
        suggestedParentNodeId,
        suggestedVersionId,
        decidedBy: 'auto',
        reviewed: autoConfirmSkip,
        reviewedAt: autoConfirmSkip ? new Date() : null,
        lastInputHash: nextInputHash,
      })
      .onConflictDoUpdate({
        target: [triageDecisions.mapId, triageDecisions.externalId],
        set: {
          issueTitle: issue.title,
          issueState: issue.state,
          decision: decision.decision,
          reason: decision.reason,
          confidence: decision.confidence,
          // Don't clobber a prior auto-placed node if an operator
          // re-triages — placed_node_id stays whatever it was unless
          // the new decision is also auto-apply, in which case the
          // INSERT-branch fields below run.
          suggestedParentNodeId,
          suggestedVersionId,
          decidedAt: new Date(),
          decidedBy: 'auto',
          reviewed: autoConfirmSkip,
          reviewedAt: autoConfirmSkip ? new Date() : null,
          reviewedBy: null,
          // Refresh the input hash on every successful LLM call so
          // the next webhook can short-circuit. On triage_error we
          // pass `null` to clear a stale hash — better to re-call
          // the LLM next time than to lock in an error-state hash.
          lastInputHash: nextInputHash,
        },
      })
      .returning({ id: triageDecisions.id });

    if (!shouldAutoApply || !decision.parentNodeId) {
      return {
        kind: 'decision_only',
        decisionId: decisionRow.id,
        previous: priorSnapshot,
      };
    }

    // Auto-apply: create the node under the LLM-chosen parent.
    const created = await nodeDb.createNode(
      buildTriagedCreateInput(mapId, decision.parentNodeId, issue, ctx),
      tx,
    );
    // The description write below mirrors the issue body — stamp the
    // link so the issues.edited guard can tell mirror from curation
    // later (lib/descriptionMirror.ts).
    const link: ExternalLink = stampMirrorHash(
      {
        provider: 'github',
        externalId,
        url: issue.html_url,
        syncEnabled: true,
        lastSyncedAt: new Date().toISOString(),
        state: issue.state,
      },
      issue.body,
    );
    // Same lane routing as the non-triage path, but the LLM's own lane
    // pick (decision.versionId) wins when it named a valid one — keeps
    // the Unversioned bucket from refilling after an auto-place. Closed
    // issues get no lane (historical work must not inflate the lane).
    const triageVersionId =
      issue.state === 'closed'
        ? null
        : await resolveIngestVersionId(tx, mapId, {
            suggestedVersionId: decision.versionId,
            milestoneTitle: issue.milestone?.title,
          });
    const updated = await nodeDb.updateNode(
      created.id,
      {
        externalLinks: [link],
        description: issue.body ?? null,
        tags: ghLabelsToTags(issue.labels),
        ...(triageVersionId ? { versionId: triageVersionId } : {}),
      },
      undefined,
      tx,
    );
    await tx
      .update(triageDecisions)
      .set({ placedNodeId: created.id })
      .where(eq(triageDecisions.id, decisionRow.id));
    return {
      kind: 'auto_placed',
      decisionId: decisionRow.id,
      nodeId: created.id,
      node: updated ?? created,
      previous: priorSnapshot,
    };
  });

  if (result.kind === 'lost_race') {
    // A concurrent worker landed the node between our precheck tx and
    // the upsert tx (rare; happens only if we lost the lock window).
    // No tokens wasted — we already paid above, but the concurrent
    // winner persisted both the node AND its own decision row, so
    // returning skipped_exists is the safe outcome.
    return { status: 'skipped_exists', nodeId: result.nodeId, mapId };
  }

  if (result.kind === 'operator_reviewed_late') {
    // Ray's #100 Round 2 fix — an operator marked the row reviewed
    // during the LLM-call window between the precheck tx and the
    // upsert tx. We did pay for the LLM call (sunk cost — the wider
    // fix is to also short-circuit upstream once the lock can't
    // observe the change, but that's a bigger rework), but the
    // operator's decision wins. Mirror the precheck's mapping of
    // operator_reviewed → matching IngestResult so downstream
    // consumers see the operator's call, not the (now-discarded)
    // LLM call.
    if (result.decision === 'place' && result.nodeId) {
      return {
        status: 'created',
        nodeId: result.nodeId,
        mapId,
        triage: {
          decisionId: result.decisionId,
          decision: result.decision,
          confidence: result.confidence,
        },
      };
    }
    const lateStatus: IngestResult['status'] =
      result.decision === 'skip'
        ? 'triaged_skip'
        : result.decision === 'uncertain'
          ? 'triaged_uncertain'
          : 'triaged_low_confidence';
    return {
      status: lateStatus,
      mapId,
      triage: {
        decisionId: result.decisionId,
        decision: result.decision,
        confidence: result.confidence,
      },
    };
  }

  // Stamp the debounce window for any LLM-paid path EXCEPT triage_error.
  // The hash column above is also gated on non-error, so the two layers
  // stay in sync: an error doesn't lock out re-evaluation either via
  // debounce or via hash-match. Stamped before history/label writebacks
  // so a downstream failure doesn't undo the debounce.
  if (!decision.reason.startsWith('triage_error')) {
    markTriageDebounce(mapId, externalId);
  }

  if (result.kind === 'auto_placed') {
    broadcast(mapId, {
      type: 'node:created',
      node: result.node,
      source: 'github_ingest_triage',
    });
    // Phase 3 (#96) audit-history record. previous=null → 'created';
    // any prior row (auto-revisit) → 'overridden'. The helper swallows
    // its own errors so a logging failure can't block ingest.
    await recordTriageHistory({
      decisionId: result.decisionId,
      changedBy: 'auto',
      changeType: result.previous ? 'overridden' : 'created',
      previousDecision: result.previous?.decision ?? null,
      newDecision: decision.decision,
      previousConfidence: result.previous?.confidence ?? null,
      newConfidence: decision.confidence,
      previousParentNodeId: result.previous?.placedNodeId ?? null,
      newParentNodeId: result.nodeId,
      reason: decision.reason,
    });
    // Phase 3 (#96) opt-in label writeback. Best-effort; helper internally
    // gates on map's writeback flag + GH token availability.
    await applyTriageLabel({
      mapId,
      externalId,
      decision: decision.decision,
      placedNodeId: result.nodeId,
    });
    return {
      status: 'created',
      nodeId: result.nodeId,
      mapId,
      triage: {
        decisionId: result.decisionId,
        decision: decision.decision,
        confidence: decision.confidence,
      },
    };
  }

  // Decision-only outcomes: no node created. Map the decision to a
  // dedicated status code so callers can distinguish "intentionally
  // not created" from "skipped because already exists".
  const status: IngestResult['status'] =
    decision.decision === 'skip'
      ? 'triaged_skip'
      : decision.decision === 'uncertain'
        ? 'triaged_uncertain'
        : 'triaged_low_confidence';
  await recordTriageHistory({
    decisionId: result.decisionId,
    changedBy: 'auto',
    changeType: result.previous ? 'overridden' : 'created',
    previousDecision: result.previous?.decision ?? null,
    newDecision: decision.decision,
    previousConfidence: result.previous?.confidence ?? null,
    newConfidence: decision.confidence,
    previousParentNodeId: result.previous?.placedNodeId ?? null,
    newParentNodeId: null,
    reason: decision.reason,
  });
  // Decision-only outcomes carry no placed node — the gate inside
  // applyTriageLabel will skip the `triage:placed` add for an auto
  // 'place' decision that didn't auto-apply (#178).
  await applyTriageLabel({
    mapId,
    externalId,
    decision: decision.decision,
    placedNodeId: null,
  });
  return {
    status,
    mapId,
    triage: {
      decisionId: result.decisionId,
      decision: decision.decision,
      confidence: decision.confidence,
    },
  };
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

  // (2.5) AI triage fork (#92, #93). Maps that have opted in run every
  // new issue through `triageIssue()` before any node is created. The
  // decision is persisted in `triage_decisions` regardless of outcome
  // (audit trail + later operator review), but only HIGH-confidence
  // place-decisions actually create a node. Skip / uncertain / low-
  // confidence place all persist the decision and return early — the
  // map structure stays untouched until the operator reviews.
  //
  // Maps with `triage_enabled = false` fall through to the existing
  // flat-under-inbox path with zero behavioural change.
  //
  // Perf: when the caller already knows the flag (the multi-map fan-out
  // does, via `findIngestTargetMaps`), it passes it in opts so we skip
  // the per-issue `SELECT maps.triage_enabled` round-trip. The backfill
  // helper and any legacy direct caller omits the opt and we fall back
  // to reading the column.
  let triageEnabled: boolean;
  if (typeof opts.triageEnabled === 'boolean') {
    triageEnabled = opts.triageEnabled;
  } else {
    const [mapRow] = await db
      .select({ triageEnabled: maps.triageEnabled })
      .from(maps)
      .where(eq(maps.id, mapId));
    triageEnabled = mapRow?.triageEnabled === true;
  }
  if (triageEnabled) {
    return ensureNodeForIssueViaTriage(mapId, issue, ctx, externalId);
  }

  // (3) Wrap lock + precheck + create + link-update in a Postgres
  // transaction. The advisory lock holds for the duration of this tx; the
  // precheck SELECT, the createNode insert, and the updateNode that
  // attaches the externalLink ALL run on the `tx` handle, so they share
  // the same transaction scope. Two consequences:
  //
  //   1. Race safety: a concurrent call for the same externalId blocks
  //      at takeIngestLock until this tx commits, then its precheck reads
  //      the (now committed) externalLink and returns skipped_exists.
  //   2. Atomicity: if any throw happens between createNode and end of
  //      tx, the rollback undoes the insert + the link update together —
  //      no orphan node is left behind. (Previously these calls ran on
  //      the global `db` handle and autocommitted independently, which
  //      worked by accident for the happy path but leaked on any throw
  //      in between. mindblown#66.)
  const isClosed = issue.state === 'closed';
  const text = `#${issue.number} ${issue.title}`;
  type TxResult =
    | { kind: 'created'; nodeId: string; node: Awaited<ReturnType<typeof nodeDb.getNode>>; link: ExternalLink }
    | { kind: 'exists'; nodeId: string };
  const result: TxResult = await db.transaction(async (tx) => {
    await takeIngestLock(tx, externalId);
    const existingNodeId = await findNodeInMapByExternalId(tx, mapId, externalId);
    if (existingNodeId) {
      return { kind: 'exists', nodeId: existingNodeId };
    }
    // The create-node auto-link runs on the HTTP route, not here, so we
    // attach the externalLink ourselves so downstream sync paths
    // (reconcile, webhook close/reopen) can find the node by externalId.
    const created = await nodeDb.createNode(
      {
        mapId,
        parentId: inboxNodeId,
        text,
        createdBy: ctx.createdBy,
        percentComplete: isClosed ? 100 : 0,
        status: isClosed ? 'done' : 'todo',
      },
      tx,
    );
    // The description write below mirrors the issue body — stamp the
    // link so the issues.edited guard can tell mirror from curation
    // later (lib/descriptionMirror.ts).
    const link: ExternalLink = stampMirrorHash(
      {
        provider: 'github',
        externalId,
        url: issue.html_url,
        syncEnabled: true,
        lastSyncedAt: new Date().toISOString(),
        state: issue.state,
      },
      issue.body,
    );
    // Route the new node into a lane so it doesn't land in the
    // Unversioned bucket — invisible to the dispatch queue — for the
    // next housekeeping sweep to re-discover. Non-triage maps have no
    // LLM suggestion: milestone match first, then the active lane.
    // Closed issues get no lane (historical work must not inflate it).
    const versionId = isClosed
      ? null
      : await resolveIngestVersionId(tx, mapId, {
          milestoneTitle: issue.milestone?.title,
        });
    const updated = await nodeDb.updateNode(
      created.id,
      {
        externalLinks: [link],
        description: issue.body ?? null,
        tags: ghLabelsToTags(issue.labels),
        ...(versionId ? { versionId } : {}),
      },
      undefined,
      tx,
    );
    // Prefer the post-update row (it has the externalLinks/description
    // populated). Fall back to `created` if updateNode returned null for
    // any reason — the broadcast will still carry a valid Node shape.
    return { kind: 'created', nodeId: created.id, node: updated ?? created, link };
  });

  if (result.kind === 'exists') {
    return { status: 'skipped_exists', nodeId: result.nodeId, mapId };
  }

  // Match the broadcast shape used by every other `node:created` emitter
  // (routes/nodes.ts, routes/ai.ts, ai/backend.ts). The frontend reads
  // `msg.node` and will TypeError on undefined.
  broadcast(mapId, {
    type: 'node:created',
    node: result.node,
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
  /**
   * Count of issues whose per-issue ensure-call threw (or whose map's
   * inbox-ensure threw). Surfaced separately from `skipped` so callers
   * (catchup) can decide whether to bump their per-repo cursor — bumping
   * past a failed issue would orphan it until manual backfill.
   */
  errored: number;
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
  const summary: IngestSummary = { created: 0, skipped: 0, errored: 0, perMap: {} };

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
      // Treat every issue in this map's slice as errored — none of them
      // can be processed without a viable inbox, and the catchup caller
      // needs to know not to bump its cursor.
      summary.errored += issues.length;
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
          { ...opts, triageEnabled: t.triageEnabled },
        );
        if (result.status === 'created') {
          summary.created++;
          summary.perMap[t.mapId]++;
        } else {
          summary.skipped++;
        }
      } catch (err) {
        // Track separately from `skipped` so the catchup driver can decide
        // not to bump lastSyncedAt past a transient failure.
        summary.errored++;
        console.warn(
          `[github-ingest] ensureNodeForIssue failed for ${target.owner}/${target.repo}#${issue.number} in map ${t.mapId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return summary;
}

// ── Backfill a specific map ───────────────────────────────────────

/**
 * Number of days back from "now" we consider a closed issue eligible
 * for backfill. Matches the constant inlined in the
 * `/api/maps/:mapId/github/ingest-new` route. Kept here so the
 * auto-backfill caller picks up the same window without duplicating
 * the magic number.
 */
export const BACKFILL_CLOSED_WINDOW_DAYS = 30;

export interface BackfillMapResult {
  /** Count of new nodes created in this map. */
  imported: number;
  /** Total candidates (unlinked issues passing the closed-window filter). */
  total: number;
  /** True when `total` exceeded `maxToImport` and we ingested only a slice. */
  capped: boolean;
  /** Count of issues whose per-issue ingest threw (logged inside). */
  errored: number;
}

export interface BackfillMapOpts {
  /**
   * Cap on the number of issues to actually ingest in this call. Default
   * 200 (matches the manual backfill endpoint). When `total > maxToImport`,
   * the helper ingests the first `maxToImport` candidates and reports
   * `capped: true`.
   */
  maxToImport?: number;
  /**
   * Override the `createdBy` attribution for new nodes. Defaults to the
   * map's `createdBy` — used as the attribution for auto-backfill calls
   * where there's no acting user.
   */
  createdBy?: string;
  /**
   * Closed-issue window in days. Defaults to 30 (matches the manual
   * backfill endpoint). The auto-backfill caller from drift audit can
   * pass 0 to restrict to open issues only, since drift only counts open.
   */
  allowClosedWithinDays?: number;
}

/**
 * Bulk-backfill into a single map: fetch every issue on the bound repo,
 * filter to unlinked + (open OR closed-within-window), then ensure a
 * node for the first `maxToImport` of them. Resolves the GitHub token
 * the same way as `getGitHubContextForMap` in `routes/integrations.ts`
 * (App-installation first, PAT fallback).
 *
 * Extracted from the `POST /api/maps/:mapId/github/ingest-new` handler
 * so both the operator-clicks-the-button path and the auto-backfill
 * drift remediation path share the same code. Differences from the
 * inline route version:
 *
 *   - Lives in `sync/githubIngest.ts` instead of the route file so the
 *     audit code can import it without dragging in Fastify types.
 *   - Returns a typed result instead of throwing for non-2xx cases;
 *     callers decide how to surface "no integration" / "fetch failed".
 *
 * Throws only on token-resolution / fetch failure / no-binding — those
 * are infra-level problems the caller needs to know about (so the drift
 * audit's Kuma push can flip to `down`). Per-issue ingest errors are
 * caught + counted; the helper still returns its summary.
 */
export async function backfillMap(
  mapId: string,
  opts: BackfillMapOpts = {},
): Promise<BackfillMapResult> {
  const maxToImport = opts.maxToImport ?? 200;
  const allowClosedWithinDays = opts.allowClosedWithinDays ?? BACKFILL_CLOSED_WINDOW_DAYS;

  const [mapRow] = await db
    .select({
      id: maps.id,
      createdBy: maps.createdBy,
      workspaceId: maps.workspaceId,
      githubInstallationId: maps.githubInstallationId,
      githubRepoOwner: maps.githubRepoOwner,
      githubRepoName: maps.githubRepoName,
      triageEnabled: maps.triageEnabled,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  if (!mapRow) {
    throw new Error(`backfillMap: map ${mapId} not found`);
  }
  const triageEnabled = mapRow.triageEnabled === true;

  // Resolve owner/repo + token. App-binding first, then workspace PAT.
  // This mirrors `getGitHubContextForMap` in routes/integrations.ts —
  // we don't import it to avoid a cycle (it lives in the routes layer).
  let owner: string | null = null;
  let repo: string | null = null;
  let token: string | null = null;

  if (mapRow.githubInstallationId && mapRow.githubRepoOwner && mapRow.githubRepoName) {
    try {
      token = await mintInstallationToken(mapRow.githubInstallationId);
      owner = mapRow.githubRepoOwner;
      repo = mapRow.githubRepoName;
    } catch (err) {
      console.warn(
        `[backfill] mint installation token failed for map ${mapId}, falling back to PAT:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!token) {
    const [integ] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.workspaceId, mapRow.workspaceId),
          eq(integrations.provider, 'github'),
          eq(integrations.enabled, true),
        ),
      );
    if (integ) {
      const cfg = integ.config as { owner?: string; repo?: string; token?: string } | null;
      if (cfg?.owner && cfg?.repo && cfg?.token) {
        owner = cfg.owner;
        repo = cfg.repo;
        token = cfg.token;
      }
    }
  }

  if (!owner || !repo || !token) {
    throw new Error(`backfillMap: no GitHub binding resolvable for map ${mapId}`);
  }

  const importedIssues = await importGitHubIssues(owner, repo, token, {
    includeAll: true,
  });

  const allExternalIds = importedIssues.map((i) => i.externalLink.externalId);
  const linkedIds = await findNodesByExternalIds(allExternalIds);

  const cutoffMs = Date.now() - allowClosedWithinDays * 24 * 60 * 60 * 1000;
  const candidates = importedIssues
    .filter((item) => !linkedIds.has(item.externalLink.externalId))
    .filter((item) => {
      if (item.issue.state === 'open') return true;
      if (allowClosedWithinDays <= 0) return false;
      if (!item.issue.closed_at) return true;
      const closed = new Date(item.issue.closed_at).getTime();
      if (Number.isNaN(closed)) return true;
      return closed >= cutoffMs;
    });

  const total = candidates.length;
  const slice = candidates.slice(0, maxToImport);
  const createdBy = opts.createdBy ?? (mapRow.createdBy as string);

  const inboxId = await ensureInboxNode(mapId, createdBy);

  let imported = 0;
  let errored = 0;
  for (const item of slice) {
    try {
      const result = await ensureNodeForIssue(
        mapId,
        inboxId,
        item.issue,
        { owner, repo, createdBy },
        { allowClosedWithinDays, triageEnabled },
      );
      if (result.status === 'created') imported++;
    } catch (err) {
      errored++;
      console.warn(
        `[backfill] ingest #${item.issue.number} failed for map ${mapId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    imported,
    total,
    capped: total > maxToImport,
    errored,
  };
}
