/**
 * A person's merge through MindBlown (pr_summary / merge_pr): the PR read,
 * its file stats, its checks, the repo's merge settings and the merge
 * itself, on both forges.
 */
import { describe, expect, it } from 'vitest';
import { GitHubForge } from '../github.js';
import { GiteaForge } from '../gitea.js';
import { ForgeApiError } from '../types.js';
import { checkRunCheck, commitStatusCheck, giteaMergeMethod, githubMergeMethod } from '../pullRequests.js';
import { fakeTransport } from './forge-contract.js';
import { giteaPullRequest, giteaPullRequestFiles } from './fixtures/gitea.js';

const rawPr = {
  number: 7,
  title: 'Dark mode',
  state: 'open',
  merged: false,
  draft: false,
  html_url: 'https://forge.example/o/r/pull/7',
  user: { login: 'fleet-bot' },
  base: { ref: 'main' },
  head: { ref: 'fleet/x', sha: 'abc123' },
  mergeable: true,
  additions: 40,
  deletions: 3,
  changed_files: 2,
  merge_commit_sha: null,
};

describe('GitHubForge — a person merges', () => {
  const make = () => {
    const t = fakeTransport();
    return { t, forge: new GitHubForge({ token: 'x', fetchImpl: t.fetchImpl }) };
  };

  it('reads the PR detail with head sha and diff stat', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: rawPr });
    const pr = await forge.getPullRequestDetail('o', 'r', 7);
    expect(t.calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(pr).toMatchObject({ number: 7, headSha: 'abc123', head: 'fleet/x', base: 'main', author: 'fleet-bot', mergeable: true, additions: 40, deletions: 3, changedFiles: 2, merged: false });
  });

  it('file stats carry +/-', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: [{ filename: 'a.ts', additions: 3, deletions: 1 }] });
    expect(await forge.listPullRequestFileStats('o', 'r', 7)).toEqual([{ path: 'a.ts', additions: 3, deletions: 1 }]);
    expect(t.calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7/files?per_page=100');
  });

  it('checks = check runs + commit statuses', async () => {
    const { t, forge } = make();
    t.respond(
      { status: 200, body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'u1' }, { name: 'lint', status: 'in_progress', conclusion: null }] } },
      { status: 200, body: { statuses: [{ context: 'ci/legacy', state: 'failure', target_url: 'u2' }] } },
    );
    expect(await forge.listCommitChecks('o', 'r', 'abc123')).toEqual([
      { name: 'test', state: 'success', url: 'u1' },
      { name: 'lint', state: 'pending', url: null },
      { name: 'ci/legacy', state: 'failure', url: 'u2' },
    ]);
  });

  it('an unreadable check API throws — never "no CI"', async () => {
    const { t, forge } = make();
    t.respond({ status: 403, body: { message: 'Resource not accessible' } }, { status: 200, body: { statuses: [] } });
    await expect(forge.listCommitChecks('o', 'r', 'abc')).rejects.toBeInstanceOf(ForgeApiError);
  });

  it('merge settings: default branch, squash unless the repo forbids it', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: { default_branch: 'main', allow_squash_merge: false, allow_merge_commit: true } });
    expect(await forge.getRepoMergeSettings('o', 'r')).toEqual({ defaultBranch: 'main', defaultMethod: 'merge' });
  });

  it('merges with PUT, pinned to the head sha', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: { merged: true, sha: 'm1' } });
    await forge.mergePullRequest('o', 'r', 7, { method: 'squash', headSha: 'abc123' });
    expect(t.calls[0].method).toBe('PUT');
    expect(t.calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7/merge');
    expect(JSON.parse(t.calls[0].body!)).toEqual({ merge_method: 'squash', sha: 'abc123' });
  });

  it('a moved head is a 409 ForgeApiError', async () => {
    const { t, forge } = make();
    t.respond({ status: 409, body: { message: 'Head branch was modified' } });
    await expect(forge.mergePullRequest('o', 'r', 7, { method: 'squash', headSha: 'old' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('GiteaForge — a person merges', () => {
  const make = () => {
    const t = fakeTransport();
    return { t, forge: new GiteaForge({ token: 'x', apiBaseUrl: 'https://git.example', fetchImpl: t.fetchImpl }) };
  };

  it('reads the captured PR (merged) through the same shape', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: giteaPullRequest });
    const pr = await forge.getPullRequestDetail('dan', 'r', 4);
    expect(pr).toMatchObject({ number: 4, merged: true, headSha: giteaPullRequest.head.sha, head: 'fix/task-two', base: 'main', author: 'dan' });
  });

  it('file stats use limit; null reads as empty', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: giteaPullRequestFiles }, { status: 200, body: null });
    const files = await forge.listPullRequestFileStats('dan', 'r', 4);
    expect(files.map((f) => f.path)).toEqual(['NOTES.md', 'packages/two.ts']);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/pulls/4/files?limit=100');
    expect(await forge.listPullRequestFileStats('dan', 'r', 4)).toEqual([]);
  });

  it('checks come from the combined status, Gitea says `status`', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: { state: 'pending', statuses: [{ context: 'ci / test', status: 'success', target_url: 'u' }, { context: 'ci / e2e', status: 'pending' }] } });
    expect(await forge.listCommitChecks('dan', 'r', 'abc')).toEqual([
      { name: 'ci / test', state: 'success', url: 'u' },
      { name: 'ci / e2e', state: 'pending', url: null },
    ]);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/commits/abc/status');
  });

  it('merge settings follow default_merge_style', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: { default_branch: 'main', default_merge_style: 'rebase' } });
    expect(await forge.getRepoMergeSettings('dan', 'r')).toEqual({ defaultBranch: 'main', defaultMethod: 'rebase' });
  });

  it('merges with POST Do + head_commit_id', async () => {
    const { t, forge } = make();
    t.respond({ status: 200, body: null });
    await forge.mergePullRequest('dan', 'r', 4, { method: 'merge', headSha: 'abc' });
    expect(t.calls[0].method).toBe('POST');
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/pulls/4/merge');
    expect(JSON.parse(t.calls[0].body!)).toEqual({ Do: 'merge', head_commit_id: 'abc' });
  });
});

describe('normalisers', () => {
  it('check runs: only success / neutral / skipped pass', () => {
    expect(checkRunCheck({ name: 'a', status: 'completed', conclusion: 'cancelled' }).state).toBe('failure');
    expect(checkRunCheck({ name: 'a', status: 'completed', conclusion: 'skipped' }).state).toBe('neutral');
    expect(checkRunCheck({ name: 'a', status: 'queued', conclusion: null }).state).toBe('pending');
  });
  it('commit statuses: error is a failure', () => {
    expect(commitStatusCheck({ context: 'c', state: 'error' }).state).toBe('failure');
    expect(commitStatusCheck({ context: 'c', status: 'warning' }).state).toBe('neutral');
  });
  it('default methods', () => {
    expect(githubMergeMethod({})).toBe('squash');
    expect(githubMergeMethod({ allow_squash_merge: false, allow_merge_commit: false })).toBe('rebase');
    expect(giteaMergeMethod('rebase-merge')).toBe('squash');
  });
});
