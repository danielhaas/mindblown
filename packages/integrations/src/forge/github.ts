/**
 * GitHub implementation of `ForgeClient`.
 *
 * Together with `constants.ts` this is the only place in the codebase that
 * knows GitHub's host names. Everything else receives them through
 * `ForgeEndpoint`. GitHub Enterprise Server works by passing its own
 * `apiBaseUrl` / `webBaseUrl`.
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
  type IssueCloseEvent,
  type IssuesListQuery,
  type ListPullRequestsQuery,
  type MilestoneRef,
  type RequestOptions,
  type UpdateIssueInput,
} from './types.js';
import { GITHUB_API_BASE, GITHUB_WEB_BASE } from './constants.js';
import { walkIssueScan } from './pagination.js';

export { GITHUB_API_BASE, GITHUB_WEB_BASE, GITHUB_ENDPOINT } from './constants.js';

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

  // ── Issues ──────────────────────────────────────────────────────

  /** GitHub's REST shape IS the shared shape. */
  normalizeIssue<T extends object>(raw: T): T & ForgeIssue {
    return raw as T & ForgeIssue;
  }

  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<ForgeIssue> {
    return this.requestJson<ForgeIssue>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title: input.title, body: input.body, labels: input.labels },
    });
  }

  updateIssue(owner: string, repo: string, issueNumber: number, patch: UpdateIssueInput): Promise<ForgeIssue> {
    // GitHub takes every field in one PATCH: labels replace the set,
    // milestone is its `number`, state_reason is native.
    return this.requestJson<ForgeIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  issuesListPath(owner: string, repo: string, query: IssuesListQuery): string {
    const params = new URLSearchParams({
      state: query.state,
      per_page: String(query.perPage),
      sort: query.sort,
      direction: query.direction,
    });
    if (query.since) params.set('since', query.since);
    return `/repos/${owner}/${repo}/issues?${params.toString()}`;
  }

  // ── Labels ──────────────────────────────────────────────────────

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

  // ── Milestones ──────────────────────────────────────────────────

  async listMilestones(owner: string, repo: string): Promise<MilestoneRef[]> {
    const rows = await this.requestJson<Array<{ number: number; title: string; state: 'open' | 'closed' }>>(
      `/repos/${owner}/${repo}/milestones?state=all&per_page=100`,
    );
    return rows.map((m) => ({ ref: m.number, title: m.title, state: m.state }));
  }

  // ── Issue history ───────────────────────────────────────────────

  async listCrossReferencingPullRequests(owner: string, repo: string, issueNumber: number): Promise<number[]> {
    interface TimelineEvent {
      event?: string;
      source?: {
        type?: string;
        issue?: {
          number?: number;
          pull_request?: unknown;
          repository?: { full_name?: string };
        };
      };
    }
    // Writing `Closes #N` in a PR body makes GitHub post a `cross-referenced`
    // timeline event on issue N, so the timeline is the reliable index of
    // "which PRs point here". Read to its END (ascending) — on a long-lived
    // ticket the closing PR sits behind page 1.
    const fullName = `${owner}/${repo}`;
    const events = await walkIssueScan<TimelineEvent>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
      this,
      'issue timeline',
      `${fullName}#${issueNumber}`,
    );
    const seen: number[] = [];
    for (const ev of events) {
      if (ev.event !== 'cross-referenced') continue;
      const src = ev.source?.issue;
      if (!src?.pull_request) continue;
      if (src.repository?.full_name && src.repository.full_name !== fullName) continue;
      if (typeof src.number !== 'number') continue;
      if (seen.includes(src.number)) continue;
      seen.push(src.number);
    }
    return seen;
  }

  async getLatestCloseEvent(owner: string, repo: string, issueNumber: number): Promise<IssueCloseEvent | null> {
    interface RawEvent {
      event?: string;
      actor?: { login?: string } | null;
      commit_id?: string | null;
      created_at?: string;
      state_reason?: 'completed' | 'not_planned' | null;
    }
    const events = await walkIssueScan<RawEvent>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/events?per_page=100`,
      this,
      'issue events',
      `${owner}/${repo}#${issueNumber}`,
    );
    let latest: RawEvent | null = null;
    for (const ev of events) {
      if (ev.event !== 'closed') continue;
      latest = ev;
    }
    if (!latest) return null;
    return {
      actor: latest.actor?.login ?? null,
      commitId: latest.commit_id ?? null,
      createdAt: latest.created_at ?? null,
      stateReason: latest.state_reason ?? null,
    };
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
