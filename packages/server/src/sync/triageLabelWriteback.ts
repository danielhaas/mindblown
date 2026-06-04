/**
 * Optional GitHub label write-back for triage decisions (#96, Phase 3).
 *
 * When a map opts into `triage_label_writeback`, finalised triage
 * decisions write a `triage:placed` or `triage:skipped` label back to
 * the source GitHub issue:
 *
 *   - decision='place'     → add `triage:placed`, remove `triage:skipped`
 *   - decision='skip'      → add `triage:skipped`, remove `triage:placed`
 *   - decision='uncertain' → no label change (intermediate state, don't
 *                            spam GitHub)
 *
 * Best-effort: a label-write failure must NEVER block the triage flow.
 * We log + ignore. If the operator hasn't created the label in their
 * repo, GitHub returns 422 — we treat that as a no-op and warn.
 *
 * We don't auto-create labels: the operator is expected to set them up
 * in their GitHub repo first. That's a deliberate UX choice — silent
 * label creation surprises owners of public repos.
 *
 * Token resolution flows through the existing `getGitHubContextForMap`
 * helper so App installations and PAT integrations both work.
 */

import { GitHubApiError } from '@mindblown/integrations';
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
   * Test injection: replace the `githubFetch` HTTP call. Production
   * callers omit this; tests pass a mock to assert request shape.
   */
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ status: number; text: () => Promise<string> }>;
}

const GITHUB_API = 'https://api.github.com';

function parseExternalId(
  externalId: string,
): { owner: string; repo: string; issueNumber: number } | null {
  const match = externalId.match(/^(.+?)\/(.+?)#(\d+)$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

async function ghRequest(
  url: string,
  method: string,
  token: string,
  body: unknown | undefined,
  fetchImpl: WriteLabelOpts['fetchImpl'],
): Promise<{ status: number; bodyText: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  if (fetchImpl) {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, bodyText: text };
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, bodyText: text };
}

/**
 * Apply the desired triage label state to the GitHub issue. Best-effort:
 * never throws. Callers do `await applyTriageLabel(...)` and continue
 * regardless of outcome.
 *
 * The "remove the inverse label" step is also best-effort: if the inverse
 * label isn't on the issue, GitHub returns 404 on the remove — we treat
 * that as a no-op and don't log.
 */
export async function applyTriageLabel(opts: WriteLabelOpts): Promise<void> {
  // Gate: 'uncertain' is a no-op (we don't want intermediate-state label
  // churn on GitHub).
  if (opts.decision === 'uncertain') return;

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

  const addLabel =
    opts.decision === 'place' ? TRIAGE_PLACED_LABEL : TRIAGE_SKIPPED_LABEL;
  const removeLabel =
    opts.decision === 'place' ? TRIAGE_SKIPPED_LABEL : TRIAGE_PLACED_LABEL;

  const { owner, repo, issueNumber } = parsed;

  // 1) Add the new label. POST /repos/{owner}/{repo}/issues/{number}/labels
  //    is additive — GitHub merges with existing labels rather than
  //    replacing the set.
  try {
    const addUrl = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
    const { status, bodyText } = await ghRequest(
      addUrl,
      'POST',
      ghCtx.token,
      { labels: [addLabel] },
      opts.fetchImpl,
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

  // 2) Remove the inverse label. DELETE /labels/{name} returns 404 if
  //    the label isn't on the issue — treat as no-op (very common).
  try {
    const removeUrl = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(removeLabel)}`;
    const { status, bodyText } = await ghRequest(
      removeUrl,
      'DELETE',
      ghCtx.token,
      undefined,
      opts.fetchImpl,
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
