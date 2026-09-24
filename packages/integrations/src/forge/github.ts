/**
 * GitHub implementation of `ForgeClient`.
 *
 * This is the ONE file in the codebase that knows GitHub's host names.
 * Everything else receives them through `ForgeEndpoint`. GitHub Enterprise
 * Server works by passing its own `apiBaseUrl` / `webBaseUrl`.
 */

import {
  ForgeApiError,
  type CreateIssueInput,
  type ForgeClient,
  type ForgeEndpoint,
  type ForgeFetch,
  type ForgeIssue,
  type ForgePullRequest,
  type ForgeRawResponse,
  type ForgeRequestInit,
  type ForgeResponse,
  type ListPullRequestsQuery,
  type RequestOptions,
} from './types.js';

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_WEB_BASE = 'https://github.com';

/** The public github.com endpoint — the default for every binding that predates #367. */
export const GITHUB_ENDPOINT: ForgeEndpoint = {
  kind: 'github',
  apiBaseUrl: GITHUB_API_BASE,
  webBaseUrl: GITHUB_WEB_BASE,
};

export interface GitHubForgeOptions {
  token: string;
  apiBaseUrl?: string | null;
  webBaseUrl?: string | null;
  /** Transport override for tests / injected shims. Defaults to the global `fetch`, read at call time. */
  fetchImpl?: ForgeFetch;
}

const defaultFetch: ForgeFetch = (url, init) => fetch(url, init);

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isOk(res: ForgeResponse): boolean {
  return res.ok ?? (res.status >= 200 && res.status < 300);
}

export class GitHubForge implements ForgeClient {
  readonly endpoint: ForgeEndpoint;
  readonly token: string;
  private readonly fetchImpl: ForgeFetch;

  constructor(opts: GitHubForgeOptions) {
    this.token = opts.token;
    this.endpoint = {
      kind: 'github',
      apiBaseUrl: stripSlash(opts.apiBaseUrl || GITHUB_API_BASE),
      webBaseUrl: stripSlash(opts.webBaseUrl || GITHUB_WEB_BASE),
    };
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
  }

  // ── Transport ───────────────────────────────────────────────────

  private url(pathOrUrl: string): string {
    return pathOrUrl.startsWith('http') ? pathOrUrl : `${this.endpoint.apiBaseUrl}${pathOrUrl}`;
  }

  request(pathOrUrl: string, init: ForgeRequestInit = {}): Promise<ForgeResponse> {
    return this.fetchImpl(this.url(pathOrUrl), {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: init.signal,
    });
  }

  async requestJson<T>(
    pathOrUrl: string,
    init: { method?: string; body?: unknown } = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await this.request(pathOrUrl, {
      method: init.method,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: opts.signal,
    });
    if (!isOk(res)) {
      throw new ForgeApiError(res.status, await res.text(), 'github');
    }
    // 204 No Content
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  private async raw(pathOrUrl: string, init: ForgeRequestInit): Promise<ForgeRawResponse> {
    const res = await this.request(pathOrUrl, init);
    return { status: res.status, bodyText: await res.text() };
  }

  // ── Issues / labels ─────────────────────────────────────────────

  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<ForgeIssue> {
    return this.requestJson<ForgeIssue>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title: input.title, body: input.body, labels: input.labels },
    });
  }

  addIssueLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
    opts?: RequestOptions,
  ): Promise<ForgeRawResponse> {
    // POST /issues/{n}/labels is additive — GitHub merges with the existing set.
    return this.raw(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
      signal: opts?.signal,
    });
  }

  removeIssueLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    label: string,
    opts?: RequestOptions,
  ): Promise<ForgeRawResponse> {
    return this.raw(
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE', signal: opts?.signal },
    );
  }

  // ── Pull requests ───────────────────────────────────────────────

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<ForgePullRequest> {
    return this.requestJson<ForgePullRequest>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  }

  pullRequestsListPath(owner: string, repo: string, query: ListPullRequestsQuery): string {
    return (
      `/repos/${owner}/${repo}/pulls` +
      `?state=${query.state}&sort=${query.sort}&direction=${query.direction}&per_page=${query.perPage}`
    );
  }

  async listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
    const rows = await this.requestJson<Array<{ filename: string }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    );
    return rows.map((f) => f.filename);
  }

  // ── URLs ────────────────────────────────────────────────────────

  issueWebUrl(owner: string, repo: string, issueNumber: number): string {
    return `${this.endpoint.webBaseUrl}/${owner}/${repo}/issues/${issueNumber}`;
  }
}

/** Build an issue's web URL for a known endpoint without a token. */
export function issueWebUrl(endpoint: ForgeEndpoint, ownerRepo: string, issueNumber: number | string): string {
  return `${stripSlash(endpoint.webBaseUrl)}/${ownerRepo}/issues/${issueNumber}`;
}
