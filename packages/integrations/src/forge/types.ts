/**
 * Forge abstraction (#367).
 *
 * A "forge" is a code-hosting platform with issues, labels, milestones and
 * pull requests — GitHub today, Gitea/Forgejo next (#368). Everything in
 * MindBlown that talks to such a platform goes through a `ForgeClient`;
 * the client owns the base URLs, the auth header and the wire format, so
 * the sync logic above it (`../github.ts`) never sees a host name.
 *
 * Two layers live on the client:
 *   - a raw transport (`request`, `requestJson`) that the sync operations in
 *     `../github.ts` drive with GitHub-shaped paths — unchanged behaviour;
 *   - typed methods for the handful of calls the server used to make with a
 *     hand-rolled `fetch` (PR files/body, PR pages, label add/remove, issue
 *     create), which is where a non-GitHub forge normalises its payloads.
 *
 * The normalised shapes below are deliberately the GitHub REST shapes the
 * sync code already consumes.
 */

// ── Kinds and endpoints ───────────────────────────────────────────

export type ForgeKind = 'github' | 'gitea';

export const FORGE_KINDS: readonly ForgeKind[] = ['github', 'gitea'];

export function isForgeKind(value: unknown): value is ForgeKind {
  return typeof value === 'string' && (FORGE_KINDS as readonly string[]).includes(value);
}

/** Where a forge lives. `apiBaseUrl` has no trailing slash and, for Gitea, includes `/api/v1`. */
export interface ForgeEndpoint {
  kind: ForgeKind;
  apiBaseUrl: string;
  webBaseUrl: string;
}

/**
 * What an operator stores to reach a forge with a personal access token.
 * `apiBaseUrl` / `webBaseUrl` are optional — absent means the kind's
 * public default (api.github.com / github.com for `github`).
 */
export interface ForgeConnection {
  kind?: ForgeKind | null;
  apiBaseUrl?: string | null;
  webBaseUrl?: string | null;
  token: string;
}

// ── Normalised payloads ───────────────────────────────────────────

export interface ForgeMilestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  due_on: string | null;
  created_at: string;
}

export interface ForgeIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string; id: number }>;
  milestone: ForgeMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  /** ISO timestamp when the issue was closed; null for open issues. */
  closed_at?: string | null;
  /** Present when the "issue" is really a pull request (GitHub lists both on /issues). */
  pull_request?: { merged_at: string | null };
}

export interface ForgePullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  /**
   * Present on a single-PR fetch. GitHub's *list* endpoint omits it —
   * use `merged_at != null` when working from a page.
   */
  merged?: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  base: { ref: string };
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels: string[];
}

/** Fields the sync layer patches on an issue. Everything optional; only present keys are sent. */
export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  /** GitHub-only semantics; a forge without the concept ignores it. */
  state_reason?: 'completed' | 'not_planned' | 'reopened';
  /** Replaces the label set (names). */
  labels?: string[];
  /** A `MilestoneRef.ref` from `listMilestones`, or null to clear. */
  milestone?: number | null;
}

export interface IssuesListQuery {
  state: 'open' | 'closed' | 'all';
  perPage: number;
  sort: 'created' | 'updated';
  direction: 'asc' | 'desc';
  /** Only issues updated at or after this ISO timestamp. */
  since?: string | null;
}

/** A milestone as the forge addresses it in `updateIssue` — GitHub by `number`, Gitea by `id`. */
export interface MilestoneRef {
  ref: number;
  title: string;
  state: 'open' | 'closed';
}

export interface IssueCloseEvent {
  /** Who closed it — `mindblown-by-project-li[bot]` for our own closes. */
  actor: string | null;
  /**
   * The commit the forge attributes the close to. `null` whenever the close
   * came from an API call rather than from a commit landing on the
   * default branch — i.e. every close MindBlown itself performed.
   */
  commitId: string | null;
  createdAt: string | null;
  stateReason: 'completed' | 'not_planned' | null;
}

export interface ListPullRequestsQuery {
  state: 'open' | 'closed' | 'all';
  perPage: number;
  sort: 'created' | 'updated';
  direction: 'asc' | 'desc';
}

// ── Transport ─────────────────────────────────────────────────────

