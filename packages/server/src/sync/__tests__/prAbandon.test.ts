/**
 * The way back: a PR that dies unmerged must undo the close it caused.
 *
 * crm#6085 is the case these tests are written against — closed
 * 2026-07-27 because PR #6089 existed, PR #6089 never merged, ticket
 * still reads COMPLETED and the work is still missing. Nothing in the
 * sync ever looked again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGitHubIssue: vi.fn(),
  getIssueCloseEvent: vi.fn(),
  probeIssueLanded: vi.fn(),
  reopenGitHubIssue: vi.fn(async () => undefined),
  getNode: vi.fn(),
  updateNode: vi.fn(async () => null),
  findNodeIdByExternalId: vi.fn(async () => null as string | null),
}));

vi.mock('@mindblown/integrations', async () => {
  // extractClosingIssueRefs stays REAL: which issues a PR closes is the
  // premise of every case below, and a stubbed parser would let the
  // tests agree with themselves rather than with production.
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>(
    '@mindblown/integrations',
  );
  return {
    ...actual,
    getGitHubIssue: mocks.getGitHubIssue,
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

import { handleAbandonedPr } from '../prAbandon.js';

const CTX = { owner: 'FulcrumCRM', repo: 'crm', token: 'tok' };
const ABANDONED_PR = {
  number: 6089,
  title: 'fix(compliance): retention prune audit records',
  body: 'Closes #6085',
};

function probe(overrides: Record<string, unknown> = {}) {
  return {
    closingPrs: [],
    defaultBranch: 'main',
    landed: null,
    inFlight: false,
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.reopenGitHubIssue.mockResolvedValue(undefined);
  mocks.updateNode.mockResolvedValue(null);
  mocks.findNodeIdByExternalId.mockResolvedValue(null);
  mocks.probeIssueLanded.mockResolvedValue(probe());
});

describe('handleAbandonedPr', () => {
  it('reopens an issue the dead PR had closed with no merge behind it', async () => {
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'mindblown-by-project-li[bot]',
      commitId: null,
      createdAt: '2026-07-27T00:00:00Z',
      stateReason: 'completed',
    });

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out).toEqual([
      { externalId: 'FulcrumCRM/crm#6085', status: 'reopened', nodeId: null },
    ]);
    expect(mocks.reopenGitHubIssue).toHaveBeenCalledWith(
      { externalId: 'FulcrumCRM/crm#6085' },
      'tok',
    );
  });

  it('rolls the linked node back off done, restoring the captured progress', async () => {
    mocks.findNodeIdByExternalId.mockResolvedValue('n-6085');
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'bot', commitId: null, createdAt: null, stateReason: 'completed',
    });
    mocks.getNode.mockResolvedValue({
      id: 'n-6085',
      status: 'done',
      percentComplete: 100,
      externalLinks: [
        {
          provider: 'github',
          externalId: 'FulcrumCRM/crm#6085',
          url: 'u',
          syncEnabled: true,
          lastSyncedAt: null,
          previousPercentComplete: 40,
          previousStatus: 'in_progress',
        },
      ],
    });

    await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(mocks.updateNode).toHaveBeenCalledTimes(1);
    const [nodeId, fields] = mocks.updateNode.mock.calls[0];
    expect(nodeId).toBe('n-6085');
    expect(fields.percentComplete).toBe(40);
    expect(fields.status).toBe('in_progress');
    // The snapshot is consumed, so a later legitimate close captures
    // fresh state instead of restoring this one twice.
    expect(fields.externalLinks[0]).toMatchObject({
      previousPercentComplete: null,
      previousStatus: null,
      state: 'open',
    });
  });

  it('falls back to in_progress when no close-snapshot was captured', async () => {
    mocks.findNodeIdByExternalId.mockResolvedValue('n-6085');
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'bot', commitId: null, createdAt: null, stateReason: 'completed',
    });
    mocks.getNode.mockResolvedValue({
      id: 'n-6085',
      status: 'done',
      percentComplete: 100,
      externalLinks: [
        {
          provider: 'github',
          externalId: 'FulcrumCRM/crm#6085',
          url: 'u',
          syncEnabled: true,
          lastSyncedAt: null,
        },
      ],
    });

    await handleAbandonedPr(CTX, ABANDONED_PR);

    const [, fields] = mocks.updateNode.mock.calls[0];
    expect(fields.status).toBe('in_progress');
    expect(fields.percentComplete).toBeNull();
  });

  it('leaves a close that carries a merge commit alone — that was GitHub itself', async () => {
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'github', commitId: 'abc123', createdAt: null, stateReason: 'completed',
    });

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out[0].status).toBe('closed_by_commit');
    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
  });

  it('leaves an issue whose work a REPLACEMENT PR already landed', async () => {
    // Supersede pattern: PR A abandoned, PR B merged. Reopening here
    // would put a shipped ticket back on the board.
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'bot', commitId: null, createdAt: null, stateReason: 'completed',
    });
    mocks.probeIssueLanded.mockResolvedValue(
      probe({
        landed: {
          number: 6200,
          state: 'closed',
          merged: true,
          mergedAt: '2026-08-01T00:00:00Z',
          mergeCommitSha: 'cafe',
          baseRef: 'main',
          url: 'u',
        },
      }),
    );

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out[0].status).toBe('landed_elsewhere');
    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
  });

  it('reopens when the only landed PR is the abandoned one itself', async () => {
    // Guard against the guard: `landed.number !== pr.number` must not be
    // satisfiable by the dead PR reporting itself.
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'bot', commitId: null, createdAt: null, stateReason: 'completed',
    });
    mocks.probeIssueLanded.mockResolvedValue(
      probe({
        landed: {
          number: 6089,
          state: 'closed',
          merged: true,
          mergedAt: null,
          mergeCommitSha: null,
          baseRef: 'main',
          url: 'u',
        },
      }),
    );

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out[0].status).toBe('reopened');
  });

  it('is a no-op — and idempotent on replay — when the issue is already open', async () => {
    mocks.getGitHubIssue.mockResolvedValue({ number: 6085, state: 'open' });

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out[0].status).toBe('already_open');
    expect(mocks.reopenGitHubIssue).not.toHaveBeenCalled();
    expect(mocks.getIssueCloseEvent).not.toHaveBeenCalled();
  });

  it('does nothing for a PR that closes no issue', async () => {
    const out = await handleAbandonedPr(CTX, {
      number: 1,
      title: 'chore: tidy',
      body: 'Relates to #6085',
    });

    expect(out).toEqual([]);
    expect(mocks.getGitHubIssue).not.toHaveBeenCalled();
  });

  it('reports a GitHub failure per issue instead of throwing', async () => {
    mocks.getGitHubIssue.mockRejectedValue(new Error('GitHub API 502: bad gateway'));

    const out = await handleAbandonedPr(CTX, ABANDONED_PR);

    expect(out[0].status).toBe('failed');
    expect(out[0].error).toContain('502');
  });

  it('handles every Closes ref in the PR, not just the first', async () => {
    mocks.getGitHubIssue.mockResolvedValue({ number: 0, state: 'closed' });
    mocks.getIssueCloseEvent.mockResolvedValue({
      actor: 'bot', commitId: null, createdAt: null, stateReason: 'completed',
    });

    const out = await handleAbandonedPr(CTX, {
      number: 6089,
      title: 'fix: two things',
      body: 'Closes #6085\nFixes #6086',
    });

    expect(out.map((o) => o.externalId)).toEqual([
      'FulcrumCRM/crm#6085',
      'FulcrumCRM/crm#6086',
    ]);
    expect(mocks.reopenGitHubIssue).toHaveBeenCalledTimes(2);
  });
});
