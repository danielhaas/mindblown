/**
 * Fetch a repo's recently-merged PRs for the net-of-rework velocity signal.
 *
 * MindBlown stores only each node's *current* linked PR, not history, so the
 * rework + review-latency signals are read live from the connected repo at
 * report time. This pages closed PRs (newest-updated first) and keeps the ones
 * merged inside the window; the pure analysis (latency, rework share) lives in
 * `@mindblown/core` (`analyzeRepoThroughput`).
 */

import type { PrRecord } from '@mindblown/core';
import type { GitHubMapContext } from './githubContext.js';

const PER_PAGE = 100;

export interface FetchMergedPrsResult {
  prs: PrRecord[];
  truncated: boolean; // hit the page cap — window may be partially covered
}

/**
 * Page `GET /repos/:owner/:repo/pulls?state=closed` (sorted by most-recently
 * updated) and collect PRs whose `merged_at` falls on/after `sinceMs`. Stops
 * once a full page is older than the window or `maxPages` is reached.
 */
export async function fetchMergedPrsSince(
  ctx: GitHubMapContext,
  sinceMs: number,
  maxPages = 8,
): Promise<FetchMergedPrsResult> {
  const out: PrRecord[] = [];
  let page = 1;
  let truncated = false;

  for (; page <= maxPages; page++) {
    const url =
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/pulls` +
      `?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      // Auth/rate-limit/other — return what we have rather than failing the report.
      truncated = true;
      break;
    }
    const rows = (await res.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      created_at: string;
      merged_at: string | null;
      updated_at: string;
    }>;
    if (rows.length === 0) break;

    for (const r of rows) {
      if (r.merged_at && Date.parse(r.merged_at) >= sinceMs) {
        out.push({
          number: r.number,
          title: r.title,
          body: r.body,
          createdAt: r.created_at,
          mergedAt: r.merged_at,
        });
      }
    }

    // Once the whole page's activity predates the window, older pages can't
    // contain in-window merges (sorted by updated desc).
    const pageAllOld = rows.every((r) => Date.parse(r.updated_at) < sinceMs);
    if (pageAllOld) break;
    if (page === maxPages && rows.length === PER_PAGE) truncated = true;
  }

  return { prs: out, truncated };
}
