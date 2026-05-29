/**
 * Parent-epic auto-progress rollup (#57).
 *
 * Our decomposition agents split big epic tickets into many small child PRs
 * whose titles follow a few well-known conventions:
 *
 *   - `[#843-followup] AcctHolderType (CRS101/102/103)`     → parent #843
 *   - `[#1346] Frontend: German translations across …`      → parent #1346
 *   - `Follow-up to #1487: set mandate.updated_by on …`     → parent #1487
 *   - `[V1 UAT #1685] BUG: Dashboard overdue invoices …`    → parent #1685
 *
 * We don't want to clutter the mindmap with one node per child PR, but we DO
 * want the epic's `percentComplete` to reflect "4 of 6 children merged" so
 * Jenna doesn't have to eyeball it.
 *
 * This module:
 *   1. Parses titles for parent references via `parseParentReferences`.
 *   2. For a given parent number, finds all sibling issues whose titles also
 *      reference it (`siblingsForParent`).
 *   3. Computes the closed/total ratio and rounds to a percentage
 *      (`computeRollupPercent`).
 *   4. Writes the percent + a `Child PRs: X/Y merged (auto-tracked)` tail line
 *      to the linked parent node (`applyRollupToParent`).
 *
 * Triggered from two callsites:
 *   - The `issues.closed` / `issues.reopened` webhook handler in
 *     `routes/integrations.ts`, after the closing/reopening issue itself has
 *     been processed.
 *   - The catch-up reconciler in `sync/githubCatchup.ts`, once per repo
 *     per cycle, for every changed issue that turns out to be a child PR.
 *
 * Idempotency: each call recomputes from the full sibling set, so re-runs
 * converge to the same number. The description tail line is replaced in
 * place (not appended) on re-runs.
 *
 * Per-workspace overridable regex config is out of scope for v1. The
 * `DEFAULT_PARENT_PATTERNS` below is hardcoded; a future iteration can
 * read per-workspace overrides from `integrations.config` or `maps`.
 */

import { eq } from 'drizzle-orm';
import type { GitHubIssue } from '@mindblown/integrations';
import { fetchChangedIssues } from '@mindblown/integrations';
import type { ExternalLink, Node } from '@mindblown/core';

import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';

// ── Parent-reference patterns ─────────────────────────────────────
//
// Order matters only for documentation; we test each one independently
// and union the results.
//
// Patterns split into two families:
//
//   - Leading-anchor (`^`): a `#NNNN` that opens the title is a strong
//     parent claim (the bracketed and "Follow-up to" forms).
//   - Embedded: trailing-paren `(#NNNN follow-up)` (end-anchored) and
//     reviewer-attributed `(Ray|Rita|Dana review of #NNNN ...)`
//     (mid-string OK) are how Stella's decomposition titles surface most
//     often in practice — e.g.
//       `Sweep denormalised ChatMessage.mandate ... (#664 follow-up)`
//       `Fix stale role='advisor' literal ... (Ray review of #614 followup)`
//     We deliberately require either the literal "follow-up" trailer or
//     a reviewer keyword ("review of" / "follow-up to") so that incidental
//     mid-title `#NNNN` (e.g. `random text (Ray helped with #614)`) does
//     not match.
//   - All patterns capture the parent issue number in group 1.

