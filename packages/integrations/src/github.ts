/**
 * GitHub Issues integration for MindBlown.
 *
 * Bidirectional sync between MindBlown nodes and GitHub Issues.
 * Uses the GitHub REST API with native fetch() — no external dependencies.
 */

import type { Node, ExternalLink, Priority } from '@mindblown/core';

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
  pull_request?: { merged_at: string | null };
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
    throw new Error(`GitHub API ${res.status}: ${body}`);
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
  };
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

  // Build body from description
  const body = typeof node.description === 'string'
    ? node.description
    : node.description
      ? JSON.stringify(node.description)
      : '';

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

/**
 * Sync node changes to the linked GitHub Issue.
 * Updates title, body, state (open/closed), and labels. The issue's
 * GitHub milestone is left untouched (we no longer track it).
 */
export async function updateGitHubIssue(
  node: Node,
  externalLink: ExternalLink,
  token: string,
): Promise<GitHubIssue> {
  const parsed = parseExternalId(externalLink.externalId);
  if (!parsed) throw new Error(`Invalid externalId: ${externalLink.externalId}`);

  const { owner, repo, issueNumber } = parsed;

  // Determine state from node status/progress
  const isClosed = node.percentComplete === 100 || node.status === 'done';

  // Build labels from tags + priority
  const labels = [...node.tags];
  const priorityLabel = priorityToLabel(node.priority);
  if (priorityLabel) labels.push(priorityLabel);

  const body = typeof node.description === 'string'
    ? node.description
    : node.description
      ? JSON.stringify(node.description)
      : undefined;

  const patchBody: Record<string, unknown> = {
    title: node.text,
    body,
    state: isClosed ? 'closed' : 'open',
    labels,
  };

  const updatedIssue = await githubFetch<GitHubIssue>(
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    },
  );

  return updatedIssue;
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

  // pull_request events — check if PR references a linked issue
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    // Try to extract linked issue references from PR body
    // Common patterns: "Closes #42", "Fixes #42", "Resolves #42"
    const prBody = payload.pull_request.body ?? '';
    const prTitle = payload.pull_request.title ?? '';
    const text = `${prTitle} ${prBody}`;
    const repoName = payload.repository?.full_name ?? '';

    const issueRefs = extractIssueReferences(text);
    if (issueRefs.length > 0) {
      // Return update for the first referenced issue
      const issueNumber = issueRefs[0];
      return {
        action: 'pull_request.merged',
        externalId: `${repoName}#${issueNumber}`,
        nodeUpdates: {
          percentComplete: 100,
          status: 'done',
        },
      };
    }
  }

  return { action: `${event}.${payload.action}`, nodeUpdates: null, externalId: null };
}

/**
 * Extract issue number references from text.
 * Matches: Closes #42, Fixes #42, Resolves #42 (case-insensitive)
 */
function extractIssueReferences(text: string): number[] {
  const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const refs: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    refs.push(parseInt(match[1], 10));
  }
  return refs;
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
}

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
  const perPage = 100;
  const state = options?.includeAll ? 'all' : 'open';

  // Paginate through issues
  while (true) {
    const batch = await githubFetch<GitHubIssue[]>(
      `/repos/${repoOwner}/${repoName}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=created&direction=asc`,
      token,
    );

    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    const realIssues = batch.filter((i) => !i.pull_request);
    issues.push(...realIssues);

    if (batch.length < perPage) break;
    page++;

    // Safety valve — don't import more than 1000 issues at once
    if (issues.length >= 1000) break;
  }

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
 * - Pagination is bounded to 1000 issues per call to avoid runaway scans.
 */
export async function fetchChangedIssues(
  repoOwner: string,
  repoName: string,
  token: string,
  since: string | null | undefined,
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100;

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
    issues.push(...batch.filter((i) => !i.pull_request));

    if (batch.length < perPage) break;
    page++;
    if (issues.length >= 1000) break;
  }

  return issues;
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
