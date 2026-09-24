/**
 * Link-header pagination over a `ForgeClient` (#367/#368).
 *
 * Both GitHub and Gitea page their list endpoints with `Link: …; rel="next"`,
 * so one walker serves every forge. Moved here from `../github.ts` so the
 * forge implementations can use it for their own per-issue scans without
 * importing the sync layer (which imports them).
 *
 * The exported names keep their historical `GitHub…` spelling — the server
 * and the unit tests import them by name.
 */

import { ForgeApiError, type ForgeClient } from './types.js';
import { GITHUB_API_BASE } from './constants.js';

/**
 * A 422 that means "this list is too deep for `page` — use cursors".
 *
 * GitHub refuses `page`-based pagination past a certain depth on large
 * datasets and says so in the body. The raw message names the mechanism
 * but not the way out, so the caller reads a 500 and has nothing to do
 * about it. This subclass names the way out.
 *
 * The Link-header paginator below makes this unreachable for our own
 * loops — GitHub hands us whichever scheme the endpoint wants. It stays
 * because a hand-built `?page=` somewhere else, or an instance running a
 * build from before this fix, still produces it, and then the message is
 * the only self-help the operator gets.
 */
export class GitHubPaginationLimitError extends ForgeApiError {
  constructor(body: string) {
    super(422, body, 'github');
    this.name = 'GitHubPaginationLimitError';
    this.message =
      'GitHub refused page-based pagination on this dataset — it is too large. ' +
      'Narrow the range (pass `since`, or a smaller `limit`) and run it again. ' +
      `Original: ${body}`;
  }
}

function isPaginationLimit(status: number, body: string): boolean {
  return (
    status === 422 &&
    /pagination with the page parameter is not supported/i.test(body)
  );
}

/**
 * A `Link: rel="next"` pointed somewhere other than the host the walk
 * started on — refused before the request is made.
 *
 * The reason this exists is narrow and worth stating plainly. Before the
 * Link-header change every URL this module fetched was built internally
 * from an owner/repo pair. Now one arrives in a response header, and
 * `githubFetchPage` attaches `Authorization: Bearer <installation token>`
 * to whatever it is handed. Following an off-origin `next` would hand
 * the token to that host — over plain `http://` if the header says so.
 *
 * Exploiting it needs GitHub itself or a MITM, and a MITM already has
 * the token from the first request. It is still a trust assumption that
 * did not exist before this refactor, and it costs two lines not to make
 * it.
 */
export class GitHubCrossOriginPaginationError extends Error {
  readonly fromOrigin: string;
  readonly toUrl: string;
  constructor(fromOrigin: string, toUrl: string) {
    super(
      `Refusing to follow pagination from ${fromOrigin} to ${toUrl}: the Link ` +
        'header points at a different origin, and the request would carry the ' +
        'API token there.',
    );
    this.name = 'GitHubCrossOriginPaginationError';
    this.fromOrigin = fromOrigin;
    this.toUrl = toUrl;
  }
}

/**
 * Absolute form of a path this module fetches, for origin comparison —
 * relative paths resolve against the API base, which is what
 * `githubFetchPage` does with them.
 */
function absoluteUrl(pathOrUrl: string, apiBaseUrl: string): string {
  return pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBaseUrl}${pathOrUrl}`;
}

/**
 * A pagination hop must stay on the origin the walk started on.
 *
 * Throws rather than stopping quietly: a `Link` we refuse to follow
 * means the listing is incomplete, and returning a prefix as if it were
 * the whole list is the fail-open shape this PR exists to remove.
 *
 * `apiBaseUrl` is the forge the walk runs against (relative first paths
 * resolve against it); defaults to github.com for the direct callers.
 */
export function assertSamePaginationOrigin(
  firstPathOrUrl: string,
  nextUrl: string,
  apiBaseUrl: string = GITHUB_API_BASE,
): void {
  const fromOrigin = new URL(absoluteUrl(firstPathOrUrl, apiBaseUrl)).origin;
  let toOrigin: string;
  try {
    toOrigin = new URL(nextUrl).origin;
  } catch {
    // Not an absolute URL at all. GitHub always sends one; anything else
    // is not something to follow with a bearer token attached.
    throw new GitHubCrossOriginPaginationError(fromOrigin, nextUrl);
  }
  if (toOrigin !== fromOrigin) {
    throw new GitHubCrossOriginPaginationError(fromOrigin, nextUrl);
  }
}

/** A response body plus the one header that matters for paging. */
export interface GitHubPage<T> {
  data: T;
  /**
   * Absolute URL of the next page, from `Link: …; rel="next"`, or null
   * on the last page.
   */
  nextUrl: string | null;
}

/**
 * The `rel="next"` URL out of a `Link` header.
 *
 * Header shape:
 *   `<https://api.github.com/…?page=2>; rel="next", <…>; rel="last"`
 * or, on a cursor-paginated endpoint:
 *   `<https://api.github.com/…?after=Y3Vyc29yOnYyOpHOAA>; rel="next"`
 *
 * We do not care which. That is the whole point: GitHub picks the scheme
 * per endpoint and dataset size, so a caller that follows the header is
 * right under both — and stays right if GitHub changes its mind.
 *
 * Exported for tests.
 */
