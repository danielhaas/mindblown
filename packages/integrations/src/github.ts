/**
 * GitHub Issues integration for MindBlown.
 *
 * Bidirectional sync between MindBlown nodes and GitHub Issues.
 * Uses the GitHub REST API with native fetch() — no external dependencies.
 */

import type { Node, ExternalLink, Priority } from '@mindblown/core';
import { proseMirrorToPlainText, issueCloseAction } from '@mindblown/core';

// ── Types ─────────────────────────────────────────────────────────

export interface GitHubMilestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  due_on: string | null;
  created_at: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string; id: number }>;
  milestone: GitHubMilestone | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  /** ISO timestamp when the issue was closed; null for open issues. */
  closed_at?: string | null;
  /**
   * Why the issue was closed. GitHub fills this with `completed` when a
   * close request omits `state_reason` — the silent default the
   * premature-close incident rode in on. Absent on older payloads.
   */
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
  pull_request?: { merged_at: string | null };
}

/** The `closed` entry from an issue's event log. */
export interface IssueCloseEvent {
  /** Who closed it — `mindblown-by-project-li[bot]` for our own closes. */
  actor: string | null;
  /**
   * The commit GitHub attributes the close to. `null` whenever the close
   * came from an API call rather than from a commit landing on the
   * default branch — i.e. every close MindBlown itself performed.
   */
  commitId: string | null;
  createdAt: string | null;
  stateReason: 'completed' | 'not_planned' | null;
}

export interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubIssue;
  pull_request?: {
    number: number;
    merged: boolean;
    html_url: string;
    body: string | null;
    title: string;
  };
  label?: { name: string };
  assignee?: { login: string; id: number };
  repository?: { full_name: string };
  sender?: { login: string };
}

export interface WebhookResult {
  action: string;
  nodeUpdates: Record<string, unknown> | null;
  externalId: string | null;
}

/** The priority label prefix we use on GitHub. */
const PRIORITY_PREFIX = 'priority:';

// ── Helpers ───────────────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

/**
 * Thrown by every `githubFetch` call that hits a non-2xx response from
 * the GitHub REST API.
 *
 * Callers that need to react to specific HTTP statuses (auth expiry, rate
 * limit, etc.) should branch on `err instanceof GitHubApiError` and read
 * `err.status` — the previous behaviour of grepping the `Error.message`
 * string for "GitHub API 401" was both fragile and a foot-gun once the
 * message format changed. The string body is still preserved on `.body`
 * for log lines.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`GitHub API ${status}: ${body}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

async function githubFetch<T>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GitHubApiError(res.status, body);
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;

  return res.json() as Promise<T>;
}

function priorityToLabel(priority: Priority | null): string | null {
  if (!priority) return null;
  return `${PRIORITY_PREFIX}${priority}`;
}

function labelToPriority(labels: string[]): Priority | null {
  for (const label of labels) {
    if (label.startsWith(PRIORITY_PREFIX)) {
      const val = label.slice(PRIORITY_PREFIX.length) as Priority;
      if (['P0', 'P1', 'P2', 'P3'].includes(val)) return val;
    }
  }
  return null;
}

function buildExternalId(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

function parseExternalId(externalId: string): { owner: string; repo: string; issueNumber: number } | null {
  const match = externalId.match(/^(.+?)\/(.+?)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: parseInt(match[3], 10) };
}

function buildExternalLink(
  owner: string,
  repo: string,
  issue: GitHubIssue,
): ExternalLink {
  return {
    provider: 'github',
    externalId: buildExternalId(owner, repo, issue.number),
    url: issue.html_url,
    syncEnabled: true,
    lastSyncedAt: new Date().toISOString(),
    state: issue.state,
  };
}

// ── Did the work actually land? ───────────────────────────────────

/** A pull request that claims to close a given issue. */
export interface ClosingPrRef {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  baseRef: string;
  url: string;
}

