/**
 * issues.reopened webhook × in-flight PR gate.
 *
 * The webhook state-sync and the catchup reconciler implement the SAME
 * policy for the "GitHub says open, node says done" transition — the
 * shared predicate is `prBlocksNodeReopen` (@mindblown/core). Before
 * this gate, the webhook path did the destructive fallback reset
 * (percentComplete → null via empty snapshot) that the catchup side
 * had already been fixed to refuse: webhook-connected repos wiped node
 * progress on reopen, catchup-only repos kept it.
 *
 * Harness mirrors pr-merge-webhook.test.ts: signature verification is
 * stubbed to pass, DB and node CRUD are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  updateNodeMock: vi.fn(),
  setExternalLinkStateMock: vi.fn(async () => true),
  selectNodesMock: vi.fn(),
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
    verifyWebhookSignature: mocks.verifySignatureMock,
    mintInstallationToken: vi.fn(),
    isGitHubAppConfigured: vi.fn(() => true),
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
  setExternalLinkState: mocks.setExternalLinkStateMock,
  // Moved out of routes/integrations.ts, where it was a second copy of
  // the same scan. Same behaviour, over this file's node rows.
  findNodeIdByExternalId: async (externalId: string) => {
    for (const row of await mocks.selectNodesMock()) {
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
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
  syncIssueLabelsToNodes: vi.fn(async () => 0),
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
vi.mock('../../sync/workStartSync.js', () => ({ markWorkStarted: vi.fn(async () => 0) }));
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
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

interface LinkOverrides {
  previousPercentComplete?: number | null;
  previousStatus?: string | null;
}

function doneNode(linkOverrides: LinkOverrides = {}, linkedPrState: string | null = 'open') {
  return {
    id: 'n-1',
    mapId: 'map-1',
    status: 'done',
    percentComplete: 100,
    externalLinks: [
      {
        provider: 'github',
        externalId: 'owner/repo#42',
        url: 'https://github.com/owner/repo/issues/42',
        syncEnabled: true,
        lastSyncedAt: null,
        state: 'closed',
        ...linkOverrides,
      },
    ],
    linkedPr:
      linkedPrState == null
        ? null
        : {
            number: 9,
            repo: 'owner/repo',
            url: 'u',
            head: 'h',
            base: 'main',
            author: null,
            draft: false,
            state: linkedPrState,
            mergeable: null,
            changedFiles: [],
            reviews: [],
            checks: { state: null, failures: [] },
            lastSyncedAt: null,
          },
  };
}

function reopenedPayload(): Record<string, unknown> {
  return {
    action: 'reopened',
    issue: {
      number: 42,
      title: 'the ticket',
      state: 'open',
      labels: [],
      assignees: [],
      body: null,
    },
    repository: { full_name: 'owner/repo' },
  };
}

beforeEach(() => {
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.setExternalLinkStateMock.mockReset();
  mocks.setExternalLinkStateMock.mockResolvedValue(true);
  mocks.selectNodesMock.mockReset();
  mocks.broadcastMock.mockReset();
  mocks.verifySignatureMock.mockReset();
  mocks.verifySignatureMock.mockResolvedValue(true);
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

async function postReopen() {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'x-github-event': 'issues',
      'x-hub-signature-256': 'sha256=anything',
    },
    payload: reopenedPayload(),
  });
  await app.close();
  return res;
}

describe('issues.reopened × in-flight PR (prBlocksNodeReopen parity with catchup)', () => {
  it('does NOT reset a done node while its PR is in flight and no snapshot exists', async () => {
    const node = doneNode({}, 'open');
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue(node);

    const res = await postReopen();
    expect(res.statusCode).toBe(200);
    expect(res.json().skipped).toBe('pr_in_flight');

    // The link mirror is refreshed via setExternalLinkState (no
    // revision bump → requirement acceptances stay valid); no node
    // write happens at all.
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    expect(mocks.setExternalLinkStateMock).toHaveBeenCalledWith(
      'n-1',
      'owner/repo#42',
      'open',
    );
  });

  it('restores from the snapshot even while the PR is in flight', async () => {
    const node = doneNode(
      { previousPercentComplete: 40, previousStatus: 'in_progress' },
      'open',
    );
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue(node);

    const res = await postReopen();
    expect(res.statusCode).toBe(200);

    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.percentComplete).toBe(40);
    expect(fields.status).toBe('in_progress');
  });

  it('resets with the fallback when no PR is linked (legacy behavior)', async () => {
    const node = doneNode({}, null);
    mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
    mocks.getNodeMock.mockResolvedValue(node);
    mocks.updateNodeMock.mockResolvedValue(node);

    const res = await postReopen();
    expect(res.statusCode).toBe(200);

    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.percentComplete).toBeNull();
    expect(fields.status).toBe('in_progress');
  });
});
