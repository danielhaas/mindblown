import { describe, expect, it } from 'vitest';
import { GiteaForge, giteaEndpoint, normalizeGiteaIssue, normalizeGiteaWebhookAction } from '../gitea.js';
import { readWebhookHeaders, verifyWebhookSignature } from '../webhook.js';
import { GitHubScanTruncatedError } from '../pagination.js';
import { findClosingPrsForIssue, getIssueCloseEvent, importGitHubIssues, fetchChangedIssues, setGitHubIssueMilestone } from '../../github.js';
import { describeForgeContract, fakeTransport, EXPECTED_ISSUE_MATCH } from './forge-contract.js';
import {
  giteaIssue,
  giteaLabels,
  giteaMilestones,
  giteaPullRequest,
  giteaPullRequestFiles,
  giteaTimelineIssue3,
  giteaWebhookIssuesClosedByMerge,
  giteaWebhookIssuesEdited,
  giteaWebhookIssuesLabelUpdated,
  giteaWebhookIssuesOpened,
  giteaWebhookPullRequestClosed,
} from './fixtures/gitea.js';

const INSTANCE = 'https://git.example';

function forgeWith(t: ReturnType<typeof fakeTransport>): GiteaForge {
  return new GiteaForge({ token: 'gt_x', apiBaseUrl: INSTANCE, fetchImpl: t.fetchImpl });
}

// ── Contract: Gitea wire shapes, carried over from the live capture ─

