/**
 * Shared gate predicates for the linked-PR mirror (`node.linkedPr`).
 *
 * Both sides of the GitHub sync consult the same mirror to decide
 * whether a node/issue state transition is safe, and they MUST agree —
 * a one-sided "correction" of either predicate reintroduces one of the
 * two incident classes below. The rationale lives here, once.
 *
 * Incident background (2026-08): a done-node used to close its GitHub
 * issue immediately, even while the closing PR was still open. When
 * such a PR then died unmerged, the issue stayed closed as COMPLETED
 * and silently reported unshipped work as finished — 15 issues since
 * 2026-07-15, among them compliance work (crm#6096 controlling-person
 * look-through, #6027 retention audit records, #5910 duplicate-IBAN
 * detection), none of which had landed on main.
 *
 * The mirror's `state` semantics as maintained by the webhook handlers
 * (`prSync.ts`):
 *   - 'open'   — the PR is in flight right now.
 *   - 'closed' — the PR is gone WITHOUT landing on the default branch
 *                (abandoned, or merged to a release branch). Kept as
 *                history.
 *   - 'merged' — landed on the default branch. Transient in practice:
 *                `handlePrClosed` clears the mirror entirely on a
 *                default-branch merge, because GitHub itself closes the
 *                referenced issue at that moment.
 */

import type { LinkedPrState } from './types.js';

/**
 * Outbound gate: may MindBlown close the linked GitHub issue as
 * COMPLETED because the node looks done?
 *
 * Blocks while the mirror shows any not-landed PR — in flight OR gone
 * without landing. An abandoned PR means the work is NOT done, so a
 * done-node must not report COMPLETED; a human can always close the
 * issue by hand (and MindBlown will not reopen it while the node stays
 * done). Narrowing this to `state === 'open'` would make an abandoned
 * PR close its issue as COMPLETED — exactly the incident class above.
 */
export function prBlocksIssueClose(
  linkedPr: LinkedPrState | null | undefined,
): boolean {
  return linkedPr != null && linkedPr.state !== 'merged';
}

/**
 * Inbound gate: must a "GitHub says open, node says done" observation
 * be left alone instead of resetting the node?
 *
 * Blocks ONLY while the PR is in flight AND no close-snapshot exists.
 * While a PR runs, "issue open + node done" is the NORMAL state (the
 * agent marks the node done when it opens the PR; the outbound gate
 * keeps the issue open until merge) — resetting then would wipe
 * progress irrecoverably, because the snapshot was never taken.
 *
 * With a snapshot the reset is a lossless restore of real pre-close
 * state, so it proceeds even during an in-flight PR. And once the PR
 * is gone without landing (`state === 'closed'`), the work is NOT done
 * — pinning the node on done/100 forever would report never-landed
 * work as finished, the mirror image of the incident above.
 */
export function prBlocksNodeReopen(
  linkedPr: LinkedPrState | null | undefined,
  hasSnapshot: boolean,
): boolean {
  return linkedPr?.state === 'open' && !hasSnapshot;
}
