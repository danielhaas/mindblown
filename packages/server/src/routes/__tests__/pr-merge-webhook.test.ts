/**
 * #152 — pull_request: closed (merged=true) → linked nodes transition to done.
 *
 * Covers the new branch in routes/integrations.ts that subscribes to PR
 * merge events for repos that don't send `issues` webhooks (e.g.
 * FulcrumCRM/crm). Verifies:
 *
 *   1. Multi-issue: PR body with "Closes #1, fixes #2" transitions BOTH
 *      linked nodes (the legacy processWebhook PR branch only returned
 *      the first ref).
 *   2. Idempotency: replay of the same payload finds the node already
 *      done and reports `already_done` without writing.
 *   3. Unsigned requests are rejected before the handler reaches the DB.
 *   4. Non-merged closures (PR closed without merging) are passed
 *      through unchanged.
 *   5. References to issues with no linked MindBlown node are reported
 *      as `not_linked` (not an error).
 *
 * Signature verification is stubbed to pass; HMAC plumbing is covered
 * by separate tests in `webhookAuthCheck.test.ts`. The processWebhook
 * fallthrough is mocked to a no-op so we can isolate the new branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

interface NodeRow {
  id: string;
  externalLinks: Array<{
    provider: string;
    externalId: string;
    url: string;
    syncEnabled: boolean;
    lastSyncedAt: string | null;
    previousPercentComplete?: number | null;
    previousStatus?: string | null;
  }>;
}

interface NodeRecord extends NodeRow {
  mapId: string;
  status: string | null;
  percentComplete: number | null;
}

const mocks = vi.hoisted(() => {
  const nodeStore = new Map<string, {
    mapId: string;
    status: string | null;
    percentComplete: number | null;
    externalLinks: NodeRow['externalLinks'];
  }>();
  return {
    nodeStore,
    getNodeMock: vi.fn(),
    updateNodeMock: vi.fn(),
    selectNodesMock: vi.fn(),
    broadcastMock: vi.fn(),
    verifySignatureMock: vi.fn(async () => true),
    processWebhookMock: vi.fn(() => ({ action: 'noop', nodeUpdates: null, externalId: null })),
  };
});

vi.mock('@mindblown/integrations', () => ({
  createGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
  importGitHubIssues: vi.fn(),
  extractVersionFromMilestone: vi.fn(),
  // Real implementation — the regex is the unit under test for ref extraction.
  extractClosingIssueRefs: (text: string): number[] => {
    const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
    const refs = new Set<number>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      refs.add(parseInt(match[1], 10));
    }
    return [...refs];
  },
  processWebhook: mocks.processWebhookMock,
  verifyWebhookSignature: mocks.verifySignatureMock,
  mintInstallationToken: vi.fn(),
  isGitHubAppConfigured: vi.fn(() => true),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mocks.selectNodesMock(),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
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
  getNode: mocks.getNodeMock,
  createNode: vi.fn(),
  updateNode: mocks.updateNodeMock,
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
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcastMock }));
vi.mock('../../sync/triage.js', () => ({
  triageIssue: vi.fn(),
  clearTriageDebounce: vi.fn(),
  computeInputHash: vi.fn(),
  markTriageDebounce: vi.fn(),
  isWithinDebounceWindow: vi.fn(() => false),
}));
vi.mock('../../sync/mapContext.js', () => ({ buildMapContext: vi.fn() }));
vi.mock('../../sync/triageHistory.js', () => ({ recordTriageHistory: vi.fn() }));
vi.mock('../../sync/triageLabelWriteback.js', () => ({ applyTriageLabel: vi.fn() }));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ __pred: true, check: () => true })),
  and: vi.fn(() => ({ __pred: true, check: () => true })),
}));

import { integrationRoutes } from '../integrations.js';

async function buildApp(logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(integrationRoutes);
  return app;
}

function prMergedPayload(opts: { number: number; title: string; body: string | null }): Record<string, unknown> {
  return {
    action: 'closed',
    pull_request: {
      number: opts.number,
      merged: true,
      html_url: `https://github.com/owner/repo/pull/${opts.number}`,
      title: opts.title,
      body: opts.body,
    },
    repository: { full_name: 'owner/repo' },
  };
}

function seedLinkedNode(args: {
  nodeId: string;
  externalId: string;
  status?: string | null;
  percentComplete?: number | null;
}): NodeRecord {
  const node: NodeRecord = {
    id: args.nodeId,
    mapId: 'map-1',
    status: args.status ?? 'in_progress',
    percentComplete: args.percentComplete ?? 50,
    externalLinks: [
      {
        provider: 'github',
        externalId: args.externalId,
        url: `https://github.com/${args.externalId.replace('#', '/issues/')}`,
        syncEnabled: true,
        lastSyncedAt: null,
      },
    ],
  };
  return node;
}

beforeEach(() => {
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.selectNodesMock.mockReset();
  // Default to an empty result set; tests override per-case. Empty is
  // safe because both consumers — the integration-secret loop and the
  // findNodeByExternalId scan — expect an array.
  mocks.selectNodesMock.mockResolvedValue([]);
  mocks.broadcastMock.mockReset();
  mocks.verifySignatureMock.mockReset();
  mocks.verifySignatureMock.mockResolvedValue(true);
  mocks.processWebhookMock.mockReset();
  mocks.processWebhookMock.mockReturnValue({ action: 'noop', nodeUpdates: null, externalId: null });
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

describe('webhook: pull_request.closed merged=true (#152)', () => {
  it('transitions a single linked node to done', async () => {
    const node = seedLinkedNode({ nodeId: 'n-100', externalId: 'owner/repo#100' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue({ ...node, status: 'done', percentComplete: 100 });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 555, title: 'feat: add Y (Closes #100)', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      received: true,
      action: 'pull_request.merged',
      prNumber: 555,
      matched: true,
    });
    expect(body.transitions).toEqual([
      { externalId: 'owner/repo#100', nodeId: 'n-100', status: 'transitioned' },
    ]);
    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
    const [calledNodeId, calledFields] = mocks.updateNodeMock.mock.calls[0];
    expect(calledNodeId).toBe('n-100');
    expect(calledFields).toMatchObject({ status: 'done', percentComplete: 100 });
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({ type: 'node:updated', source: 'github_webhook_pr_merge' }),
    );
  });

  it('iterates ALL closing refs in PR body (multi-issue support)', async () => {
    const nodeA = seedLinkedNode({ nodeId: 'n-A', externalId: 'owner/repo#1' });
    const nodeB = seedLinkedNode({ nodeId: 'n-B', externalId: 'owner/repo#2' });
    mocks.selectNodesMock.mockResolvedValue([
      { id: nodeA.id, externalLinks: nodeA.externalLinks },
      { id: nodeB.id, externalLinks: nodeB.externalLinks },
    ]);
    mocks.getNodeMock.mockImplementation(async (id: string) =>
      id === 'n-A' ? nodeA : id === 'n-B' ? nodeB : null,
    );
    mocks.updateNodeMock.mockImplementation(async (id: string) => ({
      ...(id === 'n-A' ? nodeA : nodeB),
      status: 'done',
      percentComplete: 100,
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({
        number: 999,
        title: 'big sweep',
        body: 'Closes #1, fixes #2',
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(2);
    const transitioned = res.json().transitions as Array<{ externalId: string; status: string }>;
    expect(transitioned).toHaveLength(2);
    expect(transitioned.every((t) => t.status === 'transitioned')).toBe(true);
  });

  it('is idempotent — replaying the same merge does NOT re-transition', async () => {
    const node = seedLinkedNode({
      nodeId: 'n-200',
      externalId: 'owner/repo#200',
      status: 'done',
      percentComplete: 100,
    });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 200, title: 'Closes #200', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().transitions).toEqual([
      { externalId: 'owner/repo#200', nodeId: 'n-200', status: 'already_done' },
    ]);
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });

  it('reports refs with no linked node as not_linked (not an error)', async () => {
    mocks.selectNodesMock.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: prMergedPayload({ number: 7, title: 'Closes #404', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: 'pull_request.merged',
      matched: false,
      transitions: [
        { externalId: 'owner/repo#404', nodeId: '', status: 'not_linked' },
      ],
    });
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
  });

  it('rejects unsigned requests with 401 before touching the DB', async () => {
    mocks.verifySignatureMock.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=forged',
      },
      payload: prMergedPayload({ number: 1, title: 'Closes #1', body: null }),
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    // The legacy PAT-secret lookup runs a SELECT before the 401, but
    // no mutations and no node lookups should fire.
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    expect(mocks.getNodeMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });

  it('PR closed without merging (merged=false) does not transition anything', async () => {
    const node = seedLinkedNode({ nodeId: 'n-300', externalId: 'owner/repo#300' });
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=anything',
      },
      payload: {
        action: 'closed',
        pull_request: {
          number: 300,
          merged: false,
          html_url: 'https://github.com/owner/repo/pull/300',
          title: 'Closes #300',
          body: null,
        },
        repository: { full_name: 'owner/repo' },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    // Falls through to processWebhook mock (which returns a noop).
    expect(mocks.processWebhookMock).toHaveBeenCalled();
  });
});