/** The captured issue re-keyed onto the contract's expected values, keeping Gitea's quirks (null assignees, id-only milestone). */
const contractIssue = {
  ...giteaIssue,
  id: 1001,
  number: 42,
  title: 'Contract issue',
  body: 'Body text',
  assignees: [{ id: 7, login: 'octocat' }],
  milestone: { ...giteaIssue.milestone, id: 55, title: 'V1: 2. Sync', description: null, due_on: '2026-10-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
  html_url: 'https://forge.example/o/r/issues/42',
  created_at: '2026-09-02T10:00:00Z',
  updated_at: '2026-09-03T10:00:00Z',
  labels: [
    { ...giteaIssue.labels[0], name: 'bug' },
    { ...giteaIssue.labels[1], name: 'priority:P1' },
  ],
};

const contractPr = {
  ...giteaPullRequest,
  number: 77,
  title: 'Fix the thing',
  body: 'Closes #42',
  html_url: 'https://forge.example/o/r/pull/77',
  merged_at: '2026-09-04T12:00:00Z',
  created_at: '2026-09-04T09:00:00Z',
  updated_at: '2026-09-04T12:00:00Z',
  base: { ...giteaPullRequest.base, ref: 'master' },
};

const contractFiles = [
  { ...giteaPullRequestFiles[0], filename: 'packages/a.ts' },
  { ...giteaPullRequestFiles[1], filename: 'packages/b.ts' },
];

describeForgeContract({
  name: 'GiteaForge',
  create: (fetchImpl) => new GiteaForge({ token: 'gt_contract', apiBaseUrl: 'https://forge.example', fetchImpl }),
  wire: { issue: contractIssue, pullRequest: contractPr, pullRequestFiles: contractFiles },
  expectedIssueWebUrl: 'https://forge.example/o/r/issues/42',
  // Gitea maps label names to ids through the repo's label list first.
  prime: (t, op) => {
    // repo labels, then the org-label lookup (404 for a user owner)
    if (op === 'createIssue' || op === 'removeIssueLabel') {
      t.respond({ status: 200, body: giteaLabels }, { status: 404, body: { message: 'not an org' } });
    }
  },
});

// ── Gitea-specific wire details ──────────────────────────────────

describe('GiteaForge wire format', () => {
  it('derives /api/v1 from the instance URL and authenticates with `token`', async () => {
    expect(giteaEndpoint('https://git.example/')).toEqual({ kind: 'gitea', apiBaseUrl: 'https://git.example/api/v1', webBaseUrl: 'https://git.example' });
    expect(giteaEndpoint('https://git.example/api/v1')).toEqual({ kind: 'gitea', apiBaseUrl: 'https://git.example/api/v1', webBaseUrl: 'https://git.example' });
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaIssue });
    await forge.request('/repos/dan/r/issues/1');
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/issues/1');
    expect(t.calls[0].headers.Authorization).toBe('token gt_x');
  });

  it('normalises null assignees and the id-only milestone', () => {
    const n = normalizeGiteaIssue(giteaIssue);
    expect(n.assignees).toEqual([]);
    expect(n.milestone).toMatchObject({ id: 1, number: 1, title: 'V1: 2. Sync', due_on: '2026-10-01T02:00:00+02:00' });
    expect(n.labels.map((l) => l.name)).toEqual(['bug', 'priority:P1']);
    expect(n.pull_request).toBeUndefined();
    // Identity for the fields the sync reads.
    expect(n).toMatchObject({ number: 1, state: 'open', html_url: giteaIssue.html_url, closed_at: null });
  });

  it('lists issues with limit + type=issues (PRs excluded) and no sort', () => {
    const forge = forgeWith(fakeTransport());
    expect(forge.issuesListPath('dan', 'r', { state: 'all', perPage: 100, sort: 'updated', direction: 'asc', since: '2026-09-24T00:00:00Z' })).toBe(
      '/repos/dan/r/issues?state=all&limit=100&type=issues&since=2026-09-24T00%3A00%3A00Z',
    );
  });

  it('creates an issue with label IDs, creating unknown labels first', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    const ORG_404 = { status: 404, body: { message: 'not an org' } };
    t.respond(
      { status: 200, body: giteaLabels }, // GET repo labels
      ORG_404, // GET org labels (user owner)
      { status: 201, body: { ...giteaLabels[0], id: 42, name: 'new-one' } }, // POST label new-one
      { status: 200, body: [...giteaLabels, { ...giteaLabels[0], id: 42, name: 'new-one' }] }, // refreshed GET labels
      ORG_404,
      { status: 201, body: giteaIssue }, // POST issue
    );
    await forge.createIssue('dan', 'r', { title: 'x', body: 'y', labels: ['bug', 'new-one'] });
    expect(t.calls[1].url).toBe('https://git.example/api/v1/orgs/dan/labels?limit=100');
    const posts = t.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([
      'https://git.example/api/v1/repos/dan/r/labels',
      'https://git.example/api/v1/repos/dan/r/issues',
    ]);
    expect(JSON.parse(posts[0].body ?? '{}')).toEqual({ name: 'new-one', color: '#ededed' });
    expect(JSON.parse(posts[1].body ?? '{}')).toEqual({ title: 'x', body: 'y', labels: [1, 42] });
  });

  it('updateIssue: PATCH for title/body/state/milestone, PUT for the label set, state_reason dropped', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond(
      { status: 201, body: giteaIssue }, // PATCH (Gitea answers 201)
      { status: 200, body: giteaLabels }, // GET repo labels (ensure)
      { status: 404, body: {} }, // GET org labels
      { status: 200, body: [giteaLabels[1]] }, // PUT labels
    );
    const issue = await forge.updateIssue('dan', 'r', 1, { title: 'T', state: 'closed', state_reason: 'completed', labels: ['bug'], milestone: 2 });
    expect(t.calls[0]).toMatchObject({ method: 'PATCH', url: 'https://git.example/api/v1/repos/dan/r/issues/1' });
    expect(JSON.parse(t.calls[0].body ?? '{}')).toEqual({ title: 'T', state: 'closed', milestone: 2 });
    expect(t.calls[3]).toMatchObject({ method: 'PUT', url: 'https://git.example/api/v1/repos/dan/r/issues/1/labels' });
    expect(JSON.parse(t.calls[3].body ?? '{}')).toEqual({ labels: ['bug'] });
    expect(issue.labels.map((l) => l.name)).toEqual(['bug']);
  });

  it('addIssueLabels: a name Gitea silently drops is reported as 422 like GitHub', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: [giteaLabels[1]] }); // Gitea returns the labels now on the issue — the unknown one is missing
    const res = await forge.addIssueLabels('dan', 'r', 1, ['does-not-exist']);
    expect(res.status).toBe(422);
    expect(res.bodyText).toContain('does-not-exist');
  });

  it('removeIssueLabel: resolves the name to an id; unknown name → 404 without a DELETE', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaLabels }, { status: 404, body: {} }, { status: 204 });
    const ok = await forge.removeIssueLabel('dan', 'r', 1, 'triage:skipped');
    expect(ok.status).toBe(204);
    expect(t.calls[2]).toMatchObject({ method: 'DELETE', url: 'https://git.example/api/v1/repos/dan/r/issues/1/labels/5' });
    const missing = await forge.removeIssueLabel('dan', 'r', 1, 'nope');
    expect(missing.status).toBe(404);
    expect(t.calls).toHaveLength(3); // label list cached, no DELETE sent
  });

  it('labels: organisation labels are visible by name; repo labels win a clash', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond(
      { status: 200, body: [giteaLabels[1]] }, // repo: bug (id 1)
      { status: 200, body: [{ ...giteaLabels[1], id: 900 }, { ...giteaLabels[0], id: 901, name: 'org-only' }] }, // org
      { status: 204 },
    );
    const res = await forge.removeIssueLabel('org', 'r', 1, 'org-only');
    expect(res.status).toBe(204);
    expect(t.calls[2].url).toBe('https://git.example/api/v1/repos/org/r/issues/1/labels/901');
    // `bug` resolves to the repo's id 1, not the org's 900.
    t.respond({ status: 204 });
    await forge.removeIssueLabel('org', 'r', 1, 'bug');
    expect(t.calls[3].url).toBe('https://git.example/api/v1/repos/org/r/issues/1/labels/1');
  });

  it('listMilestones: ref is the Gitea id', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaMilestones });
    expect(await forge.listMilestones('dan', 'r')).toEqual([
      { ref: 2, title: 'V2: 1. Later', state: 'open' },
      { ref: 1, title: 'V1: 2. Sync', state: 'open' },
    ]);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/milestones?state=all&limit=100');
  });

  it('timeline: pull_ref entries give the cross-referencing PRs, close entries the latest close', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaTimelineIssue3 }, { status: 200, body: giteaTimelineIssue3 });
    expect(await forge.listCrossReferencingPullRequests('dan', 'mindblown-forge-test', 3)).toEqual([4]);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/mindblown-forge-test/issues/3/timeline?limit=100');
    expect(await forge.getLatestCloseEvent('dan', 'mindblown-forge-test', 3)).toEqual({
      actor: 'dan',
      commitId: null,
      createdAt: '2026-09-24T06:09:48+02:00',
      stateReason: null,
    });
  });

  it('timeline scan refuses to answer from a truncated walk', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    const next = 'https://git.example/api/v1/repos/dan/r/issues/3/timeline?limit=100&page=2';
    for (let i = 0; i < 25; i++) t.respond({ status: 200, body: giteaTimelineIssue3, headers: { link: `<${next}>; rel="next"` } });
    await expect(forge.getLatestCloseEvent('dan', 'r', 3)).rejects.toBeInstanceOf(GitHubScanTruncatedError);
  });

  it('PR list path uses Gitea sort vocabulary; PR files use limit', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    expect(forge.pullRequestsListPath('dan', 'r', { state: 'closed', sort: 'updated', direction: 'desc', perPage: 100 })).toBe(
      '/repos/dan/r/pulls?state=closed&sort=recentupdate&limit=100',
    );
    t.respond({ status: 200, body: giteaPullRequestFiles });
    expect(await forge.listPullRequestFiles('dan', 'r', 4)).toEqual(['NOTES.md', 'packages/two.ts']);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/pulls/4/files?limit=100');
  });
});

