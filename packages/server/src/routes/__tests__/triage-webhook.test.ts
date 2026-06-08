/**
 * Webhook-handler tests for the #142 cost-opt — diff-aware skip on
 * `issues.edited`.
 *
 * The webhook handler in `routes/integrations.ts` is the OUTERMOST
 * layer of the three cost-opt layers. When GitHub fires an
 * `issues.edited` event whose `changes` object doesn't carry a
 * `title` or `body` entry (i.e. only labels / milestone / assignee
 * changed), the handler MUST:
 *
 *   1. Skip the call to `ingestNewIssuesForRepo`, which is the path
 *      that would otherwise pay for a triage LLM round-trip.
 *   2. Skip the trailing `processWebhook` fallthrough — the title
 *      and body of the node would be re-written with the same
 *      values they already hold, which is a wasted DB UPDATE.
 *   3. Reply with `{ status: 'metadata_only_skipped' }` so log
 *      greps can count how often we save the call. Phase 4
 *      tuning-data collection treats this status as "not a real
 *      triage event" and skips it for accuracy roll-ups.
 *
 * A populated `changes.title` or `changes.body` entry must still
 * pass through to the ingest path (content actually changed).
 *
 * Signature verification is mocked to always pass so each case can
 * focus on the diff-aware-skip behaviour rather than HMAC plumbing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────
// vi.mock factories are hoisted above top-level code, so any spy they
// reference must also be hoisted. We use vi.hoisted for the shared
// spies and re-expose them locally for assertions.

const mocks = vi.hoisted(() => ({
  ingestMock: vi.fn(async () => undefined),
  processWebhookMock: vi.fn(() => ({ action: 'noop' })),
  verifySignatureMock: vi.fn(async () => true),
}));
const ingestMock = mocks.ingestMock;
const processWebhookMock = mocks.processWebhookMock;
const verifySignatureMock = mocks.verifySignatureMock;

vi.mock('@mindblown/integrations', () => ({
  createGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
  importGitHubIssues: vi.fn(),
  extractVersionFromMilestone: vi.fn(),
  processWebhook: mocks.processWebhookMock,
  verifyWebhookSignature: mocks.verifySignatureMock,
  mintInstallationToken: vi.fn(),
  isGitHubAppConfigured: vi.fn(() => true),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    transaction: async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb({}),
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
  getNode: vi.fn(async () => null),
  createNode: vi.fn(),
  updateNode: vi.fn(async () => null),
  notDeleted: { __pred: true, check: () => true },
}));

vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../auth.js', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({
  rollupParentsForChildTitle: vi.fn(),
}));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: mocks.ingestMock,
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../sync/triage.js', () => ({
  triageIssue: vi.fn(),
  clearTriageDebounce: vi.fn(),
  computeInputHash: vi.fn(),
  markTriageDebounce: vi.fn(),
  isWithinDebounceWindow: vi.fn(() => false),
}));
vi.mock('../../sync/mapContext.js', () => ({ buildMapContext: vi.fn() }));
vi.mock('../../sync/triageHistory.js', () => ({
  recordTriageHistory: vi.fn(),
}));
vi.mock('../../sync/triageLabelWriteback.js', () => ({
  applyTriageLabel: vi.fn(),
}));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ __pred: true, check: () => true })),
  and: vi.fn(() => ({ __pred: true, check: () => true })),
}));

import { integrationRoutes } from '../integrations.js';

// ── Harness ──────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(integrationRoutes);
  return app;
}

function basePayload(action: string, changes?: Record<string, unknown>): Record<string, unknown> {
  return {
    action,
    issue: {
      id: 1,
      number: 42,
      title: 'Some issue',
      body: 'a body',
      state: 'open',
      labels: [],
      assignees: [],
      milestone: null,
      html_url: 'https://github.com/owner/repo/issues/42',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: 'owner/repo' },
    ...(changes !== undefined ? { changes } : {}),
  };
}

beforeEach(() => {
  ingestMock.mockClear();
  processWebhookMock.mockClear();
  verifySignatureMock.mockClear();
  verifySignatureMock.mockResolvedValue(true);
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

// ── Diff-aware skip on issues.edited ─────────────────────────────

describe('webhook: issues.edited diff-aware skip (#142 layer 1)', () => {
  it('metadata-only edit (changes={}) → ingest NOT called, status metadata_only_skipped', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: basePayload('edited', {}),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      received: true,
      action: 'issues.edited',
      status: 'metadata_only_skipped',
    });
    expect(ingestMock).not.toHaveBeenCalled();
    // The trailing processWebhook fallthrough should also be skipped
    // — we don't want a stray UPDATE on the node either.
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it('metadata-only edit (missing changes entirely) → ingest NOT called', async () => {
    const app = await buildApp();
    // Some GitHub deliveries omit `changes` altogether when only
    // labels changed (the labeled/unlabeled actions carry the diff
    // instead). Treat as metadata-only.
    const payload = basePayload('edited');
    delete payload.changes;
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'metadata_only_skipped',
    });
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('title change → ingest IS called (content actually changed)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: basePayload('edited', { title: { from: 'old title' } }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
    expect(ingestMock).toHaveBeenCalledWith(
      { owner: 'owner', repo: 'repo' },
      [expect.objectContaining({ number: 42 })],
    );
  });

  it('body change → ingest IS called', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: basePayload('edited', { body: { from: 'old body' } }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
  });

  it('issues.opened → ingest IS called (the diff-aware gate only applies to edited)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: basePayload('opened'),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
  });

  it('issues.reopened → ingest IS called (lifecycle event, not metadata)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: basePayload('reopened'),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(ingestMock).toHaveBeenCalledOnce();
  });

  it('invalid signature → 401 and ingest NOT called', async () => {
    verifySignatureMock.mockResolvedValueOnce(false);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=bad',
      },
      payload: basePayload('edited', { title: { from: 'old' } }),
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });
});