const PATTERN_BRACKETED_FOLLOWUP = /^\[#(\d+)(?:-followup)?\]/;
const PATTERN_FOLLOWUP_TO = /^Follow-up to #(\d+)/i;
const PATTERN_V_UAT = /^\[V\d+\s+UAT\s+#(\d+)\]/i;
const PATTERN_TRAILING_FOLLOWUP = /\(#(\d+)\s+(?:[^)]*\s+)?follow-?up\)$/i;
const PATTERN_REVIEWER_ATTRIBUTED = /\((?:Ray|Rita|Dana)\s+(?:review of|follow-up to)\s+#(\d+)[^)]*\)/i;

/** All patterns we recognize, exported for documentation/test introspection. */
export const DEFAULT_PARENT_PATTERNS: ReadonlyArray<RegExp> = [
  PATTERN_BRACKETED_FOLLOWUP,
  PATTERN_FOLLOWUP_TO,
  PATTERN_V_UAT,
  PATTERN_TRAILING_FOLLOWUP,
  PATTERN_REVIEWER_ATTRIBUTED,
];

/**
 * Extract every parent-issue number referenced by a title.
 *
 * Returns a deduplicated array (order-stable, first-match wins). Empty when
 * the title doesn't match any pattern.
 *
 * A single title can produce multiple matches if it includes more than one
 * recognized prefix — though in practice we've only seen one — so we apply
 * each pattern and union, per the spec's "multiple parent refs in one title"
 * edge case.
 */
export function parseParentReferences(title: string): number[] {
  if (!title) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const pattern of DEFAULT_PARENT_PATTERNS) {
    const m = pattern.exec(title);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ── Counting helpers ─────────────────────────────────────────────

export interface RollupCounts {
  closed: number;
  total: number;
}

/**
 * Given the full set of repo issues and a target parent number, return all
 * siblings (open + closed) whose title references that parent.
 *
 * GitHub's `state_reason: 'not_planned'` still surfaces as `state: 'closed'`
 * — both flavors count as closed, per the spec's "Closed not_planned: count
 * as closed (same as merged from a planning perspective)" rule.
 *
 * The parent issue itself is excluded by number, so an epic that happens to
 * match its own pattern doesn't self-count.
 */
export function siblingsForParent(
  allIssues: ReadonlyArray<Pick<GitHubIssue, 'number' | 'title' | 'state'>>,
  parentNumber: number,
): RollupCounts {
  let closed = 0;
  let total = 0;
  for (const issue of allIssues) {
    if (issue.number === parentNumber) continue;
    const parents = parseParentReferences(issue.title);
    if (!parents.includes(parentNumber)) continue;
    total++;
    if (issue.state === 'closed') closed++;
  }
  return { closed, total };
}

/** `round(closed/total * 100)`. Returns 0 when total is 0 (caller should skip). */
export function computeRollupPercent({ closed, total }: RollupCounts): number {
  if (total <= 0) return 0;
  return Math.round((closed / total) * 100);
}

// ── Description tail-line maintenance ────────────────────────────

const TAIL_LINE_PREFIX = 'Child PRs:';
const TAIL_LINE_RE = /^Child PRs: \d+\/\d+ merged \(auto-tracked\)\s*$/m;

/**
 * Replace (or append) the canonical `Child PRs: X/Y merged (auto-tracked)`
 * tail line on a description string.
 *
 * Idempotent: feeding the output back through with the same counts produces
 * the same string. The matcher is anchored on its own line so other prose
 * with the literal phrase "Child PRs" doesn't get clobbered.
 *
 * `description` is the raw stored value, which in MindBlown's data model is
 * either a plain string, a ProseMirror JSON object, or null. We only operate
 * on the string flavour — non-string descriptions get a fresh leading line.
 */
export function updateChildPrsTailLine(
  description: string | null,
  counts: RollupCounts,
): string {
  const line = `${TAIL_LINE_PREFIX} ${counts.closed}/${counts.total} merged (auto-tracked)`;
  if (!description) return line;
  if (TAIL_LINE_RE.test(description)) {
    return description.replace(TAIL_LINE_RE, line);
  }
  // Append with one blank-line separator if the existing description has
  // content; otherwise just the line.
  const trimmed = description.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n\n${line}` : line;
}

// ── Persistence ──────────────────────────────────────────────────

/**
 * Find every node linked to a given GitHub issue across all maps in this
 * deployment. Repos are shared across maps in practice (the same repo can
 * back multiple workspace views), so we update all of them.
 *
 * Returns full node rows so the caller can read existing description +
 * autoProgress without re-fetching.
 */
async function findNodesByExternalId(externalId: string): Promise<Node[]> {
  const rows = await db.select().from(nodes);
  const out: Node[] = [];
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    if (!links.some((l) => l.provider === 'github' && l.externalId === externalId)) continue;
    const node = await nodeDb.getNode(row.id);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Apply the rollup percentage + tail line to a single parent node.
 *
 * Respects the node's `autoProgress` opt-in: `'off'` is a no-op (returns
 * `false`). Skips the write entirely when `counts.total === 0`, so a parent
 * with no detectable children isn't blasted to 0%.
 *
 * Returns true if the node was actually updated.
 */
export async function applyRollupToParent(
  parentNode: Node,
  counts: RollupCounts,
): Promise<boolean> {
  if (parentNode.autoProgress !== 'children') return false;
  if (counts.total <= 0) return false;

  const pct = computeRollupPercent(counts);

  // ProseMirror JSON descriptions are preserved as-is. The DB column is
  // jsonb and the existing GitHub importer writes a plain string into it
  // (`description: item.issue.body`); for those nodes we maintain the
  // `Child PRs: X/Y merged (auto-tracked)` tail line in the string body.
  // For nodes whose description is a ProseMirror doc (rich-text editor
  // output), overwriting it with a plain-string tail line would silently
  // destroy the rich content, so we only update `percentComplete` and
  // leave the doc alone. Injecting the tail line into a ProseMirror tree
  // is a deliberate non-goal here — see the MindBlown CLAUDE.md "Feature
  // Definition of Done" notes on valid follow-ups vs blocked surfaces.
  const updates: nodeDb.UpdateNodeInput = { percentComplete: pct };
  const updatedFields: Array<'percentComplete' | 'description'> = ['percentComplete'];
  if (
    typeof parentNode.description === 'string' ||
    parentNode.description === null ||
    parentNode.description === undefined
  ) {
    const currentDescription =
      typeof parentNode.description === 'string' ? parentNode.description : null;
    const newDescription = updateChildPrsTailLine(currentDescription, counts);
    updates.description =
      newDescription as unknown as nodeDb.UpdateNodeInput['description'];
    updatedFields.push('description');
  }

  const updated = await nodeDb.updateNode(parentNode.id, updates);
  if (updated) {
    broadcast(updated.mapId, {
      type: 'node:updated',
      nodeId: parentNode.id,
      fields: updatedFields,
      node: updated,
      source: 'parent_epic_rollup',
    });
    return true;
  }
  return false;
}

// ── Top-level entry point ────────────────────────────────────────

export interface RollupContext {
  owner: string;
  repo: string;
  token: string;
}

/**
 * Parse `childTitle` for parent references and, for each one, recompute the
 * linked parent node's progress from the full set of sibling issues in the
 * repo. No-ops when:
 *   - the title doesn't match any parent pattern,
 *   - no node in any map is linked to the parent's externalId,
 *   - the matched parent node has `autoProgress: 'off'` (the default).
 *
 * Errors fetching the issue list are logged and swallowed — the close/reopen
 * of the child itself has already been applied by the caller, and the
 * catch-up will retry next cycle.
 *
 * Returns the number of parent nodes successfully updated.
 */
export async function rollupParentsForChildTitle(
  childTitle: string,
  ctx: RollupContext,
): Promise<number> {
  const parents = parseParentReferences(childTitle);
  if (parents.length === 0) return 0;

  let allIssues: GitHubIssue[];
  try {
    // `since=null` → fetch all repo issues. This is the same heavy call the
    // initial import makes. For the webhook path we accept the cost (a few
    // hundred ms per child-close on a busy repo); for the catch-up path the
    // caller can batch and pass `allIssues` in via `applyRollupForFetchedIssues`.
    allIssues = await fetchChangedIssues(ctx.owner, ctx.repo, ctx.token, null);
  } catch (err) {
    console.warn(
      `[parent-epic-rollup] Failed to fetch ${ctx.owner}/${ctx.repo} issues:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  return applyRollupForFetchedIssues(parents, allIssues, ctx);
}

/**
 * Same as `rollupParentsForChildTitle` but takes the issue list as a
 * parameter. Used by the catch-up reconciler which has already fetched the
 * (changed-since-last-sync) issue list and would otherwise pay for the
 * full re-fetch once per child PR in the batch.
 *
 * Note that the catch-up case passes only the recently-changed issues — for
 * the sibling-count to be correct, the catch-up wrapper must re-fetch the
 * full set when it sees a child PR transition. This indirection is kept so
 * the cheap path stays cheap.
 */
export async function applyRollupForFetchedIssues(
  parentNumbers: ReadonlyArray<number>,
  allIssues: ReadonlyArray<Pick<GitHubIssue, 'number' | 'title' | 'state'>>,
  ctx: Pick<RollupContext, 'owner' | 'repo'>,
): Promise<number> {
  let updates = 0;
  for (const parentNumber of parentNumbers) {
    const counts = siblingsForParent(allIssues, parentNumber);
    if (counts.total <= 0) continue;
    const externalId = `${ctx.owner}/${ctx.repo}#${parentNumber}`;
    const parentNodes = await findNodesByExternalId(externalId);
    for (const node of parentNodes) {
      const ok = await applyRollupToParent(node, counts);
      if (ok) updates++;
    }
  }
  return updates;
}
