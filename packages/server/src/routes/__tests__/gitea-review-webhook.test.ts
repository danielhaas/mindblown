/**
 * Gitea PR reviews reach the review handler (#422).
 *
 * Gitea delivers a review as its own event per verdict
 * (`X-GitHub-Event: pull_request_approved`, type
 * `pull_request_review_approved`, action `reviewed`, `review: { type,
 * content }`, reviewer in `sender`). Before #422 the route only knew
 * GitHub's `pull_request_review.submitted`, so every Gitea review was
 * answered 200 and dropped. The delivery below is the one captured on the
 * test bed on 2026-10-10 (trimmed).
 *
 * Harness mirrors issues-reopen-gate.test.ts: signature verification is
 * stubbed to pass, DB and node CRUD are mocked; the PR sync is spied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  handleReviewSubmitted: vi.fn(async () => 1),
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>('@mindblown/integrations');
  return {
    ...actual,
    verifyWebhookSignature: vi.fn(async () => true),
    mintInstallationToken: vi.fn(),
    isGitHubAppConfigured: vi.fn(() => true),
  };
});
vi.mock('../../sync/prSync.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../sync/prSync.js');
  return { ...actual, handleReviewSubmitted: mocks.handleReviewSubmitted };
});
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    transaction: async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  },
}));
vi.mock('../../db/schema.js', () => ({
  integrations: { __name: 'integrations' },
  versions: { __name: 'versions' },
  nodes: { __name: 'nodes' },
  maps: { __name: 'maps' },
  triageDecisions: { __name: 'triageDecisions' },
}));
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  setExternalLinkState: vi.fn(async () => true),
  findNodeIdByExternalId: vi.fn(async () => null),
  notDeleted: { __pred: true },
}));
vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../auth.js', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({ rollupParentsForChildTitle: vi.fn() }));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(async () => []),
  syncIssueLabelsToNodes: vi.fn(async () => 0),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../sync/triage.js', () => ({
  triageAvailable: () => true,
  triageIssue: vi.fn(),
  clearTriageDebounce: vi.fn(),
  computeInputHash: vi.fn(),
  markTriageDebounce: vi.fn(),
  isWithinDebounceWindow: vi.fn(() => false),
}));
vi.mock('../../sync/mapContext.js', () => ({ buildMapContext: vi.fn() }));
vi.mock('../../sync/triageHistory.js', () => ({ recordTriageHistory: vi.fn() }));
vi.mock('../../sync/triageLabelWriteback.js', () => ({ applyTriageLabel: vi.fn() }));
vi.mock('../../sync/workStartSync.js', () => ({ markWorkStarted: vi.fn(async () => 0) }));
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

import { integrationRoutes } from '../integrations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(integrationRoutes);
  return app;
}

const PR = { number: 8, title: 'capture #422 (throwaway)', body: 'Closes #1', state: 'open', merged: false };

function giteaReview(verdict: 'approved' | 'rejected' | 'comment', reviewer: string, content: string) {
  const event = `pull_request_${verdict}`;
  return {
    headers: {
      'x-github-event': event,
      'x-gitea-event': event,
      'x-gitea-event-type': `pull_request_review_${verdict}`,
      'x-hub-signature-256': 'sha256=anything',
    },
    payload: {
      action: 'reviewed',
      number: 8,
      review: { type: `pull_request_review_${verdict}`, content },
      sender: { login: reviewer },
      pull_request: PR,
      repository: { full_name: 'dan/mindblown-forge-test' },
    },
  };
}

beforeEach(() => {
  mocks.handleReviewSubmitted.mockClear();
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

describe('Gitea review webhook (#422)', () => {
  it.each([
    ['approved', 'approved'],
    ['rejected', 'changes_requested'],
    ['comment', 'commented'],
  ] as const)('a Gitea %s review is recorded as a %s review on the PR', async (verdict, state) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/github', ...giteaReview(verdict, 'mb-oauth-test', `capture: ${verdict}`) });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.handleReviewSubmitted).toHaveBeenCalledTimes(1);
    expect(mocks.handleReviewSubmitted).toHaveBeenCalledWith(
      'dan/mindblown-forge-test',
      expect.objectContaining({ number: 8, body: 'Closes #1' }),
      { user: { login: 'mb-oauth-test' }, state, body: `capture: ${verdict}`, submitted_at: null },
    );
  });

  it('a plain PR comment from Gitea (same event name, other type) is not taken for a review', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request_comment',
        'x-gitea-event': 'pull_request_comment',
        'x-gitea-event-type': 'pull_request_comment',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: { action: 'created', pull_request: PR, repository: { full_name: 'dan/mindblown-forge-test' }, sender: { login: 'dan' } },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.handleReviewSubmitted).not.toHaveBeenCalled();
  });
});
