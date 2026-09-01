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
import { paginateGitHub } from '@mindblown/integrations';
import type { GitHubMapContext } from './githubContext.js';

const PER_PAGE = 100;

export interface FetchMergedPrsResult {
  prs: PrRecord[];
  truncated: boolean; // hit the page cap — window may be partially covered
}

// The crawl below costs up to `maxPages` sequential GitHub round-trips and
// feeds a signal (rework share) that moves on a scale of weeks, so results
// are cached in-process for an hour. The hourly snapshot cron passes
// `bypassCache` and thereby keeps the cache warm for interactive loads.
const CACHE_TTL_MS = 60 * 60 * 1000;
const throughputCache = new Map<
  string,
  { fetchedAt: number; sinceMs: number; result: FetchMergedPrsResult }
>();

export function clearThroughputCache(): void {
  throughputCache.clear();
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
  opts?: { bypassCache?: boolean },
): Promise<FetchMergedPrsResult> {
  const cacheKey = `${ctx.owner}/${ctx.repo}`;
  const cached = throughputCache.get(cacheKey);
  if (
    !opts?.bypassCache &&
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    // Same look-back window: two calls with equal windowDays made within the
    // TTL differ in sinceMs by < TTL; different windows differ by days.
    Math.abs(cached.sinceMs - sinceMs) < CACHE_TTL_MS
  ) {
    return {
      // The window's leading edge moved forward since the fetch — drop PRs
      // that no longer fall inside it.
      prs: cached.result.prs.filter((p) => Date.parse(p.mergedAt) >= sinceMs),
      truncated: cached.result.truncated,
    };
  }

  const result = await fetchMergedPrsUncached(ctx, sinceMs, maxPages);
  throughputCache.set(cacheKey, { fetchedAt: Date.now(), sinceMs, result });
  return result;
}

async function fetchMergedPrsUncached(
  ctx: GitHubMapContext,
  sinceMs: number,
  maxPages: number,
): Promise<FetchMergedPrsResult> {
  const out: PrRecord[] = [];
  let truncated = false;

  interface PrRow {
    number: number;
    title: string;
    body: string | null;
    created_at: string;
    merged_at: string | null;
    updated_at: string;
  }

  try {
    // Follows `Link: rel="next"` instead of counting `page` up. Same
    // reason as the issue-list walks in @mindblown/integrations: past a
    // certain depth GitHub refuses `page` on a large dataset and answers
    // 422. This endpoint sits on the same repo and the same depth
    // budget, so it was one busy repo away from the identical break.
    const walk = await paginateGitHub<PrRow>(
      `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/pulls` +
        `?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}`,
      ctx.token,
      {
        maxPages,
        onPage: (rows) => {
          if (rows.length === 0) return false;

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

          // Once the whole page's activity predates the window, older pages
          // can't contain in-window merges (sorted by updated desc).
          if (rows.every((r) => Date.parse(r.updated_at) < sinceMs)) return false;
          return true;
        },
      },
    );
    truncated = walk.truncated;
  } catch {
    // Auth / rate limit / anything else — return what we have rather than
    // failing the whole report. Unchanged intent; the difference is that
    // `paginateGitHub` throws where the raw fetch handed back a non-ok
    // response for us to inspect.
    truncated = true;
  }

  return { prs: out, truncated };
}
