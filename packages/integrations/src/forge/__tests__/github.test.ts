import { describe, expect, it } from 'vitest';
import { GitHubForge, GITHUB_ENDPOINT, issueWebUrl } from '../github.js';
import { createForgeClient, resolveForgeEndpoint } from '../index.js';
import { ForgeApiError } from '../types.js';
import { githubFetchPage, paginateGitHub, GitHubApiError } from '../../github.js';
import { describeForgeContract, fakeTransport } from './forge-contract.js';

// ── Wire fixtures: GitHub's own REST shapes ──────────────────────

const ghIssue = {
  id: 1001,
  node_id: 'I_abc',
  number: 42,
  title: 'Contract issue',
  body: 'Body text',
  state: 'open',
  state_reason: null,
  labels: [
    { id: 1, name: 'bug', color: 'd73a4a' },
    { id: 2, name: 'priority:P1', color: 'ffffff' },
  ],
  assignees: [{ login: 'octocat', id: 7, avatar_url: 'https://avatars.githubusercontent.com/u/7' }],
  milestone: {
    id: 55,
    number: 3,
    title: 'V1: 2. Sync',
    description: null,
    state: 'open',
    due_on: '2026-10-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
  },
  html_url: 'https://forge.example/o/r/issues/42',
  created_at: '2026-09-02T10:00:00Z',
  updated_at: '2026-09-03T10:00:00Z',
  closed_at: null,
};

const ghPr = {
  number: 77,
  title: 'Fix the thing',
  body: 'Closes #42',
  state: 'closed',
  html_url: 'https://forge.example/o/r/pull/77',
  merged: true,
  merged_at: '2026-09-04T12:00:00Z',
  created_at: '2026-09-04T09:00:00Z',
  updated_at: '2026-09-04T12:00:00Z',
  base: { ref: 'master', sha: 'abc' },
  head: { ref: 'fix/thing', sha: 'def' },
};

const ghPrFiles = [
  { filename: 'packages/a.ts', status: 'modified', additions: 1, deletions: 1 },
  { filename: 'packages/b.ts', status: 'added', additions: 10, deletions: 0 },
];

describeForgeContract({
  name: 'GitHubForge',
  create: (fetchImpl) => new GitHubForge({ token: 't_contract', fetchImpl }),
  wire: { issue: ghIssue, pullRequest: ghPr, pullRequestFiles: ghPrFiles },
  expectedIssueWebUrl: 'https://github.com/o/r/issues/42',
});

// ── GitHub-specific wire details ─────────────────────────────────

describe('GitHubForge wire format', () => {
  it('sends the GitHub headers on every request', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 'ghp_x', fetchImpl: t.fetchImpl });
    t.respond({ status: 200, body: ghIssue });
    await forge.request('/repos/o/r/issues/42');
    expect(t.calls[0].url).toBe('https://api.github.com/repos/o/r/issues/42');
    expect(t.calls[0].headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ghp_x',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    });
  });

  it('adds labels with POST {labels:[...]} and removes with DELETE /labels/{name}', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({ status: 200, body: [] }, { status: 200, body: [] });
    await forge.addIssueLabels('o', 'r', 7, ['triage:placed']);
    await forge.removeIssueLabel('o', 'r', 7, 'triage:skipped');
    expect(t.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/o/r/issues/7/labels',
      body: JSON.stringify({ labels: ['triage:placed'] }),
    });
    expect(t.calls[1]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.github.com/repos/o/r/issues/7/labels/triage%3Askipped',
      body: undefined,
    });
  });

  it('builds the closed-PR listing path the throughput crawl used', () => {
    const forge = new GitHubForge({ token: 't' });
    expect(forge.pullRequestsListPath('o', 'r', { state: 'closed', sort: 'updated', direction: 'desc', perPage: 100 })).toBe(
      '/repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100',
    );
  });

  it('fetches PR files with per_page=100', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({ status: 200, body: ghPrFiles });
    await forge.listPullRequestFiles('o', 'r', 77);
    expect(t.calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/77/files?per_page=100');
  });

  it('keeps the historical error message, name and class identity', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({ status: 401, body: 'Bad credentials' });
    const err = (await forge.requestJson('/repos/o/r/issues/1').catch((e: unknown) => e)) as ForgeApiError;
    expect(err.message).toBe('GitHub API 401: Bad credentials');
    expect(err.name).toBe('GitHubApiError');
    expect(err.kind).toBe('github');
    expect(err).toBeInstanceOf(GitHubApiError);
  });

  it('honours a custom base URL (GitHub Enterprise Server) and strips trailing slashes', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({
      token: 't',
      apiBaseUrl: 'https://ghe.example/api/v3/',
      webBaseUrl: 'https://ghe.example/',
      fetchImpl: t.fetchImpl,
    });
    t.respond({ status: 200, body: ghIssue });
    await forge.request('/repos/o/r/issues/42');
    expect(t.calls[0].url).toBe('https://ghe.example/api/v3/repos/o/r/issues/42');
    expect(forge.issueWebUrl('o', 'r', 42)).toBe('https://ghe.example/o/r/issues/42');
    expect(issueWebUrl(forge.endpoint, 'o/r', 42)).toBe('https://ghe.example/o/r/issues/42');
  });
});

