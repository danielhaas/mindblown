/**
 * Shared gate predicates for the linked-PR mirror (`node.linkedPr`).
 *
 * Both sides of the GitHub sync consult the same mirror to decide
 * whether a node/issue state transition is safe, and they MUST agree —
 * a one-sided "correction" of either predicate reintroduces one of the
 * incident classes below. The rationale lives here, once.
 *
 * Incident background (2026-08): a done-node used to close its GitHub
 * issue immediately, even while the closing PR was still open. When
 * such a PR then died unmerged, the issue stayed closed as COMPLETED
 * and silently reported unshipped work as finished — 15 issues since
 * 2026-07-15, among them compliance work (crm#6096 controlling-person
 * look-through, #6027 retention audit records, #5910 duplicate-IBAN
 * detection), none of which had landed on main.
 *
 * The mirror's `state` semantics as maintained by `prSync.ts`:
 *   - 'open'   — the PR is in flight right now.
 *   - 'closed' — the PR died unmerged (abandoned). Kept as history.
 *   - 'merged' + landedOnDefault === false — merged to a non-default
 *                branch (release/v1 hotfix): merged, but NOT on main.
 *   - 'merged' otherwise — landed on the default branch. Transient in
 *                practice: `handlePrClosed` clears the mirror entirely
 *                on a default-branch merge, because GitHub itself
 *                closes the referenced issue at that moment.
 */

import type { ExternalLink, LinkedPrState } from './types.js';

/** Merged, but NOT to the default branch — the work is not on main. */
function mergedOffDefault(pr: LinkedPrState): boolean {
  return pr.state === 'merged' && pr.landedOnDefault === false;
}

/**
 * A dead PR (abandoned) whose verdict a LATER done-claim overrides.
 *
 * An abandoned PR means the work was NOT done — at the time it died.
 * If the node was marked done AFTER the PR died (`completedAt` newer
 * than the mirror's close stamp), that is a fresh, deliberate claim —
 * work shipped some other way (direct commit, a PR without a Closes
 * ref) — and the stale mirror must not veto it. Without this
 * discriminator the gates livelock: the issue can never close AND the
 * catchup resets the node on every tick, forever, with no reachable
 * escape (nothing on the MCP surface clears a mirror).
 */
function abandonedButSuperseded(
  pr: LinkedPrState,
  completedAt: string | null | undefined,
): boolean {
  if (pr.state !== 'closed') return false;
  if (!completedAt || !pr.lastSyncedAt) return false;
  return new Date(completedAt).getTime() > new Date(pr.lastSyncedAt).getTime();
}

/**
 * Outbound gate: may MindBlown close the linked GitHub issue as
 * COMPLETED because the node looks done?
 *
 * Blocks while the mirror shows work that has not landed on the
 * default branch: an in-flight PR, an abandoned PR (unless a later
 * done-claim supersedes it — see above), or a merge to a release
 * branch. Narrowing this to `state === 'open'` would make an abandoned
 * PR close its issue as COMPLETED — exactly the incident class above.
 */
export function prBlocksIssueClose(
  linkedPr: LinkedPrState | null | undefined,
  completedAt?: string | null,
): boolean {
  if (linkedPr == null) return false;
  if (linkedPr.state === 'open') return true;
  if (mergedOffDefault(linkedPr)) return true;
  if (linkedPr.state === 'closed') {
    return !abandonedButSuperseded(linkedPr, completedAt);
  }
  return false;
}

/**
 * Inbound gate: must a "GitHub says open, node says done" observation
 * be left alone instead of resetting the node?
 *
 * Blocks when:
 *   - the PR is in flight AND no close-snapshot exists — "issue open +
 *     node done" is the NORMAL state while a PR runs (the agent marks
 *     the node done when it opens the PR; the outbound gate keeps the
 *     issue open until merge), and resetting then would wipe progress
 *     irrecoverably. With a snapshot the reset is a lossless restore
 *     of real pre-close state, so it proceeds.
 *   - the PR merged to a non-default branch — the work IS merged
 *     (release lane); wiping the node's done-state because the issue
 *     is still open (awaiting the forward-port) reports shipped
 *     release work as not done.
 *   - the PR died unmerged but a LATER done-claim supersedes it —
 *     honoring the fresh claim; see `abandonedButSuperseded`.
 *
 * An abandoned PR with no later claim does NOT block: the work never
 * landed, so pinning the node on done/100 forever would report
 * never-landed work as finished — the mirror image of the incident.
 */
