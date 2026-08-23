/**
 * GH PR state → MindBlown node mirror.
 *
 * MindBlown's existing GH integration tracks linked ISSUES (one node per
 * issue). PR lifecycle state — open/closed, reviews, CI checks, mergeable —
 * was previously not synced; consumers had to poll the GH API.
 *
 * This module bridges that gap. For each PR event arriving via the GH
 * webhook handler in `routes/integrations.ts`, we find the linked
 * issue's node (via `Closes #NNNN` parsing on the PR body, same
 * convention the existing `pull_request.closed` (#152) handler uses)
 * and write the PR state to `node.linkedPr`.
 *
 * What we DON'T do here:
 *   - Triage the PR itself (PRs aren't first-class MindBlown nodes;
 *     they're attached to the issue they close).
 *   - Sync PR comments (separate event, not currently needed by Kira).
 *   - Modify the node's primary fields (title, body, status). Those are
 *     issue-driven and handled by the issue ingest path.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import type { LinkedPrState, ExternalLink } from '@mindblown/core';
import { extractClosingIssueRefs } from '@mindblown/integrations';

// ── PR payload shapes (subset of GH webhook) ──────────────────────

export interface GhPrPayload {
  number: number;
  title?: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  user: { login: string } | null;
  mergeable: boolean | null;
}

export interface GhReviewPayload {
  user: { login: string };
  state: string; // 'approved' | 'changes_requested' | 'commented' | 'dismissed'
  body: string | null;
  submitted_at: string | null;
}

export interface GhCheckSuitePayload {
  conclusion: string | null; // 'success' | 'failure' | 'cancelled' | 'neutral' | ...
  status: string; // 'queued' | 'in_progress' | 'completed'
  head_sha: string;
  head_branch: string;
  pull_requests: Array<{ number: number; head: { ref: string; sha: string } }>;
}

// ── Closes-issue parser ───────────────────────────────────────────

/**
 * Extract issue number(s) referenced by `Closes #NNNN` / `Fixes #NNNN` /
 * `Resolves #NNNN` keywords in the PR body. Same regex GitHub itself
 * uses for auto-close. Case-insensitive, hash optional.
 */
export function parseClosesIssues(text: string | null | undefined): number[] {
  // Thin delegate: extractClosingIssueRefs (@mindblown/integrations) is
  // THE parser for "which issues does this close" — the #152 done-
  // transition and the work-start sync use it too. A second regex here
  // drifted (`fixe[sd]?` missed bare "fix"), so "Fix #123"-titled PRs
  // transitioned their node without ever arming the mirror.
  if (!text) return [];
  return extractClosingIssueRefs(text);
}

/**
 * Closes-refs for a PR payload: title AND body, via the SAME parser the
 * #152 done-transition and the work-start sync use
 * (`extractClosingIssueRefs`). One parser decides which issues a PR
 * closes — a second regex here drifted ("Fix #123" matched there but
 * not here), so the mirror never armed for the most common imperative
 * title form while the node still transitioned to done.
 *
 * Note the mirror deliberately arms for title-only refs even though
 * GitHub's own auto-close only honors refs in the BODY: the done-
 * transition handler treats title refs as closing refs, so the mirror
 * must agree — and the merge handler closes title-only-ref issues
 * explicitly (routes/integrations.ts) since GitHub won't.
 */