/** What a landing probe found for one issue. */
export interface IssueLandingProbe {
  /** Every PR in the same repo whose title/body carries a closing ref. */
  closingPrs: ClosingPrRef[];
  /** The repo's default branch at probe time. */
  defaultBranch: string;
  /** The first closing PR merged INTO the default branch, if any. */
  landed: ClosingPrRef | null;
  /** True while at least one closing PR is still open. */
  inFlight: boolean;
}

/** The repo's default branch — the only branch a merge counts as "shipped" on. */
export async function getRepoDefaultBranch(
  repoOwner: string,
  repoName: string,
  token: string,
): Promise<string> {
  const repo = await githubFetch<{ default_branch: string }>(
    `/repos/${repoOwner}/${repoName}`,
    token,
  );
  return repo.default_branch;
}

/**
 * How many cross-referencing PRs we're willing to resolve for one issue.
 * A long-lived ticket accumulates mentions; the ones that matter are its
 * own PRs, and 25 is far past any real case.
 */
const MAX_CLOSING_PR_LOOKUPS = 25;

/**
 * Every pull request in the SAME repo that claims to close `issueNumber`.
 *
 * Writing `Closes #N` in a PR body makes GitHub post a `cross-referenced`
 * timeline event on issue N, so the timeline is the reliable index of
 * "which PRs point here". A cross-reference alone is only a mention
 * though — a PR that merely links the ticket in prose shows up the same
 * way — so each candidate PR is fetched and re-checked with
 * `extractClosingIssueRefs`, the same parser the merge handler uses to
 * decide which issues a PR closes. One parser, one answer.
 *
 * Cross-repo references are dropped: a PR in another repo can't close
 * this issue through the mechanism we model.
 */
export async function findClosingPrsForIssue(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<ClosingPrRef[]> {
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

  const events = await githubFetch<TimelineEvent[]>(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/timeline?per_page=100`,
    token,
  );

  const fullName = `${repoOwner}/${repoName}`;
  const candidates: number[] = [];
  for (const ev of events ?? []) {
    if (ev.event !== 'cross-referenced') continue;
    const src = ev.source?.issue;
    if (!src?.pull_request) continue;
    if (src.repository?.full_name && src.repository.full_name !== fullName) continue;
    if (typeof src.number !== 'number') continue;
    if (candidates.includes(src.number)) continue;
    candidates.push(src.number);
    if (candidates.length >= MAX_CLOSING_PR_LOOKUPS) break;
  }

  const out: ClosingPrRef[] = [];
  for (const prNumber of candidates) {
    const pr = await githubFetch<{
      number: number;
      state: 'open' | 'closed';
      merged?: boolean;
      merged_at: string | null;
      merge_commit_sha: string | null;
      base: { ref: string };
      html_url: string;
      title: string | null;
      body: string | null;
    }>(`/repos/${repoOwner}/${repoName}/pulls/${prNumber}`, token);

    const refs = extractClosingIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`);
    if (!refs.includes(issueNumber)) continue;

    out.push({
      number: pr.number,
      state: pr.state,
      // `merged` is absent on some payload shapes; `merged_at` is the
      // field GitHub always sets, so it decides.
      merged: pr.merged === true || pr.merged_at != null,
      mergedAt: pr.merged_at,
      mergeCommitSha: pr.merge_commit_sha,
      baseRef: pr.base.ref,
      url: pr.html_url,
    });
  }
  return out;
}

/**
 * The MOST RECENT `closed` event on an issue, or null if it was never
 * closed.
 *
 * The audit run keys on `commitId`: GitHub sets it only when a commit
 * landing on the default branch performed the close. Every close made
 * through the API — MindBlown's included — leaves it `null`, which is
 * precisely the population the backfill has to re-verify.
 */