export function parseLinkNext(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;

  for (const { target, params } of splitLinkEntries(linkHeader)) {
    // RFC 8288: `rel` may carry several space-separated relation types
    // (`rel="next prev"`), quoted or bare. Compare TOKENS, never a
    // substring — `rel="nextpage"` is a different relation and following
    // it would page into whatever that endpoint is.
    const m = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i.exec(params);
    if (!m) continue;
    const value = m[1] ?? m[2] ?? '';
    if (value.split(/\s+/).some((t) => t.toLowerCase() === 'next')) return target;
  }
  return null;
}

/**
 * Split a `Link` header into its entries, respecting the two things that
 * make a naive `split(',')` wrong:
 *
 *   - the target inside `<…>` may contain commas (`?labels=bug,urgent`),
 *     which is legal precisely because the angle brackets delimit it;
 *   - a quoted parameter value may contain commas (`title="Foo, Bar"`).
 *
 * Both produce the same failure if mishandled: the entry is cut in half,
 * `rel="next"` is lost, the paginator stops after page one and reports
 * `truncated: false`. That is a silent fail-open — the shape this whole
 * change set exists to remove — so it is worth a real scanner rather
 * than a regex that is right about most headers.
 */
function splitLinkEntries(header: string): Array<{ target: string; params: string }> {
  const entries: Array<{ target: string; params: string }> = [];
  let i = 0;

  while (i < header.length) {
    const open = header.indexOf('<', i);
    if (open < 0) break;
    const close = header.indexOf('>', open + 1);
    if (close < 0) break;
    const target = header.slice(open + 1, close);

    // Parameters run to the next top-level comma — one that is neither
    // inside quotes nor inside a following `<…>`.
    let j = close + 1;
    let inQuotes = false;
    while (j < header.length) {
      const ch = header[j];
      if (ch === '"' && header[j - 1] !== '\\') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) break;
      j += 1;
    }

    entries.push({ target, params: header.slice(close + 1, j) });
    i = j + 1;
  }

  return entries;
}

export async function githubFetchPage<T>(
  path: string,
  forge: ForgeClient,
  options: RequestInit = {},
): Promise<GitHubPage<T>> {
  // The client resolves relative paths against its API base and adds the
  // auth + API headers; `options.headers` still override them as before.
  const res = await forge.request(path, {
    method: options.method ?? undefined,
    body: typeof options.body === 'string' ? options.body : undefined,
    headers: (options.headers as Record<string, string> | undefined) ?? undefined,
    signal: options.signal ?? undefined,
  });

  if (!(res.ok ?? (res.status >= 200 && res.status < 300))) {
    const body = await res.text();
    if (isPaginationLimit(res.status, body)) throw new GitHubPaginationLimitError(body);
    throw new ForgeApiError(res.status, body, forge.endpoint.kind);
  }

  // 204 No Content
  if (res.status === 204) {
    return { data: undefined as unknown as T, nextUrl: null };
  }

  // `headers` is absent on hand-rolled test doubles; treat that as "no
  // next page" rather than throwing.
  const nextUrl = parseLinkNext(res.headers?.get?.('link'));
  return { data: (await res.json()) as T, nextUrl };
}

