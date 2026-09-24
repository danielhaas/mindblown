/**
 * Gitea / Forgejo implementation of `ForgeClient` (#368).
 *
 * Gitea's REST API under `/api/v1` mirrors GitHub's for the paths the sync
 * layer uses, with the deltas below verified against Gitea 1.27.3
 * (git.project.li, 2026-09-24):
 *
 *   - auth header is `Authorization: token <PAT>`;
 *   - list page size is `limit`, not `per_page`; `Link: rel="next"` and
 *     `X-Total-Count` are sent, so the shared walker works;
 *   - `/issues?type=issues` excludes pull requests (GitHub mixes them in);
 *     there is no `sort`/`direction` on the issue list;
 *   - `POST /issues` takes label IDs, not names; `POST|PUT /issues/{n}/labels`
 *     accept names, but an unknown name is silently dropped (GitHub → 422);
 *   - `DELETE /issues/{n}/labels/{id}` needs the ID (a name → 404) and
 *     answers 204 whether or not the label was on the issue;
 *   - `PATCH /issues/{n}` ignores `labels` and `state_reason` (no such
 *     concept) and answers 201; milestones are addressed by `id`;
 *   - `assignees` is `null` when empty; `milestone` has `id` but no `number`;
 *   - there is no `/issues/{n}/events` — the timeline carries `close`,
 *     `reopen` and `pull_ref` (with `ref_action: closes|none`) entries;
 *   - a webhook carries both `X-Gitea-*` and GitHub-compatible headers;
 *     label changes arrive as `issues.label_updated`, not `labeled`.
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
import { walkIssueScan } from './pagination.js';

export interface GiteaForgeOptions {
  token: string;
  /** Root URL of the instance (`https://git.example`) or its API root (`…/api/v1`). */
  apiBaseUrl: string;
  /** Root URL for web links; defaults to `apiBaseUrl` with `/api/v1` stripped. */
  webBaseUrl?: string | null;
  fetchImpl?: ForgeFetch;
}

interface GiteaLabel {
  id: number;
  name: string;
  color: string;
}

interface GiteaMilestone {
  id: number;
  title: string;
  state: 'open' | 'closed';
  description?: string | null;
  due_on?: string | null;
  created_at?: string;
}

interface GiteaIssueRaw {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }> | null;
  assignees: Array<{ login: string; id: number }> | null;
  milestone: GiteaMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: { merged?: boolean; merged_at: string | null } | null;
}

interface GiteaTimelineEntry {
  type?: string;
  user?: { login?: string } | null;
  created_at?: string;
  ref_action?: string;
  ref_commit_sha?: string;
  ref_issue?: {
    number?: number;
    pull_request?: unknown;
    repository?: { full_name?: string };
  } | null;
}

const defaultFetch: ForgeFetch = (url, init) => fetch(url, init);

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isOk(res: ForgeResponse): boolean {
  return res.ok ?? (res.status >= 200 && res.status < 300);
}

/** Derive `{apiBaseUrl, webBaseUrl}` for a Gitea instance from whatever the operator typed. */
export function giteaEndpoint(apiOrRootUrl: string, webBaseUrl?: string | null): ForgeEndpoint {
  const root = stripSlash(apiOrRootUrl).replace(/\/api\/v1$/, '');
  return {
    kind: 'gitea',
    apiBaseUrl: `${root}/api/v1`,
    webBaseUrl: stripSlash(webBaseUrl || root),
  };
}

/**
 * Bring a Gitea issue onto the shared `ForgeIssue` shape: `assignees` null
 * → [], milestone gains `number` (= its id). Pure; also used on webhook
 * payloads by the server.
 */
export function normalizeGiteaIssue(input: object): ForgeIssue {
  const raw = input as unknown as GiteaIssueRaw;
  return {
    ...raw,
    labels: raw.labels ?? [],
    assignees: raw.assignees ?? [],
    milestone: raw.milestone
      ? {
          id: raw.milestone.id,
          number: raw.milestone.id,
          title: raw.milestone.title,
          description: raw.milestone.description ?? null,
          state: raw.milestone.state,
          due_on: raw.milestone.due_on ?? null,
          created_at: raw.milestone.created_at ?? '',
        }
      : null,
    // GitHub shows `pull_request` only on PRs; Gitea sends null on issues.
    pull_request: raw.pull_request ?? undefined,
  } as ForgeIssue;
}

/**
 * Map a Gitea webhook `action` onto the GitHub vocabulary the ingest
 * switches on. Anything not listed passes through unchanged.
 */
export function normalizeGiteaWebhookAction(event: string, action: string | undefined): string | undefined {
  if (!action) return action;
  if (event === 'issues' || event === 'pull_request') {
    if (action === 'label_updated') return 'labeled';
    if (action === 'label_cleared') return 'unlabeled';
  }
  return action;
}