export async function getIssueCloseEvent(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<IssueCloseEvent | null> {
  interface RawEvent {
    event?: string;
    actor?: { login?: string } | null;
    commit_id?: string | null;
    created_at?: string;
    state_reason?: 'completed' | 'not_planned' | null;
  }

  const events = await githubFetch<RawEvent[]>(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/events?per_page=100`,
    token,
  );

  let latest: RawEvent | null = null;
  for (const ev of events ?? []) {
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

/**
 * Ask GitHub whether an issue's work has landed on the default branch.
 *
 * This is the evidence MindBlown does not hold locally. It is the whole
 * point of the fix: "no linked PR in our mirror" was being read as "no
 * PR exists", and a node marked done seconds after its PR opened closed
 * the issue as COMPLETED with `commit_id=null`.
 */
export async function probeIssueLanded(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<IssueLandingProbe> {
  const [defaultBranch, closingPrs] = await Promise.all([
    getRepoDefaultBranch(repoOwner, repoName, token),
    findClosingPrsForIssue(repoOwner, repoName, issueNumber, token),
  ]);

  const landed =
    closingPrs.find((p) => p.merged && p.baseRef === defaultBranch) ?? null;
  const inFlight = closingPrs.some((p) => p.state === 'open');

  return { closingPrs, defaultBranch, landed, inFlight };
}

// ── Outbound: MindBlown → GitHub ──────────────────────────────────

/**
 * Create a new GitHub Issue from a MindBlown node.
 * Returns the created issue and the ExternalLink to store on the node.
 */
export async function createGitHubIssue(
  node: Node,
  repoOwner: string,
  repoName: string,
  token: string,
): Promise<{ issue: GitHubIssue; externalLink: ExternalLink }> {
  // Build labels from tags + priority
  const labels = [...node.tags];
  const priorityLabel = priorityToLabel(node.priority);
  if (priorityLabel) labels.push(priorityLabel);

  // Render the ProseMirror description to plain text for the issue body.
  // (Used to JSON.stringify non-string descriptions — the root cause of
  // garbage issue bodies from create_github_issue_from_node.)
  const body = proseMirrorToPlainText(node.description);

  const issue = await githubFetch<GitHubIssue>(
    `/repos/${repoOwner}/${repoName}/issues`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: node.text,
        body: body || undefined,
        labels,
      }),
    },
  );

  return {
    issue,
    externalLink: buildExternalLink(repoOwner, repoName, issue),
  };
}

/** Why `updateGitHubIssue` left the issue's state untouched. */
export type IssueStateHoldReason =
  /** A linked PR in the mirror has not landed on the default branch. */
  | 'pr_not_landed'
  /** The landing probe found an open PR that claims to close this issue. */
  | 'pr_in_flight'
  /** The landing probe itself failed — we refuse to close on no evidence. */
  | 'probe_failed';

export interface UpdateIssueResult {
  issue: GitHubIssue;
  /** What we did to the issue's open/closed state. */
  stateAction: 'closed_completed' | 'reopened' | 'held';
  holdReason: IssueStateHoldReason | null;
  /**
   * Merge commit the probe turned up. The caller should persist this on
   * the `ExternalLink` (`mergeCommitSha`) so the next sync closes on
   * local evidence instead of paying for another probe.
   */
  mergeCommitSha: string | null;
  mergedPrNumber: number | null;
}

export interface UpdateIssueOptions {
  /**
   * Injection seam for the landing probe (tests, and callers that
   * already hold the answer). Defaults to the live
   * `probeIssueLanded`.
   */
  probe?: (
    owner: string,
    repo: string,
    issueNumber: number,
    token: string,
  ) => Promise<IssueLandingProbe>;
}

/**
 * Sync node changes to the linked GitHub Issue.
 * Updates title, body, state (open/closed), and labels. The issue's
 * GitHub milestone is left untouched (we no longer track it).
 *
 * ## Closing an issue needs evidence, not a done-flag
 *
 * "Done in MindBlown" is not "done in the repo". Coding agents mark the
 * node done when they OPEN the PR, so this sync used to close the linked
 * issue as `COMPLETED` — with `commit_id=null` — while the branch was
 * still open, and in several cases still red or never merged at all
 * (crm#7357: closed 6 s after its PR was created; crm#6305: 21 s;
 * crm#6085: the PR never merged and the work is still missing today).
 * A `CLOSED/COMPLETED` ticket with no merge commit ends the search.
 *
 * So the close direction now requires one of:
 *
 *   1. a merge commit recorded on the link (`mergeCommitSha`, written by
 *      the `pull_request.closed + merged=true` handler), or
 *   2. a mirror that survived as `state: 'merged'` on the default
 *      branch, or
 *   3. a live probe against GitHub finding no PR in flight for the
 *      issue — the "no PR at all" case (assessments, ops tasks) where
 *      MindBlown is the only mechanism that can ever close it.
 *
 * A probe that finds an OPEN closing PR holds; a probe that FAILS holds
 * too — refusing to close on absent evidence is the whole point, and a
 * later sync (or the catchup) retries. A closed-unmerged PR alone does
 * not hold here: that case is already decided by the mirror gate above
 * (`prBlocksIssueClose`), and holding on it again would deadlock a node
 * whose work shipped by some other route.
 *
 * The `state_reason` is now always explicit. GitHub defaults an
 * unqualified `state: 'closed'` to `COMPLETED`, which is exactly the
 * value the incident is about — never let it be implicit.
 *
 * Only the CLOSING direction is gated. A not-done node always pushes
 * `state: 'open'`: the node saying "work is open" must be able to reopen
 * a prematurely-closed issue, otherwise a manual node reset can never
 * repair one. When we hold, we OMIT `state` rather than forcing 'open':
 * a human who deliberately closed the issue should not have it reopened
 * under them while the node stays done.
 */
export async function updateGitHubIssue(
  node: Node,
  externalLink: ExternalLink,
  token: string,
  options: UpdateIssueOptions = {},
): Promise<UpdateIssueResult> {
  const parsed = parseExternalId(externalLink.externalId);
  if (!parsed) throw new Error(`Invalid externalId: ${externalLink.externalId}`);

  const { owner, repo, issueNumber } = parsed;

  // Determine state from node status/progress
  const looksDone = node.percentComplete === 100 || node.status === 'done';

  let stateAction: UpdateIssueResult['stateAction'] = 'held';
  let holdReason: IssueStateHoldReason | null = null;
  let mergeCommitSha: string | null = null;
  let mergedPrNumber: number | null = null;

  // Build labels from tags + priority
  const labels = [...node.tags];
  const priorityLabel = priorityToLabel(node.priority);
  if (priorityLabel) labels.push(priorityLabel);

  const renderedBody = proseMirrorToPlainText(node.description);
  const body = renderedBody || undefined;

  const patchBody: Record<string, unknown> = {
    title: node.text,
    body,
    labels,
  };

  if (!looksDone) {
    patchBody.state = 'open';
    stateAction = 'reopened';
  } else {
    const action = issueCloseAction(node.linkedPr, externalLink, node.completedAt);
    if (action.kind === 'close') {
      patchBody.state = 'closed';
      patchBody.state_reason = action.stateReason;
      stateAction = 'closed_completed';
      mergeCommitSha = externalLink.mergeCommitSha ?? null;
      mergedPrNumber = externalLink.mergedPrNumber ?? null;
    } else if (action.kind === 'hold') {
      holdReason = action.because;
    } else {
      const probe = options.probe ?? probeIssueLanded;
      try {
        const result = await probe(owner, repo, issueNumber, token);
        if (result.landed) {
          patchBody.state = 'closed';
          patchBody.state_reason = 'completed';
          stateAction = 'closed_completed';
          mergeCommitSha = result.landed.mergeCommitSha;
          mergedPrNumber = result.landed.number;
        } else if (result.inFlight) {
          holdReason = 'pr_in_flight';
        } else {
          patchBody.state = 'closed';
          patchBody.state_reason = 'completed';
          stateAction = 'closed_completed';
        }
      } catch {
        holdReason = 'probe_failed';
      }
    }
  }

  const updatedIssue = await githubFetch<GitHubIssue>(
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    },
  );

  return { issue: updatedIssue, stateAction, holdReason, mergeCommitSha, mergedPrNumber };
}

/**
 * Reopen a GitHub issue that was closed on a promise that did not hold —
 * the PR referencing it died unmerged, or the closed-issue audit found
 * `COMPLETED` with no merge commit behind it.
 *
 * `state_reason: 'reopened'` is explicit for the same reason the close
 * path sets its reason explicitly: the field is the thing this whole fix
 * is about, and an implicit value is how the bug got in.
 */
export async function reopenGitHubIssue(
  externalLink: Pick<ExternalLink, 'externalId'>,
  token: string,
): Promise<GitHubIssue> {
  const parsed = parseExternalId(externalLink.externalId);
  if (!parsed) throw new Error(`Invalid externalId: ${externalLink.externalId}`);

  const { owner, repo, issueNumber } = parsed;

  return githubFetch<GitHubIssue>(
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open', state_reason: 'reopened' }),
    },
  );
}

/**
 * Close the linked GitHub Issue.
 *
 * reason = 'completed' (default) — "done", triggered by the node reaching
 *   100% or status=done. GitHub displays these with a purple check.
 * reason = 'not_planned' — the node was deleted / abandoned in MindBlown.
 *   GitHub displays these with a grey circle. Use this when the work is
 *   dropped rather than finished.
 */
export async function closeGitHubIssue(
  externalLink: ExternalLink,
  token: string,
  reason: 'completed' | 'not_planned' = 'completed',
): Promise<GitHubIssue> {
  const parsed = parseExternalId(externalLink.externalId);
  if (!parsed) throw new Error(`Invalid externalId: ${externalLink.externalId}`);

  const { owner, repo, issueNumber } = parsed;

  return githubFetch<GitHubIssue>(
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'closed',
        state_reason: reason,
      }),
    },
  );
}

// ── Inbound: GitHub → MindBlown ───────────────────────────────────

/**
 * Process a GitHub webhook event and return the node updates to apply.
 *
 * The caller is responsible for finding the node by externalId and
 * applying the returned updates via the node DB layer.
 */
export function processWebhook(
  payload: GitHubWebhookPayload,
  event: string,
): WebhookResult {
  // issues events
  if (event === 'issues' && payload.issue) {
    const repoName = payload.repository?.full_name ?? '';
    const externalId = `${repoName}#${payload.issue.number}`;

    switch (payload.action) {
      case 'closed':
        return {
          action: 'issues.closed',
          externalId,
          nodeUpdates: {
            percentComplete: 100,
            status: 'done',
          },
        };

      case 'reopened':
        return {
          action: 'issues.reopened',
          externalId,
          nodeUpdates: {
            percentComplete: 0,
            status: 'in_progress',
          },
        };

      case 'edited':
        return {
          action: 'issues.edited',
          externalId,
          nodeUpdates: {
            text: payload.issue!.title,
            description: payload.issue!.body,
          },
        };

      case 'assigned':
        if (payload.assignee) {
          return {
            action: 'issues.assigned',
            externalId,
            nodeUpdates: {
              // We return the full assignee list from the issue
              assigneeIds: payload.issue.assignees.map((a) => a.login),
            },
          };
        }
        break;

      case 'unassigned':
        return {
          action: 'issues.unassigned',
          externalId,
          nodeUpdates: {
            assigneeIds: payload.issue.assignees.map((a) => a.login),
          },
        };

      case 'labeled':
        return {
          action: 'issues.labeled',
          externalId,
          nodeUpdates: {
            tags: payload.issue.labels
              .map((l) => l.name)
              .filter((name) => !name.startsWith(PRIORITY_PREFIX)),
            priority: labelToPriority(payload.issue.labels.map((l) => l.name)),
          },
        };

      case 'unlabeled':
        return {
          action: 'issues.unlabeled',
          externalId,
          nodeUpdates: {
            tags: payload.issue.labels
              .map((l) => l.name)
              .filter((name) => !name.startsWith(PRIORITY_PREFIX)),
            priority: labelToPriority(payload.issue.labels.map((l) => l.name)),
          },
        };

      default:
        break;
    }
  }

  // NOTE: the legacy pull_request → done branch lived here. Removed
  // 2026-06-11 because the canonical handler in
  // @mindblown/server (routes/integrations.ts, around the
  // `pull_request: closed + merged=true` block) is a strict superset:
  //   - iterates ALL `Closes #N` refs, not just the first
  //   - is idempotent on replay
  //   - gates on the PR's base branch matching the repo's default branch,
  //     mirroring GitHub's own auto-close behaviour (#199)
  // The legacy single-ref + branch-agnostic version here was reachable
  // via the `processWebhook` fall-through after the canonical handler
  // skipped on the default-branch gate, which caused V1-hotfix PRs
  // (base=release/v1) to still transition their linked nodes to done —
  // exactly the bug #199 was meant to fix.

  return { action: `${event}.${payload.action}`, nodeUpdates: null, externalId: null };
}

/**
 * Extract closing-issue references from PR body/title text.
 * Matches the GitHub auto-close keywords: Closes #42, Fixes #42, Resolves #42
 * (case-insensitive; covers `close`/`closes`/`closed`/`fix`/`fixes`/`fixed`/
 * `resolve`/`resolves`/`resolved`). De-duplicates so the same issue isn't
 * processed twice when both PR title and body reference it.
 *
 * Exported for the webhook handler in @mindblown/server (#152) — needs to
 * iterate ALL refs, not just the first one returned by processWebhook.
 */
export function extractClosingIssueRefs(text: string): number[] {
  // \b so "disclose #5" doesn't read as "close #5".
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  const refs = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    refs.add(parseInt(match[1], 10));
  }
  return [...refs];
}