// ── The sync layer's transport helpers ride on the client ────────

describe('githubFetchPage / paginateGitHub over a ForgeClient', () => {
  it('githubFetchPage reads the Link header and the body through the client', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({
      status: 200,
      body: [ghIssue],
      headers: { link: '<https://api.github.com/repos/o/r/issues?after=x>; rel="next"' },
    });
    const page = await githubFetchPage<unknown[]>('/repos/o/r/issues?per_page=100', forge);
    expect(page.data).toHaveLength(1);
    expect(page.nextUrl).toBe('https://api.github.com/repos/o/r/issues?after=x');
    expect(t.calls[0].headers.Authorization).toBe('Bearer t');
  });

  it('githubFetchPage throws GitHubApiError (= ForgeApiError) on a non-2xx', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({ status: 403, body: '{"message":"rate limited"}' });
    const err = await githubFetchPage('/repos/o/r/issues/1', forge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as ForgeApiError).status).toBe(403);
  });

  it('paginateGitHub follows next links on the client base and stays on its origin', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({
      token: 't',
      apiBaseUrl: 'https://ghe.example/api/v3',
      fetchImpl: t.fetchImpl,
    });
    t.respond(
      { status: 200, body: [1], headers: { link: '<https://ghe.example/api/v3/repos/o/r/issues?after=a>; rel="next"' } },
      { status: 200, body: [2] },
    );
    const seen: number[] = [];
    const walk = await paginateGitHub<number>('/repos/o/r/issues', forge, {
      maxPages: 10,
      onPage: (batch) => {
        seen.push(...batch);
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(walk).toEqual({ pages: 2, truncated: false });
    expect(t.calls[1].url).toBe('https://ghe.example/api/v3/repos/o/r/issues?after=a');
  });

  it('paginateGitHub refuses a next link that leaves the client origin', async () => {
    const t = fakeTransport();
    const forge = new GitHubForge({ token: 't', fetchImpl: t.fetchImpl });
    t.respond({ status: 200, body: [1], headers: { link: '<https://evil.example/x>; rel="next"' } });
    await expect(
      paginateGitHub<number>('/repos/o/r/issues', forge, { maxPages: 10, onPage: () => undefined }),
    ).rejects.toThrow(/different origin/);
    expect(t.calls).toHaveLength(1);
  });
});

// ── Factory / defaults ───────────────────────────────────────────

describe('createForgeClient', () => {
  it('a connection with no kind and no URLs means github.com (pre-#367 rows)', () => {
    expect(resolveForgeEndpoint({})).toEqual(GITHUB_ENDPOINT);
    const forge = createForgeClient({ token: 't' });
    expect(forge).toBeInstanceOf(GitHubForge);
    expect(forge.endpoint).toEqual(GITHUB_ENDPOINT);
    expect(forge.token).toBe('t');
  });

  it('gitea without URLs is rejected before any network call', () => {
    expect(() => resolveForgeEndpoint({ kind: 'gitea' })).toThrow(/apiBaseUrl/);
  });

  it('gitea resolves to a GiteaForge on the instance URL (#368)', () => {
    const forge = createForgeClient({ kind: 'gitea', apiBaseUrl: 'https://git.example', token: 't' });
    expect(forge.endpoint).toEqual({ kind: 'gitea', apiBaseUrl: 'https://git.example/api/v1', webBaseUrl: 'https://git.example' });
    expect(forge).not.toBeInstanceOf(GitHubForge);
  });
});
