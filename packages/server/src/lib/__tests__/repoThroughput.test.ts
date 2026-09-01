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

/**
 * Pagination and the error path had no coverage at all — only the five
 * cache tests above, two of which assert call counts and stay green even
 * if the crawl finds nothing. That is why widening the `catch` slipped
 * through: nothing here could see it.
 */
describe('fetchMergedPrsSince pagination', () => {
  beforeEach(() => {
    clearThroughputCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serves pages by cursor and advertises the next one via `Link`. */
  function mockPagedFetch(pages: unknown[][], opts: { refusePage?: boolean } = {}) {
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = new URL(String(rawUrl));
      if (opts.refusePage && url.searchParams.has('page')) {
        return {
          ok: false,
          status: 422,
          headers: new Headers(),
          text: async () =>
            '{"message":"Pagination with the page parameter is not supported for large datasets"}',
        };
      }
      const index = Number(url.searchParams.get('after') ?? '0');
      const next = new URL(url.toString());
      next.searchParams.set('after', String(index + 1));
      return {
        ok: true,
        status: 200,
        headers: new Headers(
          index + 1 < pages.length ? { link: `<${next.toString()}>; rel="next"` } : {},
        ),
        json: async () => pages[index] ?? [],
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('collects merged PRs across several pages', async () => {
    const since = Date.now() - 56 * DAY;
    const inWindow = new Date(since + DAY).toISOString();
    const fetchMock = mockPagedFetch([
      [ghPr(1, inWindow)],
      [ghPr(2, inWindow)],
      [ghPr(3, inWindow)],
    ]);

    const result = await fetchMergedPrsSince(ctx, since);

    expect(result.prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never puts a `page` parameter on the wire', async () => {
    // The 422 that broke the issue list is reachable from this endpoint
    // on a busy repo too — it was simply never triggered.
    const since = Date.now() - 56 * DAY;
    const inWindow = new Date(since + DAY).toISOString();
    const fetchMock = mockPagedFetch([[ghPr(1, inWindow)], [ghPr(2, inWindow)]], {
      refusePage: true,
    });

    const result = await fetchMergedPrsSince(ctx, since);

    expect(result.prs).toHaveLength(2);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('page')).toBeNull();
    }
  });

  it('stops once a whole page predates the window', async () => {
    const since = Date.now() - 56 * DAY;
    const old = new Date(since - 10 * DAY).toISOString();
    const fetchMock = mockPagedFetch([
      [ghPr(1, new Date(since + DAY).toISOString())],
      [ghPr(2, old)],
      [ghPr(3, old)],
    ]);

    const result = await fetchMergedPrsSince(ctx, since);

    expect(result.prs.map((p) => p.number)).toEqual([1]);
    // Page 3 is never requested — the sort is updated-desc, so anything
    // past an all-old page is older still.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports truncated when the page cap trips', async () => {
    const since = Date.now() - 56 * DAY;
    const inWindow = new Date(since + DAY).toISOString();
    mockPagedFetch(Array.from({ length: 12 }, (_, i) => [ghPr(i + 1, inWindow)]));

    const result = await fetchMergedPrsSince(ctx, since, 3);

    expect(result.truncated).toBe(true);
    expect(result.prs).toHaveLength(3);
  });
});

describe('fetchMergedPrsSince error handling', () => {
  beforeEach(() => {
    clearThroughputCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockStatus(status: number) {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      headers: new Headers(),
      text: async () => `{"message":"nope ${status}"}`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('degrades to a truncated window when GitHub refuses the list', async () => {
    // Unchanged from the raw-fetch loop: a non-2xx is swallowed so the
    // whole velocity report does not fail with it.
    const since = Date.now() - 56 * DAY;
    mockStatus(401);

    const result = await fetchMergedPrsSince(ctx, since);

    expect(result.prs).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('does NOT cache a result GitHub refused to give', async () => {
    // A 401 used to be cached for an hour as "0 merged PRs, rework 0" —
    // NET rate == gross rate — so an expired token read as a clean
    // forecast long after it was repaired.
    const since = Date.now() - 56 * DAY;
    const failing = mockStatus(401);

    const first = await fetchMergedPrsSince(ctx, since);
    expect(first.prs).toEqual([]);
    expect(failing).toHaveBeenCalledTimes(1);

    // Token repaired: the very next call must go back to GitHub.
    vi.unstubAllGlobals();
    const working = mockFetchReturning([ghPr(1, new Date(since + DAY).toISOString())]);
    vi.stubGlobal('fetch', working);

    const second = await fetchMergedPrsSince(ctx, since);

    expect(working).toHaveBeenCalled();
    expect(second.prs.map((p) => p.number)).toEqual([1]);
    expect(second.truncated).toBe(false);
  });

  it('propagates a transport failure instead of reporting an empty repo', async () => {
    // ECONNREFUSED / DNS. On master this propagated and velocityMeasure
    // logged it and set repoThroughput = null. Swallowed, it renders as
    // "the repo shipped nothing and the forecast is clean".
    const since = Date.now() - 56 * DAY;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(fetchMergedPrsSince(ctx, since)).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates a non-list body instead of reporting an empty repo', async () => {
    const since = Date.now() - 56 * DAY;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ message: 'not a list' }),
      })),
    );

    await expect(fetchMergedPrsSince(ctx, since)).rejects.toThrow(/Expected a list/);
  });
});