// ── Label helpers ────────────────────────────────────────────────

/**
 * Strip version prefixes from labels like "V1: 1a. Kernsystem MVP" → "Kernsystem MVP".
 * Handles patterns: "V1: 3. Foo", "V2: 10. Bar", "V1: 1b. Baz"
 */
function stripVersionPrefix(label: string): string {
  return label.replace(/^V\d+:\s*\d+[a-z]?\.\s*/i, '');
}

/**
 * Extract the version prefix from a milestone title.
 * "V1: 1a. Kernsystem MVP" → "V1"
 * "V2: 10. Externe Integrationen" → "V2"
 * "Something else" → null
 */
export function extractVersionFromMilestone(title: string): string | null {
  const match = title.match(/^(V\d+)/i);
  return match ? match[1] : null;
}

// ── Import ────────────────────────────────────────────────────────

export interface ImportedIssue {
  issue: GitHubIssue;
  externalLink: ExternalLink;
  /** Functional group: derived from milestone (version prefix stripped), falling back to first label. */
  groupLabel: string | null;
  /** GitHub milestone title, if the issue belongs to one. */
  milestoneTitle: string | null;
  /**
   * Parent issue number from the same repo, if a hierarchy was detected.
   * See parseParentRelationships for the patterns that count.
   */
  parentNumber: number | null;
}

