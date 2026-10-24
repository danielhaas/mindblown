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

import { eq, and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { linksAnyExternalId } from '../db/externalLinkFilter.js';
import type { GitHubIssue, ForgeClient } from '@mindblown/integrations';
import {
  fetchChangedIssues,
  getGitHubIssue,
  GitHubApiError,
  updateGitHubIssue,
  probeIssueLanded,
  extractClosingIssueRefs,
  reopenGitHubIssue,
} from '@mindblown/integrations';
import {
  forgeFromInstallation,
  forgeFromIntegration,
  isServableIntegrationConfig,
  FORGE_PROVIDERS,
  type ForgeIntegrationConfig,
} from '../lib/forge.js';
import type { ExternalLink, Node } from '@mindblown/core';
import { prBlocksNodeReopen, hasCloseSnapshot, isForgeLink } from '@mindblown/core';

import { db } from '../db/connection.js';
import { integrations, maps, nodes, githubRepoSync } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';
import {
  parseParentReferences,
  applyRollupForFetchedIssues,
} from './parentEpicRollup.js';
import { ingestNewIssuesForRepo } from './githubIngest.js';
import { markWorkStarted } from './workStartSync.js';
import { handlePrClosed, type GhPrPayload } from './prSync.js';
import { pushKumaHeartbeat } from './kumaPush.js';
import { sdNotifyWatchdog } from './sdNotify.js';
import { appBindingKey, clearForgeRefusal, noteForgeRefusal, refusalStatus, rowBindingKey } from './forgeRefusals.js';

// ── Per-repo auth-failure tracking (#75) ─────────────────────────
//
// Consecutive 401 ticks per `${owner}/${repo}` key. When this hits
// `CATCHUP_AUTH_FAILURE_THRESHOLD` (default 3), the catchup pushes
// `status=down msg=auth_failed:owner/repo` to a dedicated Kuma push
// monitor (`KUMA_GITHUB_AUTH_FAILURE_PUSH_URL`). On any successful
// fetch the counter resets to 0.
//
// Concurrency: a single mindblown-api process serialises catchup
// ticks (`runAllCatchups` is invoked from the catchup scheduler, not
// concurrently), so the in-memory `Map` is safe without a lock. Two
// concurrent processes hitting the same DB would each track their
// own counter — fine, they'd just escalate independently.
const consecutiveAuthFailures = new Map<string, number>();

const DEFAULT_AUTH_FAILURE_THRESHOLD = 3;

function getAuthFailureThreshold(): number {
  const raw = process.env.CATCHUP_AUTH_FAILURE_THRESHOLD;
  if (!raw) return DEFAULT_AUTH_FAILURE_THRESHOLD;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUTH_FAILURE_THRESHOLD;
  return n;
}

/**
 * Reset (for tests) the per-repo consecutive-auth-failure counter.
 * Production code never calls this — it's exported only so unit tests
 * can start each case from a clean slate without leaking state across
 * cases. The module-level `Map` is private otherwise.
 */
export function _resetAuthFailureCountersForTests(): void {
  consecutiveAuthFailures.clear();
}

/**
 * Snapshot the per-repo counter (for tests). Production code does not
 * read this.
 */
export function _getAuthFailureCountForTests(repoLabel: string): number {
  return consecutiveAuthFailures.get(repoLabel) ?? 0;
}

/**
 * Push the `auth_failed` alarm to Kuma. No-op when the env var is
 * unset (same pattern as the catchup heartbeat — dev/test environments
 * don't need to wire this).
 */
async function pushAuthFailureAlarm(repoLabel: string): Promise<void> {
  // Forge-neutral name first (#368); the old GitHub-named variable keeps working.
  const url = process.env.KUMA_FORGE_AUTH_FAILURE_PUSH_URL ?? process.env.KUMA_GITHUB_AUTH_FAILURE_PUSH_URL;
  if (!url) return;
  await pushKumaHeartbeat(
    url,
    'down',
    `auth_failed:${repoLabel}`,
    '[kuma-push] github auth failure',
  );
}

// ── Types ─────────────────────────────────────────────────────────

interface RepoTarget {
  owner: string;
  repo: string;
  /** Resolves an authenticated client at fetch time (App tokens are short-lived). */
  resolveForge: () => Promise<ForgeClient>;
  /** Which credential this is (sync/forgeRefusals.ts) — a refused fetch is recorded under it (#513). */
  bindingKey?: string;
}

export interface ReconcileResult {
  repo: string;            // "owner/repo"
  fetched: number;         // issues returned by GitHub
  applied: number;         // nodes updated
  skipped: number;         // issues with no linked node
  noTransition: number;    // linked node already in correct state
  /**
   * Links whose cached open/closed mirror was absent or stale and got
   * repaired in place (no revision bump). Expect a large number on the
   * first tick after deploy — most links predate the `state` field — then
   * near-zero steady state. Includes `directResolved`.
   */
  mirrorRepaired: number;
  /**
   * Subset of `mirrorRepaired` resolved by the one-by-one pass rather
   * than the issue list — PR-numbered links and links older than the
   * sync cursor, which the list structurally never returns.
   */
  directResolved: number;
  /** Done nodes held open on a PR whose close was never delivered, resolved this tick (#423). */
  heldClosesResolved: number;
  /** Issues closed while their PR is still open, reopened this tick (#295/#309). */
  prematureClosesHealed: number;
  /**
   * Count of node-update errors hit during the state-sync loop. Surfaced
   * alongside `ingestErrored` so partial failures are observable.
   */
  stateSyncErrored: number;
  /**
   * Count of new nodes auto-created in the ingestion pass (across every
   * map opted into auto-import for this repo).
   */
  ingested: number;
  /**
   * Count of per-issue / per-inbox errors raised during the ingest pass.
   * When >0 we deliberately do NOT bump `lastSyncedAt` so the next catchup
   * tick re-fetches the failed issues instead of orphaning them.
   */
  ingestErrored: number;
  /**
   * Nodes flipped to in-progress by the work-start backstop (#245).
   * Absent on error-path results — the backstop never ran.
   */
  workStarted?: number;
  durationMs: number;
  since: string | null;
  error?: string;          // present when reconcile failed before completion
  /**
   * True when `error` is a GitHub 401 (revoked PAT, suspended App
   * install). Auth failures are excluded from tick health — they have
   * their own escalation channel (`pushAuthFailureAlarm`), and one
   * tenant's dead credential must not starve the watchdog/heartbeat
   * for the whole service (see incident 2026-07-10: a stale demo PAT
   * restart-looped prod every ~24 min for two weeks).
   */
  authFailure?: boolean;
  /**
   * True when the forge refused the repo (401/403/404, `refusalStatus`):
   * a dead token, no access, or a repo deleted under its binding. The loop
   * is alive and the binding is the problem, so it doesn't make the tick
   * unhealthy either (Plan health shows it; incident 2026-10-23: a deleted
   * test map's Gitea row answered 404 every tick and the watchdog
   * restart-looped prod every ~14 min for a day).
   */
  refused?: boolean;
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
 *
 * When a transition *does* fire, the link's own `state` mirror rides
 * along on the same write. The mirror-only case — node already
 * consistent but `state` absent or stale — deliberately still returns
 * null here, because repairing it must not bump the node's revision —
 * the reconcile loop handles that case via `setExternalLinkState`.
 */
/**
 * Where may the sync cursor advance to after a clean (error-free) tick?
 *
 * Normally to `startedAt` — the whole change window was seen. But when
 * the fetch was TRUNCATED by the backstop, the slice is an updated-ASC
 * prefix of the window: jumping to `startedAt` would permanently skip
 * every change past the cut (it is no longer "changed since cursor" on
 * any later tick). Advance only to the last processed issue's
 * updated_at, so the next tick resumes there and drains the tail.
 * Pure — exported for tests.
 */
export function computeCursorAdvance(
  startedAt: Date,
  fetchTruncated: boolean,
  issues: Array<Pick<GitHubIssue, 'updated_at'>>,
): Date {
  if (!fetchTruncated || issues.length === 0) return startedAt;
  const last = new Date(issues[issues.length - 1].updated_at);
  return Number.isNaN(last.getTime()) ? startedAt : last;
}

export function computeStateUpdates(
  node: Pick<Node, 'percentComplete' | 'status' | 'externalLinks' | 'linkedPr'> &
    Partial<Pick<Node, 'completedAt'>>,
  issue: Pick<GitHubIssue, 'state'>,
  externalId: string,
): nodeDb.UpdateNodeInput | null {
  const linkIdx = node.externalLinks.findIndex(
    (l) => isForgeLink(l) && l.externalId === externalId,
  );
  if (linkIdx < 0) return null;

  const link = node.externalLinks[linkIdx];
  const isClosedOnGitHub = issue.state === 'closed';
  const looksDoneInMB = node.percentComplete === 100 || node.status === 'done';
  const hasSnapshot = hasCloseSnapshot(link);

  // Since the gate in updateGitHubIssue, "issue open, node done" is the
  // NORMAL STATE while a PR is running — the agent sets the node to done
  // when it opens the PR, and the issue deliberately stays open until the
  // merge. Without this gate the reopen branch below would read that as
  // "reopened on GitHub" and reset percentComplete to null (the snapshot is
  // empty because the close path never ran) — the progress would be lost
  // for good. So we block ONLY while a PR is running WITHOUT a snapshot; an
  // existing snapshot turns the reset into a lossless restore, and an
  // abandoned PR means the work did NOT land — the node must not sit at
  // done/100 forever then.
  // Semantics + incident rationale: prBlocksNodeReopen in @mindblown/core
  // (counterpart of the outbound gate prBlocksIssueClose).
  // A second, broader guard for the same danger — and the reason it became
  // necessary is this PR itself.
  //
  // `prBlocksNodeReopen(null, …)` returns false: without a mirror there is
  // nothing to veto. Before the close gate that was harmless, because a
  // done node closed its issue immediately — the reopen branch was
  // unreachable for this shape. Now the sync deliberately keeps the issue
  // OPEN while the node is done, and the hold path keeps PATCHing
  // title/body/labels, which bumps `updated_at` and pulls the issue into
  // the next 5-minute catchup. If `linkedPr` is empty at that moment (the
  // webhook never arrived — exactly the situation this PR was built for),
  // the branch below would take "issue open + node done" as a reopen and
  // write `percentComplete: null, status: 'in_progress'`.
  //
  // Without a snapshot this reset is not a restore but data loss: there is
  // no recorded prior state to fall back to. It is the same "wipe progress
  // irrecoverably" argument the comment above already makes for
  // `state === 'open'` — just never extended to the empty mirror.
  //
  // Price, paid deliberately: an issue reopened by hand on GitHub with no
  // mirror and no snapshot is no longer repaired by the catchup on its own.
  // The event for that is `issues.reopened`, and its webhook path
  // (routes/integrations.ts) stays untouched.
  const emptyMirrorOnDoneNode =
    node.linkedPr == null && !hasSnapshot && looksDoneInMB;
  const blockReopen =
    prBlocksNodeReopen(node.linkedPr, hasSnapshot, node.completedAt) ||
    emptyMirrorOnDoneNode;

  const ghState: 'open' | 'closed' = isClosedOnGitHub ? 'closed' : 'open';

  let nextPct: number | null = node.percentComplete ?? null;
  let nextStatus: string | null = node.status ?? null;
  const nextLink: ExternalLink = {
    ...link,
    lastSyncedAt: new Date().toISOString(),
    state: ghState,
  };
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
  } else if (!isClosedOnGitHub && (looksDoneInMB || hasSnapshot) && !blockReopen) {
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

// ── Direct-resolve sweep for links the issue list never surfaces ──

/**
 * How many unresolved links to resolve per repo per tick. One GitHub API
 * call each, so this is a deliberate trickle: the common case is zero
 * candidates, and a repo with a real backlog drains over several ticks
 * rather than spending its whole rate limit in one.
 */
const UNRESOLVED_LINK_BUDGET = 25;

/**
 * Resolve `state` for links the main loop structurally cannot reach.
 *
 * `fetchChangedIssues` drops pull requests (`!i.pull_request`), so a node
 * linked to a PR number — GitHub shares one number space between issues
 * and PRs — is never visited, and its `state` stays absent forever. The
 * single-item endpoint has no such blind spot: `/issues/{n}` happily
 * returns a PR, carrying both `state` and a `pull_request` marker.
 *
 * A 404 (deleted, transferred, or simply a typo'd number) leaves the link
 * untouched, so it comes back as a candidate next tick. That's bounded
 * waste — at most one call per permanently-dead link per tick — and it's
 * logged, so a growing count is visible rather than silent.
 */
export async function resolveUnlistedLinks(
  target: RepoTarget,
  forge: ForgeClient,
  budget: number = UNRESOLVED_LINK_BUDGET,
): Promise<{ resolved: number; unresolvable: number }> {
  const repoFullName = `${target.owner}/${target.repo}`;
  const candidates = await nodeDb.findLinksMissingState(repoFullName, budget);
  if (candidates.length === 0) return { resolved: 0, unresolvable: 0 };

  let resolved = 0;
  let unresolvable = 0;

  for (const c of candidates) {
    const number = parseInt(c.externalId.slice(repoFullName.length + 1), 10);
    if (!Number.isFinite(number)) { unresolvable++; continue; }

    try {
      const item = await getGitHubIssue(target.owner, target.repo, number, forge);
      await nodeDb.setExternalLinkState(
        c.nodeId,
        c.externalId,
        item.state === 'closed' ? 'closed' : 'open',
        item.pull_request != null,
      );
      resolved++;
    } catch (err) {
      // 404 is the expected shape here (dead/typo'd reference), not an
      // outage — don't let it fail the tick.
      unresolvable++;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/404/.test(msg)) {
        console.warn(`[catchup] direct resolve failed for ${c.externalId}:`, msg);
      }
    }
  }

  if (unresolvable > 0) {
    console.warn(
      `[catchup] ${repoFullName}: ${unresolvable} link(s) could not be resolved ` +
        `(deleted, transferred, or bad number) — they stay candidates next tick.`,
    );
  }

  return { resolved, unresolvable };
}

// ── Held-close backstop (#423) ────────────────────────────────────

/** Nodes asked about per repo per tick — one PR fetch each. */
const HELD_CLOSE_BUDGET = 10;
/** An in-review PR is asked about again after this long, not every tick. */
const HELD_CLOSE_RECHECK_MS = 30 * 60_000;
const heldCloseCheckedAt = new Map<string, number>();
const prematureCloseCheckedAt = new Map<string, number>();

/** Test hook: forget when each node was last asked about. */
export function _resetHeldCloseChecksForTests(): void {
  heldCloseCheckedAt.clear();
  prematureCloseCheckedAt.clear();
}

/**
 * Replay a `pull_request.closed` the webhook never delivered.
 *
 * A done node whose PR is in flight keeps its issue open on purpose (the
 * close gate in `updateGitHubIssue`). The delivery that ends that hold is
 * `pull_request.closed`; when it is missed — no webhook yet, the forge or
 * MindBlown down, a dropped delivery — the mirror says `open` forever, the
 * issue stays open, the node stays done, and no later sync revisits it:
 * the issue never changes, so the changed-issue loop never sees it.
 *
 * For a bounded slice of such nodes this asks the forge for the PR. Still
 * open, or no longer referencing the issue → nothing (asked again after
 * HELD_CLOSE_RECHECK_MS). Closed → what the live webhook would have done,
 * through the same handlers and gates, stamped with the PR's own close
 * time (the livelock rule in core/linkedPr.ts compares against it):
 *   - merged to the default branch: the merge commit is stamped on the
 *     link FIRST and the issue closed as completed on that evidence; only
 *     after the close succeeded is the mirror cleared. A failed close
 *     leaves the mirror armed, so the node stays a candidate and is
 *     retried — never stranded done-with-open-issue and no mirror.
 *   - merged elsewhere (a release branch): the mirror records it; both
 *     gates keep holding, as live.
 *   - closed unmerged: like `handleAbandonedPr`, nothing is undone while
 *     a replacement PR is in flight; one that already landed the work
 *     closes the issue on its merge commit, as above. Otherwise the
 *     mirror records the death and the inbound `computeStateUpdates` with
 *     the forge's "open" rolls the node back off done — unless the node
 *     was claimed done AFTER the PR died, in which case that claim wins
 *     and the outbound close runs instead.
 *
 * A NOT-done node with such a mirror (#308) holds nothing, but its phantom
 * PR stays listed as open (`/api/prs/open`, the fleet's merge queue): for
 * those a closed PR is only replayed into the mirror.
 */
export async function resolveHeldCloses(
  target: RepoTarget,
  forge: ForgeClient,
  budget: number = HELD_CLOSE_BUDGET,
  now: number = Date.now(),
): Promise<{ checked: number; closed: number; rolledBack: number; mirrorsCleared: number }> {
  const repoFullName = `${target.owner}/${target.repo}`;
  for (const [id, at] of heldCloseCheckedAt) {
    if (now - at >= HELD_CLOSE_RECHECK_MS) heldCloseCheckedAt.delete(id);
  }
  // Recently-asked nodes are excluded BEFORE the budget cut, done nodes
  // first: idle in-review PRs on not-done nodes (#308) must not crowd a
  // stuck done node out of every tick.
  const candidates = (await nodeDb.findHeldCloseCandidates(repoFullName))
    .filter((c) => !heldCloseCheckedAt.has(c.nodeId))
    .sort((a, b) => Number(b.done) - Number(a.done))
    .slice(0, budget);
  let checked = 0;
  let closed = 0;
  let rolledBack = 0;
  let mirrorsCleared = 0;

  for (const c of candidates) {
    heldCloseCheckedAt.set(c.nodeId, now);
    checked++;
    try {
      const pr = await forge.getPullRequest(target.owner, target.repo, c.prNumber);
      if (pr.state !== 'closed') continue;
      const issueNumber = Number(c.externalId.slice(repoFullName.length + 1));
      if (!extractClosingIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`).includes(issueNumber)) continue;

      const merged = pr.merged ?? pr.merged_at != null;
      const closedAt = pr.closed_at ?? pr.merged_at ?? null;
      const replay = (defaultBranch: string | null) =>
        handlePrClosed(
          repoFullName,
          { number: pr.number, title: pr.title, body: pr.body, state: 'closed', merged, base: { ref: pr.base.ref } } as GhPrPayload,
          defaultBranch,
          closedAt,
          c.nodeId, // this candidate's mirror only — siblings are settled on their own turn
        );

      // One probe answers the default branch, a replacement PR in flight
      // and work that already landed.
      const probe = await probeIssueLanded(target.owner, target.repo, issueNumber, forge);
      const defaultBranch = probe.defaultBranch ?? null;

      if (!c.done) {
        // #308: nothing is held on a not-done node — only the mirror has to
        // learn the PR is gone, so it stops counting as an open PR. Merged
        // work reaches the node through the issue its merge closes.
        await replay(defaultBranch);
        mirrorsCleared++;
        console.log(`[catchup] stale PR mirror cleared: ${c.externalId} — PR #${pr.number} ${merged ? 'merged' : 'closed'}`);
        continue;
      }

      // The work landed on the default branch — through this PR, or (it
      // died) through a replacement whose delivery was missed as well.
      const mergedHere = merged && defaultBranch != null && pr.base.ref === defaultBranch;
      const landedElsewhere = !merged && probe.landed != null;
      if (mergedHere || landedElsewhere) {
        const node = await nodeDb.getNode(c.nodeId);
        const link = node?.externalLinks.find((l) => isForgeLink(l) && l.externalId === c.externalId);
        if (!node || !link) continue;
        // The merge evidence first: the close decision then needs no probe,
        // and survives a failed attempt below.
        const sha = mergedHere ? (pr.merge_commit_sha ?? probe.landed?.mergeCommitSha ?? null) : probe.landed!.mergeCommitSha;
        const prNumber = mergedHere ? pr.number : probe.landed!.number;
        let links = node.externalLinks;
        let stamped = link;
        if (sha && link.mergeCommitSha !== sha) {
          stamped = { ...link, mergeCommitSha: sha, mergedPrNumber: prNumber };
          links = node.externalLinks.map((l) => (l === link ? stamped : l));
          await nodeDb.updateNode(c.nodeId, { externalLinks: links });
        }
        const result = await updateGitHubIssue({ ...node, externalLinks: links }, stamped, forge);
        if (result.stateAction !== 'closed_completed') continue; // retried next round, mirror still armed
        await nodeDb.setExternalLinkState(c.nodeId, c.externalId, 'closed');
        await replay(defaultBranch);
        closed++;
        console.log(`[catchup] held close resolved: ${c.externalId} closed — PR #${prNumber} landed`);
        continue;
      }

      if (!merged && probe.inFlight) {
        // A replacement PR is working on it: the live paths take it from
        // there (handleAbandonedPr's rule).
        continue;
      }

      await replay(defaultBranch);
      if (merged) continue; // merged off the default branch: both gates hold

      const node = await nodeDb.getNode(c.nodeId);
      if (!node) continue;
      const updates = computeStateUpdates(node, { state: 'open' }, c.externalId);
      if (updates) {
        const updated = await nodeDb.updateNode(c.nodeId, updates);
        if (updated) {
          rolledBack++;
          console.log(`[catchup] held close resolved: ${c.externalId} stays open, node back off done — PR #${pr.number} closed unmerged`);
          broadcast(updated.mapId, {
            type: 'node:updated',
            nodeId: c.nodeId,
            fields: Object.keys(updates),
            node: updated,
            source: 'github_catchup',
          });
        }
        continue;
      }
      // Rollback refused: the node was claimed done after the PR died. That
      // claim wins (livelock rule) — let the outbound decision close it.
      const link = node.externalLinks.find((l) => isForgeLink(l) && l.externalId === c.externalId);
      if (!link) continue;
      const result = await updateGitHubIssue(node, link, forge);
      if (result.stateAction === 'closed_completed') {
        await nodeDb.setExternalLinkState(c.nodeId, c.externalId, 'closed');
        closed++;
        console.log(`[catchup] held close resolved: ${c.externalId} closed — done claimed after PR #${pr.number} died`);
      }
    } catch (err) {
      console.warn(`[catchup] held-close check failed for ${c.externalId}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked, closed, rolledBack, mirrorsCleared };
}

/**
 * Reopen an issue that was closed while its PR is still open (#295/#309).
 *
 * The outbound close asks the forge for an open closing PR before it
 * closes, but it cannot see a PR that does not exist yet (the node was set
 * done before `gh pr create`) or that the forge has not indexed yet (done
 * seconds after the PR opened). Then the issue closes as completed with
 * no commit behind it; the PR webhook arms the mirror a moment later, and
 * from then on every gate holds — on an issue that is already closed.
 * Nothing healed that: the node is done and the issue closed, which reads
 * as consistent.
 *
 * For a bounded slice of such nodes this asks the forge. The issue is
 * reopened only when all of it holds: the PR is still open and still says
 * `Closes #N`, the issue is still closed, not as "not planned", and its
 * latest close came from no commit (an API/UI close — not work landing).
 * The node stays done: with its PR in flight `prBlocksNodeReopen` keeps it
 * there when the reopen echoes back, and the merge closes the issue
 * through the normal gate. Links with a close snapshot are skipped (an
 * outside close — and the reopen echo would restore the snapshot). Every
 * verdict, reopen or genuine close, is recorded as `closeCheckedForPr`, so
 * a person who closes the issue again during the same PR is not overruled
 * and a genuine close is not re-asked every tick. Before reopening, the
 * landing probe must find no merged PR for the issue — the backstop where
 * the close event cannot tell (Gitea has no close reason).
 */
export async function healPrematureCloses(
  target: RepoTarget,
  forge: ForgeClient,
  budget: number = HELD_CLOSE_BUDGET,
  now: number = Date.now(),
): Promise<{ checked: number; reopened: number }> {
  const repoFullName = `${target.owner}/${target.repo}`;
  for (const [id, at] of prematureCloseCheckedAt) {
    if (now - at >= HELD_CLOSE_RECHECK_MS) prematureCloseCheckedAt.delete(id);
  }
  const candidates = (await nodeDb.findPrematureCloseCandidates(repoFullName, budget * 5))
    .filter((c) => !prematureCloseCheckedAt.has(c.nodeId))
    .slice(0, budget);
  let checked = 0;
  let reopened = 0;

  for (const c of candidates) {
    prematureCloseCheckedAt.set(c.nodeId, now);
    checked++;
    try {
      const issueNumber = Number(c.externalId.slice(repoFullName.length + 1));
      const pr = await forge.getPullRequest(target.owner, target.repo, c.prNumber);
      if (pr.state !== 'open') continue; // its close is resolveHeldCloses' business
      const settle = () => nodeDb.patchExternalLink(c.nodeId, c.externalId, { closeCheckedForPr: pr.number });
      if (!extractClosingIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`).includes(issueNumber)) {
        await settle();
        continue;
      }

      const issue = await getGitHubIssue(target.owner, target.repo, issueNumber, forge);
      if (issue.state !== 'closed') {
        // Already open again (by a person, or a reopen we missed): just
        // bring the mirror up to date.
        await nodeDb.setExternalLinkState(c.nodeId, c.externalId, 'open');
        continue;
      }
      if (issue.state_reason === 'not_planned') {
        await settle();
        continue;
      }
      const close = await forge.getLatestCloseEvent(target.owner, target.repo, issueNumber);
      if (!close || close.commitId) {
        await settle(); // a commit closed it: that work landed
        continue;
      }
      const probe = await probeIssueLanded(target.owner, target.repo, issueNumber, forge);
      if (probe.landed) {
        await settle(); // another PR already landed the work
        continue;
      }

      await reopenGitHubIssue({ externalId: c.externalId }, forge);
      // Mirror-only write: the node itself does not change.
      await nodeDb.patchExternalLink(c.nodeId, c.externalId, { state: 'open', closeCheckedForPr: pr.number });
      reopened++;
      console.log(`[catchup] premature close healed: ${c.externalId} reopened — PR #${pr.number} still open`);
    } catch (err) {
      console.warn(`[catchup] premature-close check failed for ${c.externalId}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked, reopened };
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
    .from(nodes)
    // Archived maps are frozen: their links are invisible to the reconciler.
    .where(and(nodeDb.notDeleted, nodeDb.onActiveMap, linksAnyExternalId(wanted)));
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    for (const l of links) {
      if (!isForgeLink(l) || !l.externalId) continue;
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

  let forge: ForgeClient;
  try {
    forge = await target.resolveForge();
  } catch (err) {
    // Mirror the fetch-401 escalation below (#83 follow-up, #86): a
    // suspended/uninstalled GitHub App install throws at
    // `mintInstallationToken`, NOT at `fetchChangedIssues`, so without
    // this branch the consecutive-401 counter never ticked for the
    // App-suspended failure mode. App-suspended is arguably the more
    // common production failure on `mind.project.li`. Other token
    // errors (PAT lookup throwing for non-401 reasons, etc.) stay on
    // the "no counter bump" path — they're transient and shouldn't
    // pin the escalation.
    const isAuthFailure = err instanceof GitHubApiError && err.status === 401;
    if (isAuthFailure) {
      const next = (consecutiveAuthFailures.get(repoLabel) ?? 0) + 1;
      consecutiveAuthFailures.set(repoLabel, next);
      const threshold = getAuthFailureThreshold();
      if (next >= threshold) {
        await pushAuthFailureAlarm(repoLabel);
      }
    }
    const refused = refusalStatus(err);
    if (refused && target.bindingKey) noteForgeRefusal(target.bindingKey, refused);
    return {
      repo: repoLabel,
      fetched: 0, applied: 0, skipped: 0, noTransition: 0, mirrorRepaired: 0, directResolved: 0, heldClosesResolved: 0, prematureClosesHealed: 0, stateSyncErrored: 0, ingested: 0, ingestErrored: 0,
      durationMs: Date.now() - startedAt.getTime(),
      since,
      error: `token: ${err instanceof Error ? err.message : String(err)}`,
      ...(isAuthFailure && { authFailure: true }),
      ...((refused || err instanceof UnservableBindingError) && { refused: true }),
    };
  }

  let issues: GitHubIssue[];
  let fetchTruncated = false;
  try {
    const fetchResult = await fetchChangedIssues(target.owner, target.repo, forge, sinceWithOverlap);
    issues = fetchResult.issues;
    fetchTruncated = fetchResult.truncated;
  } catch (err) {
    // 401-specific escalation path (#75). The "auth revoked" failure
    // mode looks identical to a transient fetch error in the existing
    // path — the operator sees `error: fetch: GitHub API 401` and has
    // to grep logs to diagnose. Track consecutive 401s per repo and
    // fire a dedicated Kuma alarm once we've crossed the threshold,
    // so the operator gets `auth_failed:owner/repo` instead of a
    // generic "catchup is broken".
    const isAuthFailure = err instanceof GitHubApiError && err.status === 401;
    if (isAuthFailure) {
      const next = (consecutiveAuthFailures.get(repoLabel) ?? 0) + 1;
      consecutiveAuthFailures.set(repoLabel, next);
      const threshold = getAuthFailureThreshold();
      if (next >= threshold) {
        // Push every tick once we're over the threshold (not just
        // the threshold-crossing tick). Kuma's "down" state is
        // sticky as long as the pushes keep arriving with `down`;
        // letting subsequent ticks fall silent would cause Kuma to
        // also alarm on "monitor went dark" after its push-timeout,
        // which double-counts the same incident. Keeping the alarm
        // hot every tick also means a fixed install (real success)
        // immediately resets the counter and the next clean tick
        // can let the monitor go UP again.
        await pushAuthFailureAlarm(repoLabel);
      }
    }
    const refused = refusalStatus(err);
    if (refused && target.bindingKey) noteForgeRefusal(target.bindingKey, refused);
    return {
      repo: repoLabel,
      fetched: 0, applied: 0, skipped: 0, noTransition: 0, mirrorRepaired: 0, directResolved: 0, heldClosesResolved: 0, prematureClosesHealed: 0, stateSyncErrored: 0, ingested: 0, ingestErrored: 0,
      durationMs: Date.now() - startedAt.getTime(),
      since,
      error: `fetch: ${err instanceof Error ? err.message : String(err)}`,
      ...(isAuthFailure && { authFailure: true }),
      ...(refused && { refused: true }),
    };
  }

  // Successful fetch — clear the per-repo auth-failure counter so the
  // next 401 starts over at 1. This MUST happen even if subsequent
  // passes (ingest, rollup) fail, because the auth-failure detector
  // is specifically about the GitHub credential, not about downstream
  // node-write errors.
  consecutiveAuthFailures.delete(repoLabel);
  if (target.bindingKey) clearForgeRefusal(target.bindingKey);

  const externalIds = issues.map((i) => `${target.owner}/${target.repo}#${i.number}`);
  const linkIndex = await findNodesByExternalIds(externalIds);

  let applied = 0;
  let skipped = 0;
  let noTransition = 0;
  let mirrorRepaired = 0;
  let stateSyncErrored = 0;

  for (const issue of issues) {
    const externalId = `${target.owner}/${target.repo}#${issue.number}`;
    const hit = linkIndex.get(externalId);
    if (!hit) { skipped++; continue; }

    try {
      const node = await nodeDb.getNode(hit.nodeId);
      if (!node) { skipped++; continue; }

      const updates = computeStateUpdates(node, issue, externalId);
      if (!updates) {
        // No progress/status transition, but the link's cached open/closed
        // mirror may still be absent (most links were created without it)
        // or stale. Repair it in place — no revision bump, no broadcast,
        // since nothing the user authored has changed.
        const link = node.externalLinks.find(
          (l) => isForgeLink(l) && l.externalId === externalId,
        );
        const ghState = issue.state === 'closed' ? 'closed' : 'open';
        if (link && link.state !== ghState) {
          await nodeDb.setExternalLinkState(hit.nodeId, externalId, ghState);
          mirrorRepaired++;
        }
        noTransition++;
        continue;
      }

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
      } else {
        // updateNode returned null — treat as a transient failure so the
        // cursor doesn't advance past this issue.
        stateSyncErrored++;
      }
    } catch (err) {
      stateSyncErrored++;
      console.warn(
        '[catchup] state-sync failed for',
        externalId,
        ':',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Direct-resolve pass for links the list can't reach ───────────
  // PR-numbered links and links to issues older than the sync cursor are
  // never returned by `fetchChangedIssues`, so the loop above cannot
  // repair them however many times it runs. Resolve a bounded slice of
  // them one-by-one. Best-effort: a failure here must not fail the tick
  // or hold the cursor, since the candidates are re-derived next time.
  let directResolved = 0;
  try {
    const r = await resolveUnlistedLinks(target, forge);
    directResolved = r.resolved;
    mirrorRepaired += r.resolved;
  } catch (err) {
    console.warn(
      '[catchup] direct-resolve pass failed for',
      repoLabel,
      ':',
      err instanceof Error ? err.message : err,
    );
  }

  // ── Held-close backstop (#423) ───────────────────────────────────
  // A done node held open on a PR whose close was never delivered. Same
  // contract as the direct-resolve pass: bounded, best-effort, never
  // fails the tick or holds the cursor.
  let heldClosesResolved = 0;
  try {
    const r = await resolveHeldCloses(target, forge);
    heldClosesResolved = r.closed + r.rolledBack + r.mirrorsCleared;
  } catch (err) {
    console.warn(
      '[catchup] held-close pass failed for',
      repoLabel,
      ':',
      err instanceof Error ? err.message : err,
    );
  }

  // ── Premature-close heal (#295/#309) ─────────────────────────────
  // Same contract: bounded, best-effort, never fails the tick.
  let prematureClosesHealed = 0;
  try {
    const r = await healPrematureCloses(target, forge);
    prematureClosesHealed = r.reopened;
  } catch (err) {
    console.warn(
      '[catchup] premature-close pass failed for',
      repoLabel,
      ':',
      err instanceof Error ? err.message : err,
    );
  }

  // ── Work-start backstop (#245) ───────────────────────────────────
  // The webhook owns the realtime "PR opened / issue assigned →
  // in_progress" transition; this pass heals assignments whose webhook
  // was missed. Only the assigned signal is reconciled here — the
  // already-fetched issue slice carries `assignees`, whereas PR-open
  // drift would need an extra PR-list fetch per repo (and the
  // `synchronize` webhook trigger re-covers open PRs on their next
  // push anyway). Best-effort: a failure is logged but doesn't block
  // the cursor — the transition is idempotent and an assigned issue
  // stays assigned, so any later change to it retries naturally.
  const assignedOpenIds = issues
    .filter((i) => i.state === 'open' && (i.assignees?.length ?? 0) > 0)
    .map((i) => `${target.owner}/${target.repo}#${i.number}`)
    .filter((id) => linkIndex.has(id));
  let workStarted = 0;
  if (assignedOpenIds.length > 0) {
    try {
      workStarted = await markWorkStarted(assignedOpenIds, 'github_catchup');
    } catch (err) {
      console.warn(
        '[catchup] work-start backstop failed for',
        repoLabel,
        ':',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Auto-ingest of new issues (gap-closer for between-import tickets) ─
  // For every map opted into auto-import on this repo, create a node for
  // any issue we haven't seen yet. Reuses the already-fetched `issues`
  // slice — no extra GitHub round-trip. Open-only here: closed-without-
  // node ingestion is reserved for the explicit backfill route so we
  // don't repopulate "what shipped last month" if `lastSyncedAt` is ever
  // lost or rewound.
  let ingestCreated = 0;
  let ingestErrored = 0;
  try {
    const ingest = await ingestNewIssuesForRepo(
      { owner: target.owner, repo: target.repo },
      issues,
    );
    ingestCreated = ingest.created;
    ingestErrored = ingest.errored;
  } catch (err) {
    // A throw from the fan-out helper itself (rare — it catches per-issue
    // and per-inbox already) is treated as failing every issue in the
    // window, so the cursor doesn't advance past anything we tried.
    ingestErrored = issues.length || 1;
    console.warn(
      '[catchup] new-issue ingest failed for',
      repoLabel,
      ':',
      err instanceof Error ? err.message : err,
    );
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
      // since=null → full issue list for accurate sibling counts. A
      // truncated list would produce WRONG sibling counts (the newest-
      // updated issues are exactly the ones missing), so we skip the
      // rollup rather than write a wrong parent percentage — stale
      // beats wrong, next cycle retries.
      const { issues: allIssues, truncated: rollupTruncated } =
        await fetchChangedIssues(target.owner, target.repo, forge, null);
      if (rollupTruncated) {
        console.warn(
          '[catchup] skipping parent-epic rollup for',
          repoLabel,
          '— full issue list was truncated, sibling counts would be wrong',
        );
      } else {
        await applyRollupForFetchedIssues(
          [...parentNumbers],
          allIssues,
          { owner: target.owner, repo: target.repo },
        );
      }
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

  // Only bump `lastSyncedAt` when both passes succeeded for every issue in
  // the window. Bumping past a failed issue would mean the next catchup
  // tick skips it entirely (it's no longer "changed since cursor"), so
  // the issue stays orphaned until manual backfill. The 60s overlap
  // buffer accepts re-fetching some issues already; widening the retry
  // window when something actually failed is the conservative choice.
  //
  // Truncated fetch (backstop tripped): the slice is updated-ASC, so
  // everything we processed is a contiguous prefix of the change
  // window. Advance the cursor only to the last PROCESSED issue's
  // updated_at — the next tick resumes there and drains the tail,
  // instead of jumping to startedAt and permanently skipping every
  // change the backstop cut off.
  //
  // That prefix reasoning holds only where the list IS updated-ASC —
  // GitHub. Gitea has no sort on its issue list (newest-created first),
  // so a truncated slice there is not a prefix of anything: leave the
  // cursor where it was and let the next tick re-read the window.
  const orderedByUpdated = forge.endpoint.kind === 'github';
  if (ingestErrored === 0 && stateSyncErrored === 0 && fetchTruncated && !orderedByUpdated) {
    console.warn(
      '[catchup] fetch was truncated for',
      repoLabel,
      `and ${forge.endpoint.kind} lists are not updated-ordered — keeping the cursor; narrow the window or raise the backstop.`,
    );
  } else if (ingestErrored === 0 && stateSyncErrored === 0) {
    const nextCursor = computeCursorAdvance(startedAt, fetchTruncated, issues);
    await setLastSyncedAt(target.owner, target.repo, nextCursor);
    if (nextCursor !== startedAt) {
      console.warn(
        '[catchup] fetch was truncated for',
        repoLabel,
        `— cursor advanced only to ${nextCursor.toISOString()}; next tick drains the tail.`,
      );
    }
  } else {
    console.warn(
      '[catchup] not bumping lastSyncedAt for',
      repoLabel,
      `(stateSyncErrored=${stateSyncErrored}, ingestErrored=${ingestErrored}); next tick will retry the window.`,
    );
  }

  return {
    repo: repoLabel,
    fetched: issues.length,
    applied,
    skipped,
    noTransition,
    mirrorRepaired,
    directResolved,
    heldClosesResolved,
    prematureClosesHealed,
    stateSyncErrored,
    ingested: ingestCreated,
    ingestErrored,
    workStarted,
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
/**
 * A forge row this server can't build a client for: its Gitea sign-in is
 * gone or can't be refreshed, URLs are missing, or Gitea OAuth isn't
 * configured. It fails the same way every tick until someone reconnects,
 * so catch-up reports it as `refused`, not as a sick loop.
 */
export class UnservableBindingError extends Error {}

/**
 * The forge rows some map syncs with: same workspace, same owner/repo (the
 * match `patIntegrationForMap` makes). Exported for unit-test access.
 */
export function rowsBoundToMaps<R extends { workspaceId: string; config: unknown }>(
  rows: R[],
  boundMaps: Array<{ workspaceId: string; owner: string | null; repo: string | null }>,
): R[] {
  const bound = new Set(boundMaps.map((m) => `${m.workspaceId}\0${m.owner}/${m.repo}`));
  return rows.filter((r) => {
    const cfg = r.config as { owner?: string; repo?: string } | null;
    return bound.has(`${r.workspaceId}\0${cfg?.owner}/${cfg?.repo}`);
  });
}

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
        isNull(maps.archivedAt), // archived = on hold, no sync
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
      resolveForge: () => forgeFromInstallation(installationId),
      bindingKey: appBindingKey(installationId),
    });
  }

  // PAT integrations (any forge kind) — only rows a map syncs with. A row
  // whose map was deleted or moved to another repo has nowhere to ingest
  // to (dan/xx2, 2026-10-23). Accepted trade-off: nodes still linked to
  // such a repo (link_issue, a rebound map's old links) get its state
  // changes from webhooks only, without catch-up as the backstop.
  const patIntegrations = await db
    .select()
    .from(integrations)
    .where(and(inArray(integrations.provider, FORGE_PROVIDERS), eq(integrations.enabled, true)));
  const patMaps = await db
    .select({ workspaceId: maps.workspaceId, owner: maps.githubRepoOwner, repo: maps.githubRepoName })
    .from(maps)
    .where(and(isNull(maps.githubInstallationId), isNotNull(maps.githubRepoOwner), isNotNull(maps.githubRepoName), isNull(maps.archivedAt)));
  for (const integ of rowsBoundToMaps(patIntegrations, patMaps)) {
    const cfg = integ.config as unknown as ForgeIntegrationConfig;
    if (!isServableIntegrationConfig(cfg)) continue;
    const key = `${cfg.owner}/${cfg.repo}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      source: 'pat',
      owner: cfg.owner,
      repo: cfg.repo,
      // Resolved at fetch time: an OAuth-bound row (#369) may need a token
      // refresh, and a row this build cannot serve throws here — the same
      // path a failed App-token mint takes.
      resolveForge: async () => {
        const forge = await forgeFromIntegration(integ);
        if (!forge) throw new UnservableBindingError(`integration ${integ.id} (${integ.provider}) cannot be served`);
        return forge;
      },
      bindingKey: rowBindingKey(integ),
    });
  }

  return [...seen.values()];
}

/**
 * Reconcile every known GitHub repo. Errors on one repo don't abort the
 * sweep — each repo is independent.
 *
 * After the per-repo loop completes we push a Kuma heartbeat (if
 * `KUMA_GITHUB_CATCHUP_PUSH_URL` is set) summarising this tick's stats.
 * The push is fire-and-forget — Kuma being unreachable must never stall
 * or fail the catchup itself.
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
        fetched: 0, applied: 0, skipped: 0, noTransition: 0, mirrorRepaired: 0, directResolved: 0, heldClosesResolved: 0, prematureClosesHealed: 0, stateSyncErrored: 0, ingested: 0, ingestErrored: 0,
        durationMs: 0,
        since: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Heartbeat is a defence-in-depth wrapper: pushKumaHeartbeat already
  // swallows its own errors, but we re-wrap here so any future helper
  // misbehaviour (a synchronous throw at the top of the function, an
  // unhandled rejection promoting to a hard error) can't take down the
  // catchup return value. The catchup MUST always return its results.
  try {
    await pushCatchupHeartbeat(results);
  } catch (err) {
    console.warn(
      '[kuma-push] catchup heartbeat unexpectedly threw:',
      err instanceof Error ? err.message : err,
    );
  }

  // Watchdog ping — only fired on a healthy tick (see `isHealthyTick`).
  // Wrapped in try/catch defensively: sdNotifyWatchdog already
  // suppresses its own errors, but a synchronous throw at the top of
  // the function or an unhandled rejection escaping must NOT take down
  // the catchup return value.
  //
  // Note (2026-06-08): the dedicated 60s heartbeat in index.ts now
  // owns the actual sd_notify pings. We keep this per-tick ping in
  // place as belt-and-suspenders — pinging more often than
  // WatchdogSec is harmless, and an extra ping on every healthy tick
  // means the watchdog stays alive even if the 60s heartbeat
  // setInterval is itself skipped due to event-loop blocking. We
  // also record `lastHealthyTickAt` so the heartbeat knows whether
  // to ping.
  if (isHealthyTick(results)) {
    lastHealthyTickAt = Date.now();
    try {
      await sdNotifyWatchdog();
    } catch (err) {
      console.warn(
        '[sd-notify] watchdog ping unexpectedly threw:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return results;
}

// Timestamp (epoch ms) of the most recent healthy catchup tick.
// Initialised to process start so the heartbeat doesn't reject the
// service as unhealthy before the very first tick has a chance to run.
// Updated in-place above whenever a healthy tick completes; consumed
// by the dedicated heartbeat in index.ts to decide whether to ping
// the systemd watchdog independently of the catchup cadence.
//
// Decoupling matters because pre-2026-06-08 the watchdog ping was
// tightly bound to the catchup setInterval — any event-loop hiccup
// that delayed a tick past 5min triggered SIGABRT even when the
// service was otherwise healthy. The new heartbeat fires every 60s
// and only pings if the last healthy tick is within
// `2 × CATCHUP_INTERVAL_MS` (= 10 min by default), so scheduler
// drift up to ~10 min is tolerated while a truly dead catchup loop
// still triggers a kill within ~15 min.
let lastHealthyTickAt = Date.now();

/** Read-only accessor for the heartbeat in index.ts. */
export function getLastHealthyTickAt(): number {
  return lastHealthyTickAt;
}

/**
 * A tick is "healthy" — and therefore eligible to ping the systemd
 * watchdog — when EVERY per-repo result reported no error, zero
 * ingest failures, and zero state-sync failures. The watchdog exists
 * to catch the failure mode where the catchup loop has frozen
 * entirely; pinging on a partial-failure path would defeat its
 * purpose by hiding exactly those incidents from systemd.
 *
 * Exception: per-repo GitHub auth failures (`authFailure`) do NOT
 * make a tick unhealthy. A revoked PAT or suspended App install is a
 * credential problem on one repo, not a frozen loop — it already has
 * its own escalation channel (the `auth_failed` alarm monitor).
 * Before this carve-out, a single tenant's dead token suppressed the
 * watchdog ping forever and systemd restart-looped the whole service
 * every ~24 min (incident 2026-07-10, `meheav1-stack/proptechdev`).
 * The same goes for any repo the forge refuses (`refused`: 401/403/404),
 * e.g. a repo deleted under its binding (incident 2026-10-23, `dan/xx2`).
 *
 * An empty `results` array (no repos discovered, no work done) counts
 * as healthy — the sweep completed without crashing, which is what
 * the watchdog actually measures.
 *
 * Exported for unit-test access.
 */
export function isHealthyTick(results: ReconcileResult[]): boolean {
  return results.every(
    (r) =>
      (!r.error || r.authFailure || r.refused) &&
      r.ingestErrored === 0 &&
      r.stateSyncErrored === 0,
  );
}

/**
 * Push the catchup tick's roll-up stats to Kuma. Reads the URL from
 * `KUMA_GITHUB_CATCHUP_PUSH_URL`; silently skips if unset (so dev/test
 * environments don't need the env var). Wraps in try/catch — a failed
 * push must NEVER affect the main catchup flow.
 *
 * Status is `down` if any repo errored, had an ingest failure, or had a
 * state-sync failure. Otherwise `up`. Message includes per-tick totals
 * so the Kuma monitor's history shows whether catchup is actually
 * making progress, not just whether it's running.
 *
 * Per-repo auth failures do NOT flip the status to `down` — same
 * rationale as `isHealthyTick`: the `auth_failed` alarm monitor owns
 * that signal, and this heartbeat measures whether the loop is alive.
 * They still surface in the message as `authFailed=N` so the monitor
 * history shows the degradation.
 *
 * Exported for unit-test access — production callers go through
 * `runAllCatchups` which invokes this at end of sweep.
 */
export async function pushCatchupHeartbeat(results: ReconcileResult[]): Promise<void> {
  const url = process.env.KUMA_FORGE_CATCHUP_PUSH_URL ?? process.env.KUMA_GITHUB_CATCHUP_PUSH_URL;
  if (!url) return;

  const sum = (pick: (r: ReconcileResult) => number): number =>
    results.reduce((acc, r) => acc + pick(r), 0);

  const hasError = results.some(
    (r) => (r.error && !r.authFailure && !r.refused) || r.ingestErrored > 0 || r.stateSyncErrored > 0,
  );
  const authFailed = results.filter((r) => r.authFailure || r.refused).length;
  const status = hasError ? 'down' : 'up';
  const msg = `repos=${results.length} fetched=${sum((r) => r.fetched)} ingested=${sum((r) => r.ingested)} applied=${sum((r) => r.applied)} errored=${sum((r) => r.ingestErrored + r.stateSyncErrored)} authFailed=${authFailed}`;

  await pushKumaHeartbeat(url, status, msg, '[kuma-push] catchup heartbeat');
}