export class GiteaForge implements ForgeClient {
  readonly endpoint: ForgeEndpoint;
  readonly token: string;
  private readonly fetchImpl: ForgeFetch;
  /** Label id lookup per repo, filled on first use; invalidated when we create one. */
  private labelCache = new Map<string, Map<string, GiteaLabel>>();

  constructor(opts: GiteaForgeOptions) {
    this.token = opts.token;
    this.endpoint = giteaEndpoint(opts.apiBaseUrl, opts.webBaseUrl);
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
        Accept: 'application/json',
        Authorization: `token ${this.token}`,
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
      throw new ForgeApiError(res.status, await res.text(), 'gitea');
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  private async raw(pathOrUrl: string, init: ForgeRequestInit): Promise<ForgeRawResponse> {
    const res = await this.request(pathOrUrl, init);
    return { status: res.status, bodyText: await res.text() };
  }

  // ── Labels (Gitea addresses them by id) ─────────────────────────

  private async labelsOf(owner: string, repo: string, refresh = false): Promise<Map<string, GiteaLabel>> {
    const key = `${owner}/${repo}`;
    const cached = this.labelCache.get(key);
    if (cached && !refresh) return cached;
    const all = await walkIssueScan<GiteaLabel>(
      `/repos/${owner}/${repo}/labels?limit=100`,
      this,
      'repo labels',
      key,
    );
    // Organisation-level labels apply to the repo too and resolve by name
    // on POST/PUT; a user owner has no org (404) and is skipped.
    try {
      const orgLabels = await walkIssueScan<GiteaLabel>(
        `/orgs/${owner}/labels?limit=100`,
        this,
        'org labels',
        owner,
      );
      all.push(...orgLabels);
    } catch (err) {
      // 404: user-owned repo, no org. 403: a scoped token without
      // read:organization — the repo's own labels are all we can see.
      if (!(err instanceof ForgeApiError && (err.status === 404 || err.status === 403))) throw err;
    }
    // Repo labels win on a name clash (listed first).
    const map = new Map<string, GiteaLabel>();
    for (const l of all) if (!map.has(l.name)) map.set(l.name, l);
    this.labelCache.set(key, map);
    return map;
  }

  /** Resolve names to ids, creating labels that don't exist yet (GitHub does this implicitly on issue create). */
  private async ensureLabelIds(owner: string, repo: string, names: string[]): Promise<number[]> {
    let map = await this.labelsOf(owner, repo);
    const ids: number[] = [];
    for (const name of names) {
      let l = map.get(name);
      if (!l) {
        l = await this.requestJson<GiteaLabel>(`/repos/${owner}/${repo}/labels`, {
          method: 'POST',
          body: { name, color: '#ededed' },
        });
        map = await this.labelsOf(owner, repo, true);
      }
      ids.push(l.id);
    }
    return ids;
  }

  // ── Issues ──────────────────────────────────────────────────────

  normalizeIssue<T extends object>(raw: T): T & ForgeIssue {
    return normalizeGiteaIssue(raw) as T & ForgeIssue;
  }

  async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<ForgeIssue> {
    const labels = await this.ensureLabelIds(owner, repo, input.labels);
    const raw = await this.requestJson<GiteaIssueRaw>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: { title: input.title, body: input.body, labels },
    });
    return normalizeGiteaIssue(raw);
  }

  async updateIssue(owner: string, repo: string, issueNumber: number, patch: UpdateIssueInput): Promise<ForgeIssue> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.body !== undefined) fields.body = patch.body;
    if (patch.state !== undefined) fields.state = patch.state;
    if (patch.milestone !== undefined) fields.milestone = patch.milestone ?? 0;
    // `state_reason` has no Gitea equivalent — dropped.

    let issue: GiteaIssueRaw | null = null;
    if (Object.keys(fields).length > 0) {
      issue = await this.requestJson<GiteaIssueRaw>(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
        method: 'PATCH',
        body: fields,
      });
    }
    if (patch.labels !== undefined) {
      // PUT replaces the set, like GitHub's PATCH `labels`. Names are
      // accepted; unknown ones are created first so none are dropped.
      await this.ensureLabelIds(owner, repo, patch.labels);
      const labels = await this.requestJson<Array<{ name: string }>>(
        `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
        { method: 'PUT', body: { labels: patch.labels } },
      );
      if (issue) issue = { ...issue, labels };
    }
    if (!issue) {
      issue = await this.requestJson<GiteaIssueRaw>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
    }
    return normalizeGiteaIssue(issue);
  }

  issuesListPath(owner: string, repo: string, query: IssuesListQuery): string {
    // No sort/direction on Gitea's issue list; `type=issues` keeps PRs out.
    const params = new URLSearchParams({
      state: query.state,
      limit: String(query.perPage),
      type: 'issues',
    });
    if (query.since) params.set('since', query.since);
    return `/repos/${owner}/${repo}/issues?${params.toString()}`;
  }

  async addIssueLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
    opts?: RequestOptions,
  ): Promise<ForgeRawResponse> {
    const res = await this.raw(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
      signal: opts?.signal,
    });
    if (res.status < 200 || res.status >= 300) return res;
    // Gitea answers 200 and silently drops names it doesn't know. Mirror
    // GitHub's 422 so the writeback's "create the label first" warning fires.
    let applied: Array<{ name: string }> = [];
    try {
      applied = JSON.parse(res.bodyText) as Array<{ name: string }>;
    } catch {
      return res;
    }
    // Case-insensitive: Gitea on MySQL/SQLite collates label names that way.
    const applied_lc = applied.map((l) => l.name.toLowerCase());
    const missing = labels.filter((name) => !applied_lc.includes(name.toLowerCase()));
    if (missing.length > 0) {
      return { status: 422, bodyText: `label(s) not found on ${owner}/${repo}: ${missing.join(', ')}` };
    }
    return res;
  }

  async removeIssueLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    label: string,
    opts?: RequestOptions,
  ): Promise<ForgeRawResponse> {
    const map = await this.labelsOf(owner, repo);
    const l = map.get(label);
    if (!l) return { status: 404, bodyText: `label "${label}" does not exist on ${owner}/${repo}` };
    return this.raw(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${l.id}`, {
      method: 'DELETE',
      signal: opts?.signal,
    });
  }

  // ── Milestones ──────────────────────────────────────────────────

  async listMilestones(owner: string, repo: string): Promise<MilestoneRef[]> {
    const rows = await this.requestJson<GiteaMilestone[]>(`/repos/${owner}/${repo}/milestones?state=all&limit=100`);
    return rows.map((m) => ({ ref: m.id, title: m.title, state: m.state }));
  }

  // ── Issue history (timeline) ────────────────────────────────────

  private timeline(owner: string, repo: string, issueNumber: number): Promise<GiteaTimelineEntry[]> {
    return walkIssueScan<GiteaTimelineEntry>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/timeline?limit=100`,
      this,
      'issue timeline',
      `${owner}/${repo}#${issueNumber}`,
    );
  }

  async listCrossReferencingPullRequests(owner: string, repo: string, issueNumber: number): Promise<number[]> {
    const fullName = `${owner}/${repo}`;
    const seen: number[] = [];
    for (const ev of await this.timeline(owner, repo, issueNumber)) {
      if (ev.type !== 'pull_ref') continue;
      const src = ev.ref_issue;
      if (!src?.pull_request) continue;
      if (src.repository?.full_name && src.repository.full_name !== fullName) continue;
      if (typeof src.number !== 'number') continue;
      if (seen.includes(src.number)) continue;
      seen.push(src.number);
    }
    return seen;
  }

  async getLatestCloseEvent(owner: string, repo: string, issueNumber: number): Promise<IssueCloseEvent | null> {
    let latest: GiteaTimelineEntry | null = null;
    for (const ev of await this.timeline(owner, repo, issueNumber)) {
      if (ev.type === 'close') latest = ev;
    }
    if (!latest) return null;
    return {
      actor: latest.user?.login ?? null,
      commitId: latest.ref_commit_sha || null,
      createdAt: latest.created_at ?? null,
      // Gitea has no close reason.
      stateReason: null,
    };
  }

  // ── Pull requests ───────────────────────────────────────────────

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<ForgePullRequest> {
    return this.requestJson<ForgePullRequest>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  }

  pullRequestsListPath(owner: string, repo: string, query: ListPullRequestsQuery): string {
    const params = new URLSearchParams({ state: query.state });
    // Gitea's sort vocabulary: recentupdate | leastupdate | oldest | (default = newest).
    const sort =
      query.sort === 'updated'
        ? query.direction === 'desc' ? 'recentupdate' : 'leastupdate'
        : query.direction === 'asc' ? 'oldest' : null;
    if (sort) params.set('sort', sort);
    params.set('limit', String(query.perPage));
    return `/repos/${owner}/${repo}/pulls?${params.toString()}`;
  }

  async listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
    const rows = await this.requestJson<Array<{ filename: string }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?limit=100`,
    );
    return rows.map((f) => f.filename);
  }

  // ── URLs ────────────────────────────────────────────────────────

  issueWebUrl(owner: string, repo: string, issueNumber: number): string {
    return `${this.endpoint.webBaseUrl}/${owner}/${repo}/issues/${issueNumber}`;
  }
}