/**
 * Infer a parent-issue number for each issue by scanning bodies for the two
 * conventions teams actually use to express an "epic → task" hierarchy in
 * GitHub:
 *
 * 1. **Task-list children.** An epic issue lists its children as markdown
 *    checkboxes: `- [ ] #42`. Each referenced issue gets that epic as parent.
 * 2. **Explicit parent declaration.** A child issue starts its body with
 *    `Parent: #5`, `Epic: #5`, `Sub-issue of #5`, or `Part of #5`.
 *
 * Only edges where both endpoints are in the import batch survive — we can't
 * link to an issue we didn't fetch. Cycles are broken by dropping the closing
 * edge. First-detected parent wins for any given child.
 */
export function parseParentRelationships(issues: GitHubIssue[]): Map<number, number> {
  const inBatch = new Set(issues.map((i) => i.number));
  const parentOf = new Map<number, number>();

  // Pass 1 — task lists in epic bodies.
  // `- [ ] #42` or `- [x] owner/repo#42`. Same-repo cross-references only;
  // we deliberately ignore cross-repo (we can't link to nodes outside this map).
  const taskListRe = /^\s*[-*]\s+\[[ xX]\]\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gm;
  for (const issue of issues) {
    const body = issue.body ?? '';
    let m: RegExpExecArray | null;
    const re = new RegExp(taskListRe.source, taskListRe.flags);
    while ((m = re.exec(body)) !== null) {
      const childNum = Number.parseInt(m[1], 10);
      if (childNum === issue.number) continue;
      if (!inBatch.has(childNum)) continue;
      if (parentOf.has(childNum)) continue;
      parentOf.set(childNum, issue.number);
    }
  }

  // Pass 2 — explicit parent declarations near the top of the body.
  // Capped at ~500 chars to avoid matching the same phrase buried in
  // long discussion or a closing checklist. Word boundary stops "parents"
  // (or longer words) from being matched as "parent".
  const parentRe = /(?:^|\n)\s*(?:parent|epic|sub-?issue\s+of|part\s+of)\b[:\s]*#(\d+)/i;
  for (const issue of issues) {
    if (parentOf.has(issue.number)) continue;
    const head = (issue.body ?? '').slice(0, 500);
    const m = parentRe.exec(head);
    if (!m) continue;
    const parentNum = Number.parseInt(m[1], 10);
    if (parentNum === issue.number) continue;
    if (!inBatch.has(parentNum)) continue;
    parentOf.set(issue.number, parentNum);
  }

  // Pass 3 — break cycles. Walking parent→...→ancestor from each child must
  // terminate; if we see the same node twice in a chain, drop the edge that
  // closes the cycle so the rest of the chain can still be honored.
  const settled = new Set<number>();
  for (const start of [...parentOf.keys()]) {
    if (settled.has(start)) continue;
    const onPath = new Set<number>();
    let cur: number | undefined = start;
    while (cur !== undefined && !settled.has(cur)) {
      if (onPath.has(cur)) {
        parentOf.delete(cur);
        break;
      }
      onPath.add(cur);
      cur = parentOf.get(cur);
    }
    for (const n of onPath) settled.add(n);
  }

  return parentOf;
}