/** One JSON request through the client, body only. */
export async function githubFetch<T>(
  path: string,
  forge: ForgeClient,
  options: RequestInit = {},
): Promise<T> {
  return (await githubFetchPage<T>(path, forge, options)).data;
}

/**
 * Walk a paginated list endpoint by following `Link: rel="next"`.
 *
 * Replaces the hand-rolled `let page = 1; … page++` loops this file
 * carried, one per call site. Those broke on 2026-09-01 against a repo
 * of ~10 000 issues: past a certain depth GitHub answers
 * `422 "Pagination with the page parameter is not supported for large
 * datasets, please use cursor based pagination (after/before)"`. The fix
 * is not to hand-build `after`/`before` — it is to stop deciding the
 * scheme at all and follow the one the forge put in the header.
 *
 * `onPage` sees each batch and returns `false` to stop early (the
 * throughput report walks a time window and stops once past it).
 * `maxPages` is a hard backstop; the returned `truncated` says whether
 * it tripped, so a caller can refuse to treat a prefix as the whole list.
 */
export async function paginateGitHub<T>(
  firstPath: string,
  forge: ForgeClient,
  opts: {
    maxPages: number;
    onPage: (batch: T[]) => boolean | void;
    /** Called once when `maxPages` trips, for the call site's own log line. */
    onTruncated?: () => void;
  },
): Promise<{ pages: number; truncated: boolean }> {
  let url: string | null = firstPath;
  let pages = 0;

  while (url) {
    const page: GitHubPage<T[]> = await githubFetchPage<T[]>(url, forge);
    // A non-array body (a shape change, or an error GitHub answered 200
    // to) must not read as "the list ended here".
    if (!Array.isArray(page.data)) {
      throw new Error(`Expected a list from ${url}, got ${typeof page.data}`);
    }
    pages += 1;
    if (opts.onPage(page.data) === false) return { pages, truncated: false };
    if (!page.nextUrl) return { pages, truncated: false };
    if (pages >= opts.maxPages) {
      opts.onTruncated?.();
      return { pages, truncated: true };
    }
    // The next URL comes out of a response header and the next request
    // carries the API token. It does not leave the origin we started on.
    assertSamePaginationOrigin(firstPath, page.nextUrl, forge.endpoint.apiBaseUrl);
    url = page.nextUrl;
  }

  return { pages, truncated: false };
}

/**
 * Page ceiling for the per-issue list endpoints (timeline, events).
 * 20 × 100 = 2000 entries on a single issue; past that we refuse to
 * answer rather than answer from a prefix — see
 * `GitHubScanTruncatedError`.
 */
export const MAX_ISSUE_SCAN_PAGES = 20;

/**
 * Thrown when a per-issue scan hit its page ceiling before reaching the
 * end of the list.
 *
 * This is deliberately an ERROR and not a flag. Both endpoints it guards
 * are sorted ASCENDING, so a truncated scan is missing the NEWEST
 * entries — exactly the ones that decide "did this issue's work land"
 * and "what was the most recent close". Every caller of these functions
 * treats a throw as "no evidence" and therefore holds; a boolean would
 * have to be threaded through four layers, and the one layer that forgot
 * it would close a ticket as COMPLETED off a prefix of its own history.
 */
export class GitHubScanTruncatedError extends Error {
  constructor(what: string, ref: string) {
    super(
      `${what} for ${ref} exceeded ${MAX_ISSUE_SCAN_PAGES} pages — refusing to answer from a partial scan`,
    );
    this.name = 'GitHubScanTruncatedError';
  }
}

/**
 * Walk every page of a per-issue list endpoint.
 *
 * Throws `GitHubScanTruncatedError` at the page ceiling instead of
 * returning what it has — see that class for why truncation here is an
 * error and not a flag. `path` must already carry the forge's page-size
 * parameter (`per_page` on GitHub, `limit` on Gitea).
 */
export async function walkIssueScan<T>(
  path: string,
  forge: ForgeClient,
  what: string,
  ref: string,
): Promise<T[]> {
  const out: T[] = [];
  const { truncated } = await paginateGitHub<T>(path, forge, {
    maxPages: MAX_ISSUE_SCAN_PAGES,
    onPage: (batch) => {
      out.push(...batch);
    },
  });
  if (truncated) throw new GitHubScanTruncatedError(what, ref);
  return out;
}
