import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalLink, LinkedPrState, Node } from '@mindblown/core';
import { updateGitHubIssue } from './github.js';

/**
 * Regression cover for the premature-close bug (2026-08-03).
 *
 * A coding agent marks its MindBlown node done when it OPENS the pull
 * request. The outbound sync read that as "work finished" and closed the
 * linked GitHub issue as COMPLETED, while the PR was still open and in
 * several cases still red. The work then looked shipped and nobody chased
 * the branch.
 */

const LINK: ExternalLink = {
  provider: 'github',
  externalId: 'FulcrumCRM/crm#6096',
  url: 'https://github.com/FulcrumCRM/crm/issues/6096',
  syncEnabled: true,
} as ExternalLink;

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: '#6096 Upward multi-hop controlling-person look-through',
    description: null,
    x: null,
    y: null,
    collapsed: false,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    blockedReason: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    customFields: {},
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [LINK],
    priorityRank: null,
    completedAt: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    autoProgress: 'off',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  } as Node;
}

function pr(state: LinkedPrState['state']): LinkedPrState {
  return {
    number: 6122,
    repo: 'FulcrumCRM/crm',
    url: 'https://github.com/FulcrumCRM/crm/pull/6122',
    head: 'fix/6096',
    base: 'main',
    author: 'django-dev-max',
    draft: false,
    state,
    mergeable: true,
    changedFiles: [],
    reviews: [],
  } as unknown as LinkedPrState;
}

/** The body of the PATCH the function sent to GitHub. */
function sentPatch(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls[0];
  const init = call[1] as RequestInit;
  expect(init.method).toBe('PATCH');
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ number: 6096, state: 'open' }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateGitHubIssue — issue state vs. linked PR', () => {
  it('does not touch the issue state while the linked PR is still open', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('open') }),
      LINK,
      'tok',
    );

    expect(sentPatch()).not.toHaveProperty('state');
  });

  it('does not touch the issue state when the linked PR was closed unmerged', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('closed') }),
      LINK,
      'tok',
    );

    expect(sentPatch()).not.toHaveProperty('state');
  });

  it('still syncs title and labels while a PR is in flight', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('open'), tags: ['compliance'] }),
      LINK,
      'tok',
    );

    const patch = sentPatch();
    expect(patch.title).toBe('#6096 Upward multi-hop controlling-person look-through');
    expect(patch.labels).toEqual(['compliance']);
  });

  it('closes the issue once the PR is merged', async () => {
    await updateGitHubIssue(
      node({ status: 'done', percentComplete: 100, linkedPr: pr('merged') }),
      LINK,
      'tok',
    );

    expect(sentPatch().state).toBe('closed');
  });

  it('closes the issue for done work that has no linked PR at all', async () => {
    // Non-code work — a Susi assessment, an ops task — has no PR. MindBlown
    // is the only thing that can close it, so the old behaviour must stand.
    await updateGitHubIssue(node({ status: 'done', linkedPr: null }), LINK, 'tok');

    expect(sentPatch().state).toBe('closed');
  });

  it('closes on percentComplete=100 alone when no PR is linked', async () => {
    await updateGitHubIssue(node({ percentComplete: 100 }), LINK, 'tok');

    expect(sentPatch().state).toBe('closed');
  });

  it('reopens an unfinished node with no linked PR', async () => {
    await updateGitHubIssue(node({ status: 'in_progress', percentComplete: 40 }), LINK, 'tok');

    expect(sentPatch().state).toBe('open');
  });
});
