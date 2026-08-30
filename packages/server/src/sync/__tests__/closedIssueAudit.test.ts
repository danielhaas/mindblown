/**
 * Inventory sweep for issues closed as COMPLETED with nothing merged
 * behind them.
 *
 * The population is real: crm#7357 (closed 6 s after its PR was created),
 * crm#6305 (21 s), crm#6085 (PR never merged). All three are
 * `state=CLOSED, stateReason=COMPLETED, commit_id=null`, and all three
 * read as finished on the board.
 *
 * The property that matters most here is that the run does NOT write by
 * default. A first look at this data must not reopen a hundred tickets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchChangedIssues: vi.fn(),
  getIssueCloseEvent: vi.fn(),
  probeIssueLanded: vi.fn(),
  reopenGitHubIssue: vi.fn(async () => undefined),
  getNode: vi.fn(),
  updateNode: vi.fn(async () => null),
  findNodeIdByExternalId: vi.fn(async () => null as string | null),
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>(
    '@mindblown/integrations',
  );
  return {
    ...actual,
    fetchChangedIssues: mocks.fetchChangedIssues,
    getIssueCloseEvent: mocks.getIssueCloseEvent,
    probeIssueLanded: mocks.probeIssueLanded,
    reopenGitHubIssue: mocks.reopenGitHubIssue,
  };
});

vi.mock('../../db/nodes.js', () => ({
  getNode: mocks.getNode,
  updateNode: mocks.updateNode,
  findNodeIdByExternalId: mocks.findNodeIdByExternalId,
}));

import { auditClosedIssues, auditOneIssue } from '../closedIssueAudit.js';

const OPTS = { owner: 'FulcrumCRM', repo: 'crm', token: 'tok' };

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 7357,
    title: 'SPG look-through for controlling persons',
    html_url: 'https://github.com/FulcrumCRM/crm/issues/7357',
    state: 'closed' as const,
    state_reason: 'completed' as const,
    ...overrides,
  };
}

function probe(overrides: Record<string, unknown> = {}) {
  return {
    closingPrs: [],
    defaultBranch: 'main',
    landed: null,
    inFlight: false,
    ...overrides,
  };
}

const API_CLOSE = {
  actor: 'mindblown-by-project-li[bot]',
  commitId: null,
  createdAt: '2026-08-10T13:09:33Z',
  stateReason: 'completed' as const,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.reopenGitHubIssue.mockResolvedValue(undefined);
  mocks.updateNode.mockResolvedValue(null);
  mocks.findNodeIdByExternalId.mockResolvedValue(null);
  mocks.probeIssueLanded.mockResolvedValue(probe());
  mocks.getIssueCloseEvent.mockResolvedValue(API_CLOSE);
  mocks.fetchChangedIssues.mockResolvedValue({ issues: [issue()], truncated: false });
});

describe('auditOneIssue', () => {
  it('condemns a COMPLETED close with no commit and no merged PR', async () => {
    const f = await auditOneIssue(OPTS, issue());

    expect(f.verdict).toBe('unbacked');
    expect(f.externalId).toBe('FulcrumCRM/crm#7357');
    expect(f.closedBy).toBe('mindblown-by-project-li[bot]');
  });

  it('condemns it even while a PR is still open — an open PR is not a merge', async () => {
    mocks.probeIssueLanded.mockResolvedValue(
      probe({
        inFlight: true,
        closingPrs: [
          {
            number: 7794,
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            baseRef: 'main',
            url: 'u',
          },
        ],
      }),
    );

    const f = await auditOneIssue(OPTS, issue());

    expect(f.verdict).toBe('unbacked');
    expect(f.closingPrs).toEqual([7794]);
  });

  it('clears a close backed by a merge commit on the close event', async () => {
    mocks.getIssueCloseEvent.mockResolvedValue({ ...API_CLOSE, commitId: 'abc123' });

    const f = await auditOneIssue(OPTS, issue());

    expect(f.verdict).toBe('backed_by_commit');
    expect(f.mergeCommitSha).toBe('abc123');
    // The commit answer is conclusive — no need to walk the timeline.
    expect(mocks.probeIssueLanded).not.toHaveBeenCalled();
  });

  it('clears a close backed by a PR merged into the default branch', async () => {
    mocks.probeIssueLanded.mockResolvedValue(
      probe({
        landed: {
          number: 7794,
          state: 'closed',
          merged: true,
          mergedAt: '2026-08-11T00:00:00Z',
          mergeCommitSha: 'cafe',
          baseRef: 'main',
          url: 'u',
        },
      }),
    );

    const f = await auditOneIssue(OPTS, issue());

    expect(f.verdict).toBe('backed_by_pr');
    expect(f.mergeCommitSha).toBe('cafe');
  });

  it('skips not_planned closes — nobody claimed that work shipped', async () => {
    const f = await auditOneIssue(OPTS, issue({ state_reason: 'not_planned' }));

    expect(f.verdict).toBe('skipped');
    expect(mocks.getIssueCloseEvent).not.toHaveBeenCalled();
  });

  it('skips open issues', async () => {
    const f = await auditOneIssue(OPTS, issue({ state: 'open', state_reason: null }));

    expect(f.verdict).toBe('skipped');
  });

  it('treats a missing state_reason as completed — that IS the silent default', async () => {
    const f = await auditOneIssue(OPTS, issue({ state_reason: undefined }));

    expect(f.verdict).toBe('unbacked');
  });

  it('honours the closedBy filter', async () => {
    mocks.getIssueCloseEvent.mockResolvedValue({ ...API_CLOSE, actor: 'a-human' });

    const f = await auditOneIssue(
      { ...OPTS, closedBy: 'mindblown-by-project-li[bot]' },
      issue(),
    );

    expect(f.verdict).toBe('skipped');
    expect(mocks.probeIssueLanded).not.toHaveBeenCalled();
  });

  it('reports a GitHub failure as an error verdict, not as a clean bill', async () => {
    mocks.getIssueCloseEvent.mockRejectedValue(new Error('GitHub API 403: rate limit'));

    const f = await auditOneIssue(OPTS, issue());

    expect(f.verdict).toBe('error');
    expect(f.error).toContain('403');
  });
});

describe('auditClosedIssues', () => {
  it('writes NOTHING by default', async () => {
    const result = await auditClosedIssues(OPTS);

    expect(result.dryRun).toBe(true);
    expect(result.unbacked).toBe(1);
    expect(result.reopened).toBe(0);
    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });

  it('writes nothing when dryRun is explicitly true', async () => {
    await auditClosedIssues({ ...OPTS, dryRun: true });

    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
  });

  it('reopens and rolls back the node only when dryRun is false', async () => {
    mocks.findNodeIdByExternalId.mockResolvedValue('n-7357');
    mocks.getNode.mockResolvedValue({
      id: 'n-7357',
      status: 'done',
      percentComplete: 100,
      externalLinks: [
        {
          provider: 'github',
          externalId: 'FulcrumCRM/crm#7357',
          url: 'u',
          syncEnabled: true,
          lastSyncedAt: null,
          previousPercentComplete: 60,
          previousStatus: 'in_progress',
        },
      ],
    });

    const result = await auditClosedIssues({ ...OPTS, dryRun: false });

    expect(result.reopened).toBe(1);
    expect(result.findings[0].reopened).toBe(true);
    expect(mocks.reopenGitHubIssue).toHaveBeenCalledWith(
      { externalId: 'FulcrumCRM/crm#7357' },
      'tok',
    );
    const [nodeId, fields] = mocks.updateNode.mock.calls[0];
    expect(nodeId).toBe('n-7357');
    expect(fields.percentComplete).toBe(60);
    expect(fields.status).toBe('in_progress');
  });

  it('leaves the backed issues alone in write mode', async () => {
    mocks.getIssueCloseEvent.mockResolvedValue({ ...API_CLOSE, commitId: 'abc123' });

    const result = await auditClosedIssues({ ...OPTS, dryRun: false });

    expect(result.unbacked).toBe(0);
    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
  });

  it('flags a truncated sweep so "0 findings" cannot be read as "clean repo"', async () => {
    mocks.fetchChangedIssues.mockResolvedValue({ issues: [issue()], truncated: true });

    expect((await auditClosedIssues(OPTS)).truncated).toBe(true);
  });

  it('flags truncation when `limit` cut the list, not just the fetch valve', async () => {
    mocks.fetchChangedIssues.mockResolvedValue({
      issues: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })],
      truncated: false,
    });

    const result = await auditClosedIssues({ ...OPTS, limit: 2 });

    expect(result.inspected).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('does not inspect issues that are still open', async () => {
    mocks.fetchChangedIssues.mockResolvedValue({
      issues: [issue({ number: 5468, state: 'open', state_reason: null })],
      truncated: false,
    });

    const result = await auditClosedIssues(OPTS);

    expect(result.inspected).toBe(0);
    expect(mocks.getIssueCloseEvent).not.toHaveBeenCalled();
  });

  it('turns a reopen failure into an error verdict rather than a false success', async () => {
    mocks.reopenGitHubIssue.mockRejectedValue(new Error('GitHub API 403'));

    const result = await auditClosedIssues({ ...OPTS, dryRun: false });

    expect(result.reopened).toBe(0);
    expect(result.findings[0].verdict).toBe('error');
  });
});
