/**
 * A `push` delivery reaches the Docs tab (#550): the route hands repo and
 * payload to `onRepoPush` (which invalidates + broadcasts — pinned in
 * services/__tests__/repoDocs.test.ts) and answers without running any
 * issue / PR handler. Harness copied from gitea-review-webhook.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  onRepoPush: vi.fn(async () => 2),
  handleReviewSubmitted: vi.fn(async () => 1),
}));

vi.mock('../../services/repoDocs.js', () => ({ onRepoPush: mocks.onRepoPush }));

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

beforeEach(() => {
  mocks.onRepoPush.mockClear();
  mocks.handleReviewSubmitted.mockClear();
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

describe('push webhook (#550)', () => {
  it.each(['github', 'gitea'] as const)('a %s push is handed to the docs service', async (kind) => {
    const app = await buildApp();
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'o/r', default_branch: 'main' }, commits: [] };
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'push',
        ...(kind === 'gitea' ? { 'x-gitea-event': 'push' } : {}),
        'x-hub-signature-256': 'sha256=anything',
      },
      payload,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, docsMaps: 2 });
    expect(mocks.onRepoPush).toHaveBeenCalledWith('o/r', expect.objectContaining({ ref: 'refs/heads/main' }));
    expect(mocks.handleReviewSubmitted).not.toHaveBeenCalled();
  });
});