/**
 * Runaway backstop shared by BOTH pagination loops in this module
 * (`importGitHubIssues` and `fetchChangedIssues`): stop after this many
 * fetched items (raw, PRs included — that's what bounds API calls) and
 * warn that the result is truncated. It exists to stop a genuine
 * runaway, not to bound normal repos — the value is far above any real
 * repo here (≈ MAX/100 API calls when it trips). Truncating silently is
 * what it must never do: the earlier 1000er valve made every "all
 * issues" diff blind to most of an 8900-issue repo.
 */
const MAX_FETCHED_ISSUES = 50_000;

/**
 * Fetch issues from a GitHub repo and prepare them for import as MindBlown nodes.
 *
 * Issues are grouped by **functional label** (version prefixes like "V1: 2." are stripped).
 * GitHub milestones are returned separately so the caller can create cycles from them.
 *
 * @param options.includeAll - If true, fetch all issues (open + closed). Default: open only.
 */
export async function importGitHubIssues(
  repoOwner: string,
  repoName: string,
  token: string,
  options?: { includeAll?: boolean },
): Promise<ImportedIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  let fetched = 0;
  const perPage = 100;
  const state = options?.includeAll ? 'all' : 'open';

  // Paginate through issues
  while (true) {
    const batch = await githubFetch<GitHubIssue[]>(
      `/repos/${repoOwner}/${repoName}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=created&direction=asc`,
      token,
    );
    fetched += batch.length;

    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    const realIssues = batch.filter((i) => !i.pull_request);
    issues.push(...realIssues);

    if (batch.length < perPage) break;
    page++;

    if (fetched >= MAX_FETCHED_ISSUES) {
      console.warn(
        `[github-import] ${repoOwner}/${repoName}: hit the ${MAX_FETCHED_ISSUES}-item fetch backstop — result is TRUNCATED, downstream diffs will miss issues`,
      );
      break;
    }
  }

  const parentOf = parseParentRelationships(issues);

  return issues.map((issue) => {
    // Prefer milestone's functional part for grouping (e.g. "V1: 3. Erweiterte Funktionen" → "Erweiterte Funktionen")
    // Fall back to first non-priority label if no milestone
    let groupLabel: string | null = null;
    if (issue.milestone) {
      groupLabel = stripVersionPrefix(issue.milestone.title);
      // If stripping didn't change anything (no version prefix), use as-is
    }
    if (!groupLabel) {
      const rawLabel = issue.labels
        .map((l) => l.name)
        .find((name) => !name.startsWith(PRIORITY_PREFIX) && !['bug', 'enhancement', 'documentation', 'question', 'help wanted', 'good first issue', 'wontfix', 'duplicate', 'invalid'].includes(name.toLowerCase()));
      groupLabel = rawLabel ?? null;
    }

    return {
      issue,
      externalLink: buildExternalLink(repoOwner, repoName, issue),
      groupLabel,
      milestoneTitle: issue.milestone?.title ?? null,
      parentNumber: parentOf.get(issue.number) ?? null,
    };
  });
}

