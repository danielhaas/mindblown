/**
 * Optional forge label write-back for triage decisions (#96, Phase 3).
 *
 * When a map opts into `triage_label_writeback`, finalised triage
 * decisions write a `triage:placed` or `triage:skipped` label back to
 * the source issue:
 *
 *   - decision='place'     → add `triage:placed`, remove `triage:skipped`
 *   - decision='skip'      → add `triage:skipped`, remove `triage:placed`
 *   - decision='uncertain' → no label change (intermediate state, don't
 *                            spam the forge)
 *
 * Best-effort: a label-write failure must NEVER block the triage flow.
 * We log + ignore. If the operator hasn't created the label in their
 * repo, GitHub returns 422 — we treat that as a no-op and warn.
 *
 * We don't auto-create labels: the operator is expected to set them up
 * in their repo first. That's a deliberate UX choice — silent
 * label creation surprises owners of public repos.
 *
 * Client resolution flows through the existing `getGitHubContextForMap`
 * helper so App installations and PAT integrations both work.
 */

import { GitHubApiError, createForgeClient, type ForgeClient, type ForgeFetch } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getGitHubContextForMap } from '../lib/githubContext.js';

export const TRIAGE_PLACED_LABEL = 'triage:placed';
export const TRIAGE_SKIPPED_LABEL = 'triage:skipped';

export type FinalizedTriageDecision = 'place' | 'skip' | 'uncertain';

interface WriteLabelOpts {
  mapId: string;
  externalId: string; // "owner/repo#NNN"
  decision: FinalizedTriageDecision;
  /**
   * The node id the decision actually placed (when `decision='place'`).
   * Null/undefined means the decision said "place" but the placement
   * hasn't landed yet (low-confidence auto-decision still pending
   * operator review). In that state we skip the `triage:placed` add —
   * the label would lie about a node that doesn't exist in the map.
   * The label fires later when the operator confirms/overrides and a
   * node is actually created. Ignored for skip/uncertain. See #178.
   */
  placedNodeId?: string | null;
  /**
   * Test injection: replace the HTTP transport underneath the forge
   * client. Production callers omit this; tests pass a mock to assert
   * request shape.
   */
  fetchImpl?: ForgeFetch;
}

// Phase 3 follow-up (#104 item 10): per-request timeout for label
// writeback. The write-back is best-effort, so a hung request must NEVER
// block the parent triage flow. 8 s is generous for GitHub's p99 (~1 s)
// but short enough that a wedged connection clears before the operator's
// own request returns. AbortError is treated identically to any other
// error in the try/catch below (warn + continue).
const LABEL_WRITEBACK_TIMEOUT_MS = 8_000;

