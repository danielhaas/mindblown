import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMergedPrsSince, clearThroughputCache } from '../repoThroughput.js';
import type { GitHubMapContext } from '../githubContext.js';

const ctx: GitHubMapContext = { owner: 'acme', repo: 'widgets', token: 't' };

const DAY = 86_400_000;

function ghPr(number: number, mergedAt: string) {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    created_at: mergedAt,
    merged_at: mergedAt,
    updated_at: mergedAt,
  };
}

// Serves `rows` on the first page and nothing after it.
//
// This used to key on `url.endsWith('&page=1')` — the exact idiom the
// crawl no longer emits. Pagination follows `Link: rel="next"` now, so
// the first page is the request with no cursor, and omitting the header
// is how this stub says "that was the last page".
function mockFetchReturning(rows: unknown[]) {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => (new URL(String(url)).searchParams.has('after') ? [] : rows),
  })) as unknown as typeof fetch;
}

describe('fetchMergedPrsSince cache', () => {
  beforeEach(() => {
    clearThroughputCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves a second call from cache without hitting GitHub', async () => {
    const since = Date.now() - 56 * DAY;
    const fetchMock = mockFetchReturning([ghPr(1, new Date(since + DAY).toISOString())]);
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchMergedPrsSince(ctx, since);
    const second = await fetchMergedPrsSince(ctx, since);

    expect(first.prs).toHaveLength(1);
    expect(second.prs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-filters cached PRs against the newer window edge', async () => {
    const now = Date.now();
    const edge = now - 56 * DAY;
    // One PR just inside the original window, one comfortably inside.
    const fetchMock = mockFetchReturning([
      ghPr(1, new Date(edge + 1000).toISOString()),
      ghPr(2, new Date(now - DAY).toISOString()),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchMergedPrsSince(ctx, edge);
    expect(first.prs).toHaveLength(2);

    // Window edge moved forward past PR 1's merge time (still within the
    // TTL tolerance) — the cached result must drop it.
    const second = await fetchMergedPrsSince(ctx, edge + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.prs.map((p) => p.number)).toEqual([2]);
  });

  it('bypassCache forces a re-crawl and refreshes the cache', async () => {
    const since = Date.now() - 56 * DAY;
    const fetchMock = mockFetchReturning([ghPr(1, new Date(since + DAY).toISOString())]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchMergedPrsSince(ctx, since);
    await fetchMergedPrsSince(ctx, since, undefined, { bypassCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The bypass call re-warmed the cache — a plain call hits it again.
    await fetchMergedPrsSince(ctx, since);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a different look-back window misses the cache', async () => {
    const now = Date.now();
    const fetchMock = mockFetchReturning([]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchMergedPrsSince(ctx, now - 56 * DAY);
    await fetchMergedPrsSince(ctx, now - 7 * DAY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches per repo', async () => {
    const since = Date.now() - 56 * DAY;
    const fetchMock = mockFetchReturning([]);
    vi.stubGlobal('fetch', fetchMock);

    await fetchMergedPrsSince(ctx, since);
    await fetchMergedPrsSince({ ...ctx, repo: 'other' }, since);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