// ── The sync operations over a GiteaForge ───────────────────────

describe('sync operations on Gitea', () => {
  it('findClosingPrsForIssue: timeline pull_ref → PR fetched → closing keyword re-checked', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaTimelineIssue3 }, { status: 200, body: giteaPullRequest });
    const prs = await findClosingPrsForIssue('dan', 'mindblown-forge-test', 3, forge);
    expect(prs).toEqual([
      {
        number: 4,
        state: 'closed',
        merged: true,
        mergedAt: '2026-09-24T06:09:48+02:00',
        mergeCommitSha: 'd179e753af96c5a035729346febc7f4c4d5d142f',
        baseRef: 'main',
        url: 'https://git.project.li/dan/mindblown-forge-test/pulls/4',
      },
    ]);
    // Issue #2 is only MENTIONED by PR #4 — no closing keyword for it.
    t.respond({ status: 200, body: giteaTimelineIssue3 }, { status: 200, body: giteaPullRequest });
    expect(await findClosingPrsForIssue('dan', 'mindblown-forge-test', 2, forge)).toEqual([]);
  });

  it('getIssueCloseEvent reads the timeline close entry', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: giteaTimelineIssue3 });
    expect(await getIssueCloseEvent('dan', 'mindblown-forge-test', 3, forge)).toMatchObject({ actor: 'dan', commitId: null });
  });

  it('importGitHubIssues normalises each page and groups by milestone', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond({ status: 200, body: [giteaIssue] });
    const imported = await importGitHubIssues('dan', 'mindblown-forge-test', forge);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/mindblown-forge-test/issues?state=open&limit=100&type=issues');
    expect(imported).toHaveLength(1);
    expect(imported[0].externalLink).toMatchObject({ provider: 'gitea', externalId: 'dan/mindblown-forge-test#1', url: giteaIssue.html_url, state: 'open' });
    expect(imported[0].groupLabel).toBe('Sync');
    expect(imported[0].milestoneTitle).toBe('V1: 2. Sync');
    expect(imported[0].issue.assignees).toEqual([]);
  });

  it('fetchChangedIssues passes since and follows Link pages', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    const page2 = 'https://git.example/api/v1/repos/dan/r/issues?state=all&limit=100&type=issues&page=2';
    t.respond(
      { status: 200, body: [giteaIssue], headers: { link: `<${page2}>; rel="next"` } },
      { status: 200, body: [{ ...giteaIssue, number: 2 }] },
    );
    const r = await fetchChangedIssues('dan', 'r', forge, '2026-09-24T00:00:00Z');
    expect(r.truncated).toBe(false);
    expect(r.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(t.calls[0].url).toBe('https://git.example/api/v1/repos/dan/r/issues?state=all&limit=100&type=issues&since=2026-09-24T00%3A00%3A00Z');
    expect(t.calls[1].url).toBe(page2);
  });

  it('setGitHubIssueMilestone patches the milestone id and removes the label by id', async () => {
    const t = fakeTransport();
    const forge = forgeWith(t);
    t.respond(
      { status: 200, body: giteaMilestones }, // list milestones
      { status: 201, body: giteaIssue }, // PATCH milestone
      { status: 200, body: giteaLabels }, // GET repo labels (remove)
      { status: 404, body: {} }, // GET org labels
      { status: 204 }, // DELETE label 6
    );
    const r = await setGitHubIssueMilestone('dan', 'r', 1, 'V1: 2. Sync', 'NEEDS-VERSION', forge);
    expect(r).toEqual({ milestoneNumber: 1 });
    expect(JSON.parse(t.calls[1].body ?? '{}')).toEqual({ milestone: 1 });
    expect(t.calls[4]).toMatchObject({ method: 'DELETE', url: 'https://git.example/api/v1/repos/dan/r/issues/1/labels/6' });
  });
});