/**
 * Fetch issues that have been updated since a given timestamp.
 *
 * Used by the reconciliation/catch-up sync to recover from missed webhook
 * deliveries (server downtime, signature mismatches, etc.). Returns raw
 * `GitHubIssue` objects — caller decides how to map state to nodes.
 *
 * - `since` is an ISO 8601 timestamp; null/undefined fetches everything.
 *   GitHub filters on `updated_at >= since`, which catches state changes,
 *   edits, label changes, and assignments — i.e. the same surface webhooks
 *   cover.
 * - PRs are filtered out (the issues endpoint returns both).
 * - Pagination is bounded by the shared `MAX_FETCHED_ISSUES` backstop;
 *   when it trips, `truncated` is true and the NEWEST-updated tail is
 *   missing (sort is updated-asc). Callers must not treat a truncated
 *   result as the complete set — the catchup uses it to resume its
 *   cursor instead of skipping the tail, the rollup refuses to compute
 *   sibling counts from it.
 */
export interface ChangedIssuesResult {
  issues: GitHubIssue[];
  /** True when the fetch stopped at MAX_FETCHED_ISSUES — the tail is missing. */
  truncated: boolean;
}

export async function fetchChangedIssues(
  repoOwner: string,
  repoName: string,
  token: string,
  since: string | null | undefined,
): Promise<ChangedIssuesResult> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  let fetched = 0;
  const perPage = 100;
  let truncated = false;

  while (true) {
    const params = new URLSearchParams({
      state: 'all',
      per_page: String(perPage),
      page: String(page),
      sort: 'updated',
      direction: 'asc',
    });
    if (since) params.set('since', since);

    const batch = await githubFetch<GitHubIssue[]>(
      `/repos/${repoOwner}/${repoName}/issues?${params.toString()}`,
      token,
    );
    fetched += batch.length;
    issues.push(...batch.filter((i) => !i.pull_request));

    if (batch.length < perPage) break;
    page++;
    if (fetched >= MAX_FETCHED_ISSUES) {
      truncated = true;
      console.warn(
        `[github-catchup-fetch] ${repoOwner}/${repoName}: hit the ${MAX_FETCHED_ISSUES}-item fetch backstop — result is TRUNCATED (newest-updated tail missing)`,
      );
      break;
    }
  }

  return { issues, truncated };
}

/**
 * Fetch a single GitHub Issue by number.
 */
export async function getGitHubIssue(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<GitHubIssue> {
  return githubFetch<GitHubIssue>(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}`,
    token,
  );
}

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 * Returns true if the signature is valid.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  // Use Node.js crypto via dynamic import to keep this file
  // free of Node.js-specific imports at the top level
  const { createHmac } = await import('node:crypto');

  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Constant-time comparison
  if (expected.length !== signature.length) return false;

  const { timingSafeEqual } = await import('node:crypto');
  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}