export function prBlocksNodeReopen(
  linkedPr: LinkedPrState | null | undefined,
  hasSnapshot: boolean,
  completedAt?: string | null,
): boolean {
  if (linkedPr == null) return false;
  if (linkedPr.state === 'open') return !hasSnapshot;
  if (mergedOffDefault(linkedPr)) return true;
  if (linkedPr.state === 'closed') {
    return abandonedButSuperseded(linkedPr, completedAt);
  }
  return false;
}

/**
 * Does this external link carry a close-snapshot (node state captured
 * when the external system drove the node to done)? Both the webhook
 * reopen handler and the catchup reconciler restore from it and gate
 * on its presence — one definition, so they cannot drift.
 */
export function hasCloseSnapshot(
  link: Pick<ExternalLink, 'previousPercentComplete' | 'previousStatus'>,
): boolean {
  return (
    (link.previousPercentComplete !== undefined && link.previousPercentComplete !== null) ||
    (link.previousStatus !== undefined && link.previousStatus !== null)
  );
}

/**
 * What the outbound sync is allowed to do with a linked issue when the
 * node reads as done.
 *
 *   - `close`  — there is HARD evidence the work landed on the default
 *                branch: a merge commit recorded on the link. Close as
 *                COMPLETED.
 *   - `hold`   — a linked PR exists and has NOT landed. Leave the issue
 *                state alone entirely.
 *   - `probe`  — no mirror, no merge commit. MindBlown has no local
 *                evidence either way and must ASK GitHub whether a PR
 *                claims to close this issue before it may close it.
 */
export type IssueCloseAction =
  | { kind: 'close'; stateReason: 'completed'; because: 'merge_commit' | 'mirror_merged' }
  | { kind: 'hold'; because: 'pr_not_landed' }
  | { kind: 'probe' };

/**
 * Outbound decision: what may the node→issue sync do with the issue's
 * state, given everything MindBlown knows locally?
 *
 * `prBlocksIssueClose` answers a narrower question — "does the mirror
 * veto a close?" — and its default when the mirror is absent is *close
 * as COMPLETED*. That default is what produced the incident this
 * function exists to end: a node marked done seconds after its PR was
 * opened, with the `pull_request.opened` webhook not yet applied (or
 * never subscribed), has no mirror at all, so the veto never fires and
 * the issue closes as `COMPLETED` with `commit_id=null` while the branch
 * is still open (crm#7357 closed 6 s after its PR was created, crm#6305
 * after 21 s, crm#6085 whose PR never merged at all).
 *
 * The fix is to stop treating "no local evidence" as "shipped". Absent a
 * recorded merge commit, the caller has to go and look. `probe` is that
 * instruction; only the caller can perform it, because it needs the
 * GitHub API.
 *
 * Deliberately NOT changed: an issue nobody ever opened a PR for still
 * closes as COMPLETED on a done-node (assessments, ops tasks — MindBlown
 * is the only mechanism there). The probe is what separates that case
 * from the incident case, and it is the caller's job to run it.
 */
export function issueCloseAction(
  linkedPr: LinkedPrState | null | undefined,
  link: Pick<ExternalLink, 'mergeCommitSha'> | null | undefined,
  completedAt?: string | null,
): IssueCloseAction {
  if (link?.mergeCommitSha) {
    return { kind: 'close', stateReason: 'completed', because: 'merge_commit' };
  }
  if (prBlocksIssueClose(linkedPr, completedAt)) {
    return { kind: 'hold', because: 'pr_not_landed' };
  }
  // A mirror that survived in state 'merged' with the default-branch
  // flag intact IS the merge evidence — `handlePrClosed` only leaves
  // that shape behind for a default-branch merge.
  if (linkedPr != null && linkedPr.state === 'merged') {
    return { kind: 'close', stateReason: 'completed', because: 'mirror_merged' };
  }
  return { kind: 'probe' };
}