// Phase 3 follow-up (#104 item 13): tighter regex than the previous
// `(.+?)\/(.+?)#(\d+)` form, which allowed `/` or `#` inside the
// owner/repo capture and could parse "ow/ner/repo#1" or "owner/re#po#1"
// in confusing ways. The new pattern rejects nested `/` in the repo
// segment and a stray `#` anywhere left of the issue number.
function parseExternalId(
  externalId: string,
): { owner: string; repo: string; issueNumber: number } | null {
  const match = externalId.match(/^([^/]+)\/([^/#]+)#(\d+)$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

/**
 * Run one forge call under the 8 s AbortController-backed timeout. The
 * injected test transport ignores the signal — it never hits the network
 * — so the timer is harmless there.
 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LABEL_WRITEBACK_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply the desired triage label state to the issue. Best-effort:
 * never throws. Callers do `await applyTriageLabel(...)` and continue
 * regardless of outcome.
 *
 * - place + placedNodeId → POST `triage:placed`, DELETE `triage:skipped`
 * - place + no placedNodeId → DELETE `triage:skipped` only (#178)
 * - skip → POST `triage:skipped`, DELETE `triage:placed`
 * - uncertain → DELETE BOTH `triage:placed` and `triage:skipped` so a
 *   previous decision's label can't outlive a flip into uncertain (#181)
 *
 * The remove step is best-effort: if the label isn't on the issue,
 * GitHub returns 404 — we treat that as a no-op and don't log.
 */
export async function applyTriageLabel(opts: WriteLabelOpts): Promise<void> {
  // Gate: map must have label writeback enabled.
  const [mapRow] = await db
    .select({ writeback: maps.triageLabelWriteback })
    .from(maps)
    .where(eq(maps.id, opts.mapId));
  if (!mapRow || mapRow.writeback !== true) return;

  const parsed = parseExternalId(opts.externalId);
  if (!parsed) {
    console.warn(
      `[triage-label] could not parse externalId=${JSON.stringify(opts.externalId)} for map ${opts.mapId}; skipping label writeback`,
    );
    return;
  }

  const ghCtx = await getGitHubContextForMap(opts.mapId);
  if (!ghCtx) {
    console.warn(
      `[triage-label] no GitHub context for map ${opts.mapId}; skipping label writeback`,
    );
    return;
  }

  // Same endpoint + token as the map's client, on the injected transport
  // when a test asks for one.
  const forge: ForgeClient = opts.fetchImpl
    ? createForgeClient({ ...ghCtx.forge.endpoint, token: ghCtx.forge.token }, opts.fetchImpl)
    : ghCtx.forge;

  // #178: gate the ADD step for place decisions that haven't actually
  // placed a node. Without this, the row's GH label says "we put it in
  // the map" even though `placed_node_id IS NULL` (pending operator
  // review). Uncertain decisions never add a label.
  const shouldAddLabel =
    opts.decision === 'skip' ||
    (opts.decision === 'place' && opts.placedNodeId != null);

  const addLabel =
    opts.decision === 'place' ? TRIAGE_PLACED_LABEL : TRIAGE_SKIPPED_LABEL;

  // #181: uncertain transitions must clear BOTH previous labels — a
  // place→uncertain or skip→uncertain flip would otherwise leave the
  // pre-flip label on the GH issue, lying about the current state.
  // For place/skip the remove set is the single inverse label.
  const removeLabels: string[] =
    opts.decision === 'uncertain'
      ? [TRIAGE_PLACED_LABEL, TRIAGE_SKIPPED_LABEL]
      : opts.decision === 'place'
        ? [TRIAGE_SKIPPED_LABEL]
        : [TRIAGE_PLACED_LABEL];

  const { owner, repo, issueNumber } = parsed;

  // 1) Add the new label. The forge's add call is additive — existing
  //    labels are kept rather than replaced.
  if (shouldAddLabel) {
    try {
      const { status, bodyText } = await withTimeout((signal) =>
        forge.addIssueLabels(owner, repo, issueNumber, [addLabel], { signal }),
      );
      if (status === 422) {
        // GitHub returns 422 when the label doesn't exist on the repo.
        // Per spec: don't auto-create — log a warn and continue.
        console.warn(
          `[triage-label] label "${addLabel}" does not exist on ${owner}/${repo}; create it in your repo to enable writeback. (issue #${issueNumber})`,
        );
      } else if (status < 200 || status >= 300) {
        console.warn(
          `[triage-label] add ${addLabel} on ${owner}/${repo}#${issueNumber} returned ${status}: ${bodyText.slice(0, 200)}`,
        );
      }
    } catch (err) {
      if (err instanceof GitHubApiError) {
        console.warn(
          `[triage-label] add label failed on ${owner}/${repo}#${issueNumber}: ${err.message}`,
        );
      } else {
        console.warn(
          `[triage-label] add label network error on ${owner}/${repo}#${issueNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 2) Remove the inverse label(s). DELETE /labels/{name} returns 404
  //    if the label isn't on the issue — treat as no-op (very common).
  //    For uncertain decisions this loop walks both placed and skipped.
  for (const removeLabel of removeLabels) {
    try {
      const { status, bodyText } = await withTimeout((signal) =>
        forge.removeIssueLabel(owner, repo, issueNumber, removeLabel, { signal }),
      );
      if (status === 404) {
        // Label wasn't on the issue — common, silent skip.
      } else if (status === 422) {
        // Label doesn't exist on the repo at all — silent (mirror add-side
        // behaviour; the operator's already been warned).
      } else if (status < 200 || status >= 300) {
        console.warn(
          `[triage-label] remove ${removeLabel} on ${owner}/${repo}#${issueNumber} returned ${status}: ${bodyText.slice(0, 200)}`,
        );
      }
    } catch (err) {
      if (err instanceof GitHubApiError) {
        console.warn(
          `[triage-label] remove label failed on ${owner}/${repo}#${issueNumber}: ${err.message}`,
        );
      } else {
        console.warn(
          `[triage-label] remove label network error on ${owner}/${repo}#${issueNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