/**
 * The slice of a `fetch` `Response` the forge layer reads. `ok` is derived
 * from `status` when a transport double omits it; `headers` may be absent
 * on doubles (read as "no Link header").
 */
export interface ForgeResponse {
  status: number;
  ok?: boolean;
  headers?: { get(name: string): string | null } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** What the client sends to its transport. */
export interface ForgeRequestInit {
  method?: string;
  /** Already-serialised body. */
  body?: string;
  /** Extra headers, merged over the client's defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The subset of `fetch` a forge client needs. Tests and the label
 * writeback inject their own; production uses the global `fetch`.
 */
export type ForgeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ForgeResponse>;

/** A raw outcome for callers that branch on status codes (label writeback). */
export interface ForgeRawResponse {
  status: number;
  bodyText: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

// ── Errors ────────────────────────────────────────────────────────

/**
 * Thrown by every forge request that hits a non-2xx response.
 *
 * Callers that need to react to specific HTTP statuses (auth expiry, rate
 * limit, etc.) branch on `err instanceof ForgeApiError` (historically
 * `GitHubApiError` — the same class) and read `err.status`. The message
 * keeps the `GitHub API <status>: <body>` format for GitHub so existing
 * log greps and tests keep working; `.body` holds the raw body for logs.
 */
export class ForgeApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly kind: ForgeKind;
  constructor(status: number, body: string, kind: ForgeKind = 'github') {
    super(`${forgeLabel(kind)} API ${status}: ${body}`);
    // Historical name for GitHub (log greps, tests); honest for other forges.
    this.name = kind === 'github' ? 'GitHubApiError' : 'ForgeApiError';
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

export function forgeLabel(kind: ForgeKind): string {
  return kind === 'gitea' ? 'Gitea' : 'GitHub';
}

// ── The client ────────────────────────────────────────────────────

export interface ForgeClient {
  readonly endpoint: ForgeEndpoint;
  readonly token: string;

  /**
   * Raw request: resolves `pathOrUrl` against `apiBaseUrl` (absolute URLs
   * pass through), adds auth + API headers, returns the fetch-like
   * response. Never throws on HTTP status.
   */
  request(pathOrUrl: string, init?: ForgeRequestInit): Promise<ForgeResponse>;

  /**
   * JSON request: throws `ForgeApiError` on non-2xx, resolves `undefined`
   * on 204, else the parsed body.
   */
  requestJson<T>(pathOrUrl: string, init?: { method?: string; body?: unknown }, opts?: RequestOptions): Promise<T>;

  // Typed calls — everything whose wire shape differs between forges.
  /** Bring a raw issue body (list page, single fetch, webhook) onto `ForgeIssue`. Identity on GitHub. */
  normalizeIssue<T extends object>(raw: T): T & ForgeIssue;
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<ForgeIssue>;
  updateIssue(owner: string, repo: string, issueNumber: number, patch: UpdateIssueInput): Promise<ForgeIssue>;
  /** The first-page path for an issue listing — walked with `paginateGitHub` (Link header). */
  issuesListPath(owner: string, repo: string, query: IssuesListQuery): string;
  /** Raw status because the writeback treats 404/422 as no-ops. */
  addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[], opts?: RequestOptions): Promise<ForgeRawResponse>;
  removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string, opts?: RequestOptions): Promise<ForgeRawResponse>;
  listMilestones(owner: string, repo: string): Promise<MilestoneRef[]>;
  /**
   * Numbers of the pull requests in the SAME repo that reference this
   * issue, oldest first (a mention is enough — callers re-check the PR
   * body for a closing keyword). Throws `GitHubScanTruncatedError` if the
   * scan would answer from a prefix.
   */
  listCrossReferencingPullRequests(owner: string, repo: string, issueNumber: number): Promise<number[]>;
  /** The most recent close of an issue, or null if never closed. Same truncation rule. */
  getLatestCloseEvent(owner: string, repo: string, issueNumber: number): Promise<IssueCloseEvent | null>;
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<ForgePullRequest>;
  /** The first-page path for a PR listing — walked with `paginateGitHub` (Link header). */
  pullRequestsListPath(owner: string, repo: string, query: ListPullRequestsQuery): string;
  /** Paths of the files a PR touches (first 100). */
  listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<string[]>;

  // URLs
  issueWebUrl(owner: string, repo: string, issueNumber: number): string;
}
