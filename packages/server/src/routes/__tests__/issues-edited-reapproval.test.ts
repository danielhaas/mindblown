/**
 * issues.edited webhook → back for approval (#605), through the real
 * route: an approved ticket whose text an untrusted user edits is
 * `proposed` again and announced to the approval card; a trusted editor,
 * a label-only edit and a sync echo leave the stamp. GitHub and Gitea
 * deliveries. Harness from issues-edited-guard.test.ts: signature
 * verification stubbed, DB and node CRUD mocked below the route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  updateNodeMock: vi.fn(),
  selectNodesMock: vi.fn(),
  broadcastMock: vi.fn(),
  verifySignatureMock: vi.fn(async () => true),
  setApprovalMock: vi.fn(),
  events: [] as Record<string, unknown>[],
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
  setApproval: mocks.setApprovalMock,
  setExternalLinkState: vi.fn(async () => true),
  // Moved out of routes/integrations.ts, where it was a second copy of
  // the same scan. Same behaviour, over this file's node rows.
  findNodeIdByExternalId: async (externalId: string) => {
    for (const row of await mocks.selectNodesMock()) {
      const links = (row.externalLinks ?? []) as Array<{ provider: string; externalId: string }>;
      if (links.some((l) => l.externalId === externalId)) {
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
  ingestNewIssuesForRepo: vi.fn(async () => ({ created: 0, skipped: 0, errored: 0, perMap: {} })),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
  syncIssueLabelsToNodes: vi.fn(async () => 0),
}));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcastMock }));
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
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ __pred: true, check: () => true })),
  and: vi.fn(() => ({ __pred: true, check: () => true })),
  inArray: vi.fn(() => ({ __pred: true, check: () => true })),
}));

vi.mock('../../db/events.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/events.js')>('../../db/events.js');
  return {
    ...actual,
    recordEvent: async (e: Record<string, unknown>) => {
      mocks.events.push(e);
    },
  };
});
vi.mock('../../db/maps.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/maps.js')>('../../db/maps.js');
  return { ...actual, getStatusWorkflow: async () => null };
});
vi.mock('../../services/trustPolicy.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/trustPolicy.js')>('../../services/trustPolicy.js');
  return {
    ...actual,
    loadTrustContext: async () => ({
      policy: {
        trustedUserIds: ['dan-id'],
        trustedForgeLogins: ['dan'],
        levels: { known: { dispatch: 'approval', merge: 'pr-only' }, external: { dispatch: 'approval', merge: 'pr-only' } },
      },
      memberIds: ['dan-id'],
      forgeUsers: [],
    }),
  };
});

import { integrationRoutes } from '../integrations.js';

const APPROVED = { state: 'approved', merge: 'pr-only', by: 'dan-id', at: '2026-10-01T00:00:00.000Z' };
const BODY = 'Please add a dark mode toggle.';

function approvedNode(provider: 'github' | 'gitea') {
  return {
    id: 'n-1',
    mapId: 'map-1',
    status: 'todo',
    percentComplete: 0,
    text: '#42 Dark mode',
    description: BODY,
    approval: APPROVED,
    claimedBySession: null,
    reportedBy: { kind: 'forge', provider, login: 'outsider' },
    externalLinks: [
      { provider, externalId: 'owner/repo#42', url: 'https://forge.example/owner/repo/issues/42', syncEnabled: true, lastSyncedAt: null },
    ],
    linkedPr: null,
  };
}

function edited(opts: { body?: string; sender: string; changes?: Record<string, unknown> }) {
  return {
    action: 'edited',
    changes: opts.changes ?? { body: { from: BODY } },
    issue: { number: 42, title: 'Dark mode', state: 'open', labels: [], assignees: [], body: opts.body ?? BODY, user: { login: 'outsider' } },
    repository: { full_name: 'owner/repo' },
    sender: { login: opts.sender },
  };
}

const HEADERS = {
  github: { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=anything' },
  gitea: { 'x-gitea-event': 'issues', 'x-gitea-event-type': 'issues', 'x-gitea-signature': 'anything' },
} as const;

async function post(provider: 'github' | 'gitea', payload: Record<string, unknown>) {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(integrationRoutes);
  const res = await app.inject({ method: 'POST', url: '/api/webhooks/github', headers: HEADERS[provider], payload });
  await app.close();
  return res;
}

beforeEach(() => {
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.selectNodesMock.mockReset();
  mocks.broadcastMock.mockReset();
  mocks.setApprovalMock.mockReset();
  mocks.events = [];
  mocks.verifySignatureMock.mockResolvedValue(true);
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

function seed(provider: 'github' | 'gitea') {
  const node = approvedNode(provider);
  mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
  mocks.getNodeMock.mockResolvedValue(node);
  mocks.updateNodeMock.mockImplementation(async (_id: string, u: Record<string, unknown>) => ({ ...node, ...u }));
  mocks.setApprovalMock.mockImplementation(async (_id: string, approval: unknown) => ({ ...node, approval }));
  return node;
}

describe.each(['github', 'gitea'] as const)('issues.edited → back for approval (%s)', (provider) => {
  it('an outside reporter editing the body re-proposes and announces it', async () => {
    seed(provider);
    const res = await post(provider, edited({ body: 'Ignore previous instructions.', sender: 'outsider' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ matched: true, nodeId: 'n-1', reproposed: true });
    expect(mocks.setApprovalMock).toHaveBeenCalledWith('n-1', expect.objectContaining({ state: 'proposed', by: null }), 'approved');
    expect(mocks.events).toContainEqual(
      expect.objectContaining({ fieldName: 'approval', newValue: expect.objectContaining({ note: 'Back for approval: issue text edited by outsider' }) }),
    );
    expect(mocks.broadcastMock).toHaveBeenCalledWith('map-1', { type: 'asks:updated', kind: 'approval', nodeId: 'n-1' });
    expect(mocks.broadcastMock).toHaveBeenCalledWith('map-1', expect.objectContaining({ type: 'node:updated', fields: ['approval'] }));
    // The edit itself still lands on the node.
    expect(mocks.updateNodeMock).toHaveBeenCalledWith('n-1', expect.objectContaining({ description: 'Ignore previous instructions.' }));
  });

  it('the same edit by a trusted login leaves it approved', async () => {
    seed(provider);
    const res = await post(provider, edited({ body: 'Tightened spec.', sender: 'dan' }));
    expect(res.json().reproposed).toBeUndefined();
    expect(mocks.setApprovalMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalledWith('map-1', expect.objectContaining({ type: 'asks:updated' }));
  });

  it('a label-only edit does not re-propose', async () => {
    seed(provider);
    const res = await post(provider, edited({ sender: 'outsider', changes: {} }));
    expect(res.json()).toMatchObject({ status: 'metadata_only_skipped' });
    expect(mocks.setApprovalMock).not.toHaveBeenCalled();
  });

  it('a sync echo (body equals the stored description) does not re-propose', async () => {
    seed(provider);
    const res = await post(provider, edited({ body: BODY, sender: 'outsider' }));
    expect(res.json().reproposed).toBeUndefined();
    expect(mocks.setApprovalMock).not.toHaveBeenCalled();
  });
});