// ── Webhooks ─────────────────────────────────────────────────────

describe('Gitea webhooks', () => {
  it('headers: GitHub-compatible names present, kind detected as gitea', () => {
    const h = readWebhookHeaders(giteaWebhookIssuesOpened.headers);
    expect(h).toEqual({
      event: 'issues',
      signature: giteaWebhookIssuesOpened.headers['x-hub-signature-256'],
      delivery: 'af9a1bb4-b8b2-4ed4-a2c9-551c4bff231d',
      kind: 'gitea',
    });
    // Without the GitHub-compatible headers the Gitea ones are enough.
    const { 'x-github-event': _e, 'x-hub-signature-256': _s, 'x-github-delivery': _d, ...giteaOnly } = giteaWebhookIssuesOpened.headers;
    expect(readWebhookHeaders(giteaOnly)).toMatchObject({ event: 'issues', signature: `sha256=${giteaOnly['x-gitea-signature']}`, kind: 'gitea' });
  });

  it('signature: X-Hub-Signature-256 verifies against the raw body (same HMAC as GitHub)', async () => {
    // Recomputed with a known secret so the fixture body is verifiable.
    const { createHmac } = await import('node:crypto');
    const raw = JSON.stringify(giteaWebhookIssuesOpened.body);
    const sig = 'sha256=' + createHmac('sha256', 's3cret').update(raw).digest('hex');
    expect(await verifyWebhookSignature(raw, sig, 's3cret')).toBe(true);
    expect(await verifyWebhookSignature(raw, sig, 'wrong')).toBe(false);
  });

  it('action vocabulary: label_updated → labeled, others pass through', () => {
    expect(normalizeGiteaWebhookAction('issues', giteaWebhookIssuesLabelUpdated.body.action)).toBe('labeled');
    expect(normalizeGiteaWebhookAction('issues', 'label_cleared')).toBe('unlabeled');
    expect(normalizeGiteaWebhookAction('issues', giteaWebhookIssuesEdited.body.action)).toBe('edited');
    expect(normalizeGiteaWebhookAction('pull_request', giteaWebhookPullRequestClosed.body.action)).toBe('closed');
  });

  it('payload shapes the ingest relies on are present', () => {
    // issues.edited carries `changes.title.from` like GitHub.
    expect(giteaWebhookIssuesEdited.body.changes).toMatchObject({ title: { from: 'Child task one' } });
    // A merge-close names the merge commit at the top level.
    expect(giteaWebhookIssuesClosedByMerge.body.commit_id).toBe('d179e753af96c5a035729346febc7f4c4d5d142f');
    // pull_request.closed has merged, base.ref and the repo's default branch.
    expect(giteaWebhookPullRequestClosed.body.pull_request).toMatchObject({ merged: true, base: { ref: 'main' }, merge_commit_sha: 'd179e753af96c5a035729346febc7f4c4d5d142f' });
    expect(giteaWebhookPullRequestClosed.body.repository.default_branch).toBe('main');
    // Normalising the webhook issue fixes the null assignees.
    expect(normalizeGiteaIssue(giteaWebhookIssuesOpened.body.issue).assignees).toEqual([]);
  });

  it('EXPECTED_ISSUE is reachable from a Gitea wire issue (contract sanity)', () => {
    expect(normalizeGiteaIssue(contractIssue)).toMatchObject(EXPECTED_ISSUE_MATCH);
  });
});
