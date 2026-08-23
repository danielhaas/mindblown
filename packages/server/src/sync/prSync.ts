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
export function parseClosesIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const matches = body.matchAll(
    /\b(?:closes?|closed|fixe[sd]?|resolves?|resolved)\s+#(\d+)\b/gi,
  );
  const out = new Set<number>();
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out];
}

/**
 * Closes-refs for a PR payload: title AND body. GitHub itself honors
 * closing keywords in both; parsing only the body left `Closes #N`-in-
 * title PRs without a linkedPr mirror, so the issue-close gate never
 * armed for them (same title+body convention as `extractClosingIssueRefs`
 * in @mindblown/integrations, used by the work-start sync).
 */
function closesRefsFromPr(pr: Pick<GhPrPayload, 'title' | 'body'>): number[] {
  return parseClosesIssues(`${pr.title ?? ''}\n${pr.body ?? ''}`);
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
    const prevReviews = ref.linkedPr?.reviews ?? [];
    const prevChecks = ref.linkedPr?.checks ?? { state: null, failures: [] };
    const next: LinkedPrState = {
      number: pr.number,
      repo,
      url: pr.html_url,
      head: pr.head.ref,
      base: pr.base.ref,
      author: pr.user?.login ?? null,
      draft: pr.draft,
      state: pr.merged ? 'merged' : (pr.state as 'open' | 'closed'),
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
  getPrBody: (prNumber: number) => Promise<string | null>,
): Promise<number> {
  if (payload.status !== 'completed') return 0;
  let totalUpdated = 0;
  for (const pr of payload.pull_requests) {
    const body = await getPrBody(pr.number).catch(() => null);
    const issueNumbers = parseClosesIssues(body);
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
 * the mirror is cleared — GitHub itself closes the referenced issue at
 * that moment, and the existing #152 handler transitions the linked
 * node to done. Everything else — abandoned PRs AND merges to non-
 * default branches (release/v1 hotfixes) — keeps the mirror with
 * state='closed': the work has NOT landed on main, so the issue-close
 * gate must stay armed (a release-branch merge used to clear the
 * mirror, disarm the gate, and let the next catchup tick wipe the
 * node's progress with an empty snapshot). Review history stays useful
 * either way.
 *
 * `defaultBranch` comes from the webhook's `repository.default_branch`;
 * when it's unknown (null) we conservatively treat a merge as default-
 * branch (the pre-existing behavior).
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

  const mergedToDefault =
    pr.merged && (defaultBranch == null || pr.base.ref === defaultBranch);

  let updated = 0;
  for (const ref of refs) {
    if (mergedToDefault) {
      await nodeDb.updateNode(ref.id, { linkedPr: null });
    } else {
      // Abandoned, or merged somewhere that isn't the default branch:
      // keep the history but mark closed so consumers don't try to
      // merge it — and so the close gate stays armed.
      const cur = ref.linkedPr;
      if (!cur) continue;
      const next: LinkedPrState = {
        ...cur,
        state: 'closed',
        lastSyncedAt: new Date().toISOString(),
      };
      await nodeDb.updateNode(ref.id, { linkedPr: next });
    }
    updated += 1;
  }
  return updated;
}
