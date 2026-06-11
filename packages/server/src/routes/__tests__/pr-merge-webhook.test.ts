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
    // Initial implementation is a placeholder; the mock factory below
    // rewires this to delegate to the real processWebhook so the
    // tests exercise production behaviour. The signature is widened
    // to accept the real (payload, event) shape from @mindblown/integrations.
    processWebhookMock: vi.fn(
      (...args: unknown[]): unknown => ({ action: 'noop', nodeUpdates: null, externalId: null }),
    ),
  };
});

vi.mock('@mindblown/integrations', async () => {
  // Use REAL implementations of the pure functions (processWebhook,
  // extractClosingIssueRefs) so the tests assert against the
  // production code path — not against a noop mock that would hide
  // the legacy PR-merge → done branch (#199 review caught exactly
  // this masking bug). Side-effect functions (GitHub API,
  // signature verification) stay mocked.
  //
  // processWebhook is wrapped in a spy so per-test `.mock.calls`
  // assertions still work, but the spy delegates to the real
  // implementation by default. Individual tests may override the
  // return value with `mocks.processWebhookMock.mockReturnValueOnce(...)`.
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>(
    '@mindblown/integrations',
  );
  // Cast through `unknown` to satisfy the `vi.fn(...)` parameter widening.
  // The runtime contract — "delegate every call to the real
  // implementation" — matches the production wiring.
  mocks.processWebhookMock.mockImplementation(
    actual.processWebhook as unknown as (...args: unknown[]) => unknown,
  );
  return {
    ...actual,
    createGitHubIssue: vi.fn(),
    getGitHubIssue: vi.fn(),
    importGitHubIssues: vi.fn(),
    extractVersionFromMilestone: vi.fn(),
    verifyWebhookSignature: mocks.verifySignatureMock,
    mintInstallationToken: vi.fn(),
    isGitHubAppConfigured: vi.fn(() => true),
    processWebhook: mocks.processWebhookMock,
  };
});

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

function prMergedPayload(opts: {
  number: number;
  title: string;
  body: string | null;
  baseRef?: string;
  defaultBranch?: string;
}): Record<string, unknown> {
  // Default to base=main + default_branch=main so existing single-arg
  // calls (which predate the default-branch gate added 2026-06-11)
  // still exercise the success path.
  return {
    action: 'closed',
    pull_request: {
      number: opts.number,
      merged: true,
      html_url: `https://github.com/owner/repo/pull/${opts.number}`,
      title: opts.title,
      body: opts.body,
      base: { ref: opts.baseRef ?? 'main' },
    },
    repository: { full_name: 'owner/repo', default_branch: opts.defaultBranch ?? 'main' },
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
  // Clear call history but PRESERVE the implementation set in the
  // module-mock factory above — the spy delegates to real
  // processWebhook so the new V1-hotfix / missing-base.ref tests
  // exercise the production fall-through, not a noop stub.
  mocks.processWebhookMock.mockClear();
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
    // handlePrClosed (linkedPr cleanup) ALSO fires once per node, so
    // the total updateNode count is 4 (2 linkedPr clears + 2 status
    // transitions). Filter to the status=done calls to assert on the
    // transition-specific behaviour this test cares about.
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(2);
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

  it('PR merged to a NON-default branch (V1-hotfix flow) does NOT transition', async () => {
    // Regression for the 2026-06-11 drift on crm #2291 / #2292: a
    // PR targeting `release/v1` (V1 hotfix) merged with `Fixes #2291`
    // in the body. GitHub does NOT auto-close issues when a PR merges
    // to anything other than the default branch, but this handler used
    // to transition the linked node to `done` anyway — desyncing
    // MindBlown ("done") from GitHub ("open") and blocking re-dispatch
    // on `main` until the forward-port PR landed.
    //
    // The default-branch gate mirrors GitHub's own judgement: only
    // transition when base.ref === repository.default_branch.
    const node = seedLinkedNode({ nodeId: 'n-2291', externalId: 'owner/repo#2291' });
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
      payload: prMergedPayload({
        number: 2346,
        title: 'fix(#2291): sanitize LLM upstream errors',
        body: '## Summary\n\nFixes #2291. Raw error messages were leaking internal hostnames.',
        baseRef: 'release/v1',
        defaultBranch: 'main',
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // handlePrClosed (separate handler) legitimately fires for ANY
    // merged PR to clear `linkedPr` — that's correct regardless of base
    // branch since the PR really is closed. What MUST NOT happen on a
    // non-default-branch merge is the status → done transition.
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(0);
    expect(mocks.broadcastMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'github_webhook_pr_merge' }),
    );
    // Falls through to processWebhook mock.
    expect(mocks.processWebhookMock).toHaveBeenCalled();
  });

  it('PR with missing base.ref does NOT transition status to done (fail-safe)', async () => {
    // Malformed or legacy payloads with no base.ref should NOT trigger
    // the status transition. Better to drop a real merge than to
    // wrongly transition a hotfix one — the drift audit (catchup) will
    // pick up any genuinely closed issue within 5min anyway.
    // handlePrClosed may still fire to clear linkedPr — that's fine.
    const node = seedLinkedNode({ nodeId: 'n-99', externalId: 'owner/repo#99' });
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
          number: 99,
          merged: true,
          html_url: 'https://github.com/owner/repo/pull/99',
          title: 'Closes #99',
          body: null,
          // base intentionally omitted
        },
        repository: { full_name: 'owner/repo', default_branch: 'main' },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const doneTransitionCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status === 'done',
    );
    expect(doneTransitionCalls).toHaveLength(0);
  });
});
