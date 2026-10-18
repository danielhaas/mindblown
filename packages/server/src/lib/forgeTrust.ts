/**
 * Stopgap trust check for forge ingest (#489, until the approval gate of
 * the trust epic #495 lands — remove this then).
 *
 * Ingest turns every new issue on a connected repo into a todo node, and
 * on a public repo anyone can open an issue. A node from an author we do
 * not trust lands with the `needs-human` skip tag, so the pull queue holds
 * it until a person removes the tag.
 *
 * Trusted authors: the repo owner (the account the repo lives under) plus
 * the comma-separated logins in `FORGE_TRUSTED_LOGINS` (bots, fleet
 * accounts, collaborators). Matching ignores case. An issue without an
 * author login (old payloads, fixtures) counts as trusted — GitHub and
 * Gitea always send `user` on real issues.
 */

export const OUTSIDE_AUTHOR_HOLD_TAG = 'needs-human';

interface IssueAuthor {
  user?: { login?: string | null } | null;
}

function trustedLogins(owner: string): Set<string> {
  const extra = (process.env.FORGE_TRUSTED_LOGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([owner.toLowerCase(), ...extra]);
}

/** True when the issue names an author who is neither the repo owner nor allowlisted. */
export function isOutsideAuthor(issue: IssueAuthor, owner: string): boolean {
  const login = issue.user?.login?.trim().toLowerCase();
  if (!login) return false;
  return !trustedLogins(owner).has(login);
}

function hasHoldTag(tags: string[]): boolean {
  return tags.some((t) => t.toLowerCase() === OUTSIDE_AUTHOR_HOLD_TAG);
}

/** Tags for a freshly ingested node: the label tags, plus the hold for an outside author. */
export function withIngestHold(tags: string[], issue: IssueAuthor, owner: string): string[] {
  if (!isOutsideAuthor(issue, owner) || hasHoldTag(tags)) return tags;
  return [...tags, OUTSIDE_AUTHOR_HOLD_TAG].sort();
}

/**
 * Label sync replaces a node's tags with the issue's labels. Keep the hold
 * through that replace while the author is an outsider: the tag was never
 * a label, so any later label change (even our own triage label
 * write-back) would otherwise strip it. A person approves by removing the
 * tag in MindBlown — after that the node no longer carries it and nothing
 * here puts it back.
 */
export function keepIngestHold(
  currentTags: string[],
  nextTags: string[],
  issue: IssueAuthor,
  owner: string,
): string[] {
  if (!hasHoldTag(currentTags) || hasHoldTag(nextTags)) return nextTags;
  if (!isOutsideAuthor(issue, owner)) return nextTags;
  return [...nextTags, OUTSIDE_AUTHOR_HOLD_TAG];
}

/** `owner` of an `owner/repo#N` externalId. */
export function ownerOfExternalId(externalId: string): string {
  return externalId.split('/')[0] ?? '';
}
