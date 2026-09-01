/**
 * #245 — work-start sync: inbound "someone started working on this
 * ticket" signals flip the linked node into the map's in-progress
 * status, so the kanban board shows in-flight work instead of leaving
 * it in Unset/Todo until the PR merges.
 *
 * Exercises the REAL `markWorkStarted` (sync/workStartSync.ts) through
 * the webhook route:
 *
 *   1. pull_request.opened with `Closes #N` → linked node (no status)
 *      transitions to `in_progress` and broadcasts.
 *   2. pull_request.synchronize re-covers PRs opened before this
 *      feature existed (self-heal on next push).
 *   3. Done nodes are never downgraded by PR activity.
 *   4. issues.assigned transitions the node AND still applies the
 *      assignee list via the processWebhook fall-through.
 *
 * Guard-matrix coverage (custom workflows, unknown statuses, 100%%
 * nodes) lives in sync/__tests__/workStartSync.test.ts — this file
 * covers the route wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const DEFAULT_WORKFLOW = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
];

const mocks = vi.hoisted(() => ({
  // Per-table select dispatch: workStartSync reads `nodes` and `maps`,
  // the route's signature loop reads `integrations`.
  nodeRowsMock: vi.fn((): unknown[] => []),
  mapRowsMock: vi.fn((): unknown[] => []),
  getNodeMock: vi.fn(),
  updateNodeMock: vi.fn(),
  broadcastMock: vi.fn(),
  verifySignatureMock: vi.fn(async () => true),
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>(
    '@mindblown/integrations',
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
  };
});

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: (table: { __name?: string } | undefined) => ({
        where: async () => {
          if (table?.__name === 'maps') return mocks.mapRowsMock();
          if (table?.__name === 'nodes') return mocks.nodeRowsMock();
          return [];
        },
      }),
    }),
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
  getNode: mocks.getNodeMock,
  createNode: vi.fn(),
  updateNode: mocks.updateNodeMock,
  // The webhook's node lookup moved into db/nodes.js (it used to be a
  // second copy inside routes/integrations.ts). Reproduce the real scan
  // over this file's own node rows so the route keeps resolving nodes
  // exactly as before.
  findNodeIdByExternalId: async (externalId: string) => {
    const rows = (await mocks.nodeRowsMock()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const links = (row.externalLinks ?? []) as Array<{ provider: string; externalId: string }>;
      if (links.some((l) => l.provider === 'github' && l.externalId === externalId)) {
        return row.id as string;
      }
    }
    return null;
  },
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
  ingestNewIssuesForRepo: vi.fn(async () => ({ created: 0, errored: 0 })),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
  syncIssueLabelsToNodes: vi.fn(),
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
// linkedPr mirroring has its own tests — stub it so PR events exercise
// only the work-start path here.
vi.mock('../../sync/prSync.js', () => ({
  handlePrSnapshot: vi.fn(async () => 0),
  handleReviewSubmitted: vi.fn(async () => 0),
  handleCheckSuiteCompleted: vi.fn(async () => 0),
  handlePrClosed: vi.fn(async () => 0),
  parseClosesIssues: vi.fn(() => []),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ __pred: true, check: () => true })),
  and: vi.fn(() => ({ __pred: true, check: () => true })),
}));

import { integrationRoutes } from '../integrations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(integrationRoutes);
  return app;
}

interface SeedOpts {
  nodeId: string;
  externalId: string;
  status?: string | null;
  percentComplete?: number | null;
}

function seedNode(opts: SeedOpts): void {
  const row = {
    id: opts.nodeId,
    mapId: 'map-1',
    status: opts.status ?? null,
    percentComplete: opts.percentComplete ?? null,
    externalLinks: [
      {
        provider: 'github',
        externalId: opts.externalId,
        url: `https://github.com/${opts.externalId.replace('#', '/issues/')}`,
        syncEnabled: true,
        lastSyncedAt: null,
      },
    ],
  };
  mocks.nodeRowsMock.mockReturnValue([row]);
  mocks.mapRowsMock.mockReturnValue([{ statusWorkflow: DEFAULT_WORKFLOW }]);
  mocks.getNodeMock.mockResolvedValue(row);
  mocks.updateNodeMock.mockImplementation(
    async (id: string, updates: Record<string, unknown>) => ({ ...row, ...updates }),
  );
}

function prPayload(action: string, body: string | null): Record<string, unknown> {
  return {
    action,
    pull_request: {
      number: 42,
      merged: false,
      draft: false,
      state: 'open',
      html_url: 'https://github.com/owner/repo/pull/42',
      title: 'feat: thing',
      body,
      head: { ref: 'feat/thing', sha: 'abc123' },
      base: { ref: 'main' },
      user: { login: 'session-bot' },
      mergeable: null,
    },
    repository: { full_name: 'owner/repo', default_branch: 'main' },
  };
}

function post(app: FastifyInstance, event: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': 'sha256=anything',
    },
    payload,
  });
}

function statusCalls(): Array<[string, Record<string, unknown>]> {
  return mocks.updateNodeMock.mock.calls.filter(
    (call: unknown[]) => (call[1] as Record<string, unknown> | undefined)?.status !== undefined,
  ) as Array<[string, Record<string, unknown>]>;
}

beforeEach(() => {
  mocks.nodeRowsMock.mockReset().mockReturnValue([]);
  mocks.mapRowsMock.mockReset().mockReturnValue([]);
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.broadcastMock.mockReset();
  mocks.verifySignatureMock.mockReset().mockResolvedValue(true);
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

describe('webhook: work-start sync (#245)', () => {
  it('pull_request.opened with Closes #N flips a status-less node to in_progress', async () => {
    seedNode({ nodeId: 'n-7', externalId: 'owner/repo#7' });

    const app = await buildApp();
    const res = await post(app, 'pull_request', prPayload('opened', 'Closes #7'));
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(statusCalls()).toEqual([['n-7', { status: 'in_progress' }]]);
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({
        type: 'node:updated',
        nodeId: 'n-7',
        source: 'github_webhook_pr_open',
      }),
    );
  });

  it('pull_request.synchronize also triggers the transition (self-heal for older PRs)', async () => {
    seedNode({ nodeId: 'n-8', externalId: 'owner/repo#8', status: 'todo' });

    const app = await buildApp();
    const res = await post(app, 'pull_request', prPayload('synchronize', 'fixes #8'));
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(statusCalls()).toEqual([['n-8', { status: 'in_progress' }]]);
  });

  it('never downgrades a done node on PR activity', async () => {
    seedNode({
      nodeId: 'n-9',
      externalId: 'owner/repo#9',
      status: 'done',
      percentComplete: 100,
    });

    const app = await buildApp();
    const res = await post(app, 'pull_request', prPayload('opened', 'Closes #9'));
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(statusCalls()).toEqual([]);
  });

  it('issues.assigned flips the node and still applies assigneeIds', async () => {
    seedNode({ nodeId: 'n-10', externalId: 'owner/repo#10' });

    const app = await buildApp();
    const res = await post(app, 'issues', {
      action: 'assigned',
      issue: {
        id: 1010,
        number: 10,
        title: 'MAN-14 1/5',
        body: null,
        state: 'open',
        labels: [],
        assignees: [{ login: 'session-bot', id: 99 }],
        milestone: null,
        html_url: 'https://github.com/owner/repo/issues/10',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-23T00:00:00Z',
      },
      assignee: { login: 'session-bot', id: 99 },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(statusCalls()).toEqual([['n-10', { status: 'in_progress' }]]);
    // processWebhook fall-through still syncs the assignee list.
    const assigneeCalls = mocks.updateNodeMock.mock.calls.filter(
      (call: unknown[]) =>
        (call[1] as Record<string, unknown> | undefined)?.assigneeIds !== undefined,
    );
    expect(assigneeCalls).toEqual([['n-10', { assigneeIds: ['session-bot'] }]]);
  });
});
