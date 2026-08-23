/**
 * The `#NNNN` title-marker convention, in one place.
 *
 * Ingest titles GitHub-linked nodes as `#N <title>`; auto-link (create-
 * node route), search, and the issues.edited title-rewrite guard all
 * parse the marker with THIS pattern. A second, stricter check (e.g.
 * startsWith('#N ')) silently disagrees on the bare-`#42` shape and
 * loses the marker on rewrites.
 *
 * Pattern: leading `#NNNN` followed by either a space or end-of-string.
 * Anchored — `#NNNN` mid-title is most likely a co-mention (e.g. an
 * inline PR reference), not the node's own identity. Spec: GitHub
 * issue #58.
 */
const AUTOLINK_TITLE_RE = /^#(\d+)(?:\s|$)/;

/**
 * Extract the leading issue number from a title, or null when the title
 * doesn't match the auto-link pattern.
 */
export function extractAutoLinkIssueNumber(title: string): number | null {
  if (!title) return null;
  const m = AUTOLINK_TITLE_RE.exec(title);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