function closesRefsFromPr(pr: Pick<GhPrPayload, 'title' | 'body'>): number[] {
  return extractClosingIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`);
}

// ── Node lookup ────────────────────────────────────────────────────

interface NodeRef {
  id: string;
  externalId: string;
  linkedPr: LinkedPrState | null;
}

/**
 * Find every node referencing one of the given externalIds. Returns
 * the linked_pr current state so callers can do a merge/diff.
 */
async function findNodesByExternalIds(
  externalIds: string[],
): Promise<NodeRef[]> {
  if (externalIds.length === 0) return [];
  const wanted = new Set(externalIds);
  const rows = await db
    .select({
      id: nodes.id,
      externalLinks: nodes.externalLinks,
      linkedPr: nodes.linkedPr,
    })
    .from(nodes)
    .where(nodeDb.notDeleted);
  const out: NodeRef[] = [];
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    for (const l of links) {
      if (l.provider === 'github' && l.externalId && wanted.has(l.externalId)) {
        out.push({
          id: row.id,
          externalId: l.externalId,
          linkedPr: (row.linkedPr as LinkedPrState | null) ?? null,
        });
        break;
      }
    }
  }
  return out;
}

// ── Event handlers ─────────────────────────────────────────────────

/**
 * Handle `pull_request.opened` / `.reopened` / `.synchronize` /
 * `.edited` / `.ready_for_review` / `.converted_to_draft`. Snapshots
 * the PR state onto every linked-issue node.
 *
 * Returns the number of nodes updated (0 when the PR's body doesn't
 * mention `Closes #NNNN`, or none of the referenced issues have nodes).
 */
export async function handlePrSnapshot(
  repo: string,
  pr: GhPrPayload,
  changedFiles: string[],
): Promise<number> {
  // Snapshot only IN-FLIGHT PRs. An `edited`/`synchronize` event on an
  // already-closed or merged PR must not rewrite the mirror: a post-
  // merge title edit used to resurrect a mirror handlePrClosed had
  // deliberately cleared (or flip a kept-armed release-merge mirror to
  // plain 'merged', disarming the close gate). Closed/merged
  // transitions are owned by handlePrClosed alone. This also makes the
  // supersede pattern work: a NEW open PR takes over a dead PR's
  // mirror on its next event, while dead PRs can't steal it back.
  if (pr.state !== 'open') return 0;
  const issueNumbers = closesRefsFromPr(pr);
  if (issueNumbers.length === 0) return 0;
  const externalIds = issueNumbers.map((n) => `${repo}#${n}`);
  const refs = await findNodesByExternalIds(externalIds);
  if (refs.length === 0) return 0;

  let updated = 0;
  for (const ref of refs) {
    // Carry forward existing reviews + checks unless this event
    // explicitly resets them. The PR snapshot only updates the
    // "structural" fields (state, mergeable, draft, head, base, files).
    // Review + check updates come from their dedicated handlers.
    //
    // Carry-forward ONLY from the same PR: when this snapshot takes
    // over the mirror from a superseded PR (abandoned A → replacement
    // B), inheriting A's reviews would show B as blocked by A's stale
    // CHANGES_REQUESTED (or falsely approved).
    const samePr = ref.linkedPr?.number === pr.number;
    const prevReviews = samePr ? (ref.linkedPr?.reviews ?? []) : [];
    const prevChecks = samePr
      ? (ref.linkedPr?.checks ?? { state: null, failures: [] })
      : { state: null, failures: [] };
    const next: LinkedPrState = {
      number: pr.number,
      repo,
      url: pr.html_url,
      head: pr.head.ref,
      base: pr.base.ref,
      author: pr.user?.login ?? null,
      draft: pr.draft,
      state: 'open',
      mergeable: pr.mergeable,
      changedFiles,
      reviews: prevReviews,
      checks: prevChecks,
      lastSyncedAt: new Date().toISOString(),
    };
    await nodeDb.updateNode(ref.id, { linkedPr: next });
    updated += 1;
  }
  return updated;
}

/**
 * Handle `pull_request_review.submitted`. Appends the review to
 * `linkedPr.reviews` on every linked-issue node.
 *
 * Only EXISTING linkedPr mirrors are updated. Seeding a stub here
 * (with hardcoded state:'open') resurrected the mirror after a merge
 * had cleared it — a post-merge approve or late check event then
 * re-armed the issue-close gate permanently, with no further
 * `pull_request.closed` ever coming to release it. A review racing
 * ahead of the `opened` webhook is caught by the snapshot handler
 * seconds later; losing that one review entry is the cheaper error.
 */
export async function handleReviewSubmitted(
  repo: string,
  pr: Pick<GhPrPayload, 'number' | 'title' | 'body'>,
  review: GhReviewPayload,
): Promise<number> {
  const issueNumbers = closesRefsFromPr(pr);
  if (issueNumbers.length === 0) return 0;
  const externalIds = issueNumbers.map((n) => `${repo}#${n}`);
  const refs = await findNodesByExternalIds(externalIds);
  if (refs.length === 0) return 0;

  let updated = 0;
  for (const ref of refs) {
    const cur = ref.linkedPr;
    if (!cur || cur.number !== pr.number) continue;
    const next: LinkedPrState = {
      ...cur,
      reviews: [
        ...cur.reviews,
        {
          author: review.user.login,
          state: review.state.toUpperCase(),
          body: review.body ?? '',
          submittedAt: review.submitted_at ?? new Date().toISOString(),
        },
      ],
      lastSyncedAt: new Date().toISOString(),
    };
    await nodeDb.updateNode(ref.id, { linkedPr: next });
    updated += 1;
  }
  return updated;
}

/**
 * Handle `check_suite.completed`. Updates `linkedPr.checks` on every
 * linked-issue node for each PR the suite is attached to.
 *
 * GH attaches a check suite to one or more PRs via `pull_requests[]`;
 * we look up each PR's body for `Closes #NNNN` to find the node.
 * Because GitHub omits PR bodies from the check_suite payload, callers
 * pass in a `getPrBody(number) => Promise<string|null>` lookup so we
 * can resolve the issue link.
 */
export async function handleCheckSuiteCompleted(
  repo: string,
  payload: GhCheckSuitePayload,
  // Returns the PR's title+body text (any closing-ref-bearing text) —
  // title-only-ref PRs get an armed mirror too, so their CI state must
  // resolve the same way.
  getPrText: (prNumber: number) => Promise<string | null>,
): Promise<number> {
  if (payload.status !== 'completed') return 0;
  let totalUpdated = 0;
  for (const pr of payload.pull_requests) {
    const text = await getPrText(pr.number).catch(() => null);
    const issueNumbers = parseClosesIssues(text);
    if (issueNumbers.length === 0) continue;
    const externalIds = issueNumbers.map((n) => `${repo}#${n}`);
    const refs = await findNodesByExternalIds(externalIds);
    for (const ref of refs) {
      const cur: LinkedPrState | null = ref.linkedPr;
      // Update EXISTING mirrors only — no stub seeding. A check suite
      // completing after the merge cleared the mirror used to resurrect
      // it with hardcoded state:'open' and permanently re-arm the
      // issue-close gate (see handleReviewSubmitted for the rationale).
      if (!cur || cur.number !== pr.number) continue;
      const next: LinkedPrState = {
        ...cur,
        checks: {
          state: payload.conclusion,
          failures:
            payload.conclusion === 'failure'
              ? [...new Set([...cur.checks.failures, 'check_suite'])]
              : cur.checks.failures.filter((f) => f !== 'check_suite'),
        },
        lastSyncedAt: new Date().toISOString(),
      };
      await nodeDb.updateNode(ref.id, { linkedPr: next });
      totalUpdated += 1;
    }
  }
  return totalUpdated;
}

/**
 * Handle `pull_request.closed`. On a merge to the repo's DEFAULT branch
 * the mirror is cleared — GitHub itself closes body-referenced issues
 * at that moment, and the merge handler in routes/integrations.ts
 * transitions the linked node to done (and closes title-only-ref
 * issues explicitly). Otherwise the mirror is kept armed:
 *
 *   - abandoned (closed unmerged) → state 'closed'. The work never
 *     landed; the issue-close gate stays armed, but the catchup may
 *     reset a stale done-node (see prBlocksNodeReopen in core).
 *   - merged to a NON-default branch (release/v1 hotfix) → state
 *     'merged' + landedOnDefault:false. Merged, but not on main: the
 *     close gate stays armed AND the node's done-state is protected —
 *     collapsing this case into 'closed' let the catchup wipe shipped
 *     release work.
 *
 * Only the mirror's OWN PR may transition it (`cur.number` guard, same
 * as the review/check handlers): with the supersede pattern — PR A
 * abandoned, replacement PR B in flight, both saying `Closes #N` — A's
 * late close event must not clobber or clear B's mirror.
 *
 * `defaultBranch` comes from the webhook's `repository.default_branch`.
 * Unknown (null) fails CLOSED — the mirror stays armed as a non-
 * default merge. Clearing on unknown would disarm the close gate on
 * exactly the payloads we know least about; the sibling #152 handler
 * makes the same fail-safe choice for the done-transition.
 */
export async function handlePrClosed(
  repo: string,
  pr: GhPrPayload,
  defaultBranch: string | null = null,
): Promise<number> {
  const issueNumbers = closesRefsFromPr(pr);
  if (issueNumbers.length === 0) return 0;
  const externalIds = issueNumbers.map((n) => `${repo}#${n}`);
  const refs = await findNodesByExternalIds(externalIds);
  if (refs.length === 0) return 0;

  const baseRef = pr.base?.ref ?? null;
  const mergedToDefault =
    pr.merged && baseRef != null && defaultBranch != null && baseRef === defaultBranch;

  let updated = 0;
  for (const ref of refs) {
    const cur = ref.linkedPr;
    if (!cur || cur.number !== pr.number) continue;
    if (mergedToDefault) {
      await nodeDb.updateNode(ref.id, { linkedPr: null });
    } else {
      const next: LinkedPrState = {
        ...cur,
        state: pr.merged ? 'merged' : 'closed',
        ...(pr.merged ? { landedOnDefault: false } : {}),
        lastSyncedAt: new Date().toISOString(),
      };
      await nodeDb.updateNode(ref.id, { linkedPr: next });
    }
    updated += 1;
  }
  return updated;
}
