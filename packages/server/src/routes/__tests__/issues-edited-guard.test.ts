/**
 * issues.edited webhook × mirror-until-curated guard.
 *
 * `description` has two legitimate writers: the GH issue body (machine
 * mirror) and manual curation in MindBlown (business/audit notes). The
 * fall-through used to apply the webhook body blindly, wiping curation
 * wholesale. The guard tells the two apart via the PRE-edit body the
 * payload carries in `changes.body.from`: a node description equal to
 * the old body (or empty) is an unmodified mirror and keeps mirroring;
 * anything else is MB-owned from then on.
 *
 * Also covered: title edits must keep the `#NNNN ` prefix convention
 * (`#N <title>` is what ingest writes and what search/auto-link parse).
 *
 * Harness mirrors pr-merge-webhook.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  updateNodeMock: vi.fn(),
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

const OLD_BODY = 'Original spec text from GitHub';
const NEW_BODY = 'Updated spec text from GitHub';

function linkedNode(description: unknown, text = '#42 old title') {
  return {
    id: 'n-1',
    mapId: 'map-1',
    status: 'todo',
    percentComplete: 0,
    text,
    description,
    externalLinks: [
      {
        provider: 'github',
        externalId: 'owner/repo#42',
        url: 'https://github.com/owner/repo/issues/42',
        syncEnabled: true,
        lastSyncedAt: null,
      },
    ],
    linkedPr: null,
  };
}

function editedPayload(opts: {
  bodyFrom?: string;
  titleFrom?: string;
  title?: string;
  body?: string | null;
}): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (opts.bodyFrom !== undefined) changes.body = { from: opts.bodyFrom };
  if (opts.titleFrom !== undefined) changes.title = { from: opts.titleFrom };
  return {
    action: 'edited',
    changes,
    issue: {
      number: 42,
      title: opts.title ?? 'old title',
      state: 'open',
      labels: [],
      assignees: [],
      body: opts.body === undefined ? NEW_BODY : opts.body,
    },
    repository: { full_name: 'owner/repo' },
  };
}

beforeEach(() => {
  mocks.getNodeMock.mockReset();
  mocks.updateNodeMock.mockReset();
  mocks.selectNodesMock.mockReset();
  mocks.broadcastMock.mockReset();
  mocks.verifySignatureMock.mockReset();
  mocks.verifySignatureMock.mockResolvedValue(true);
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
});

async function postEdited(payload: Record<string, unknown>) {
  const app = await buildApp();
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
  return res;
}

function seed(node: ReturnType<typeof linkedNode>) {
  mocks.selectNodesMock.mockResolvedValue([{ id: node.id, externalLinks: node.externalLinks }]);
  mocks.getNodeMock.mockResolvedValue(node);
  mocks.updateNodeMock.mockResolvedValue(node);
}

describe('issues.edited × description guard (mirror-until-curated)', () => {
  it('mirrors the new body onto an unmodified-mirror description', async () => {
    seed(linkedNode(OLD_BODY));

    const res = await postEdited(editedPayload({ bodyFrom: OLD_BODY }));
    expect(res.statusCode).toBe(200);

    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.description).toBe(NEW_BODY);
  });

  it('fills an empty description', async () => {
    seed(linkedNode(null));

    await postEdited(editedPayload({ bodyFrom: OLD_BODY }));

    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.description).toBe(NEW_BODY);
  });

  it('leaves a curated string description alone', async () => {
    seed(linkedNode('Thomas-Review: SPG-02 bei 94%, Notizen siehe Anhang'));

    const res = await postEdited(editedPayload({ bodyFrom: OLD_BODY }));
    expect(res.statusCode).toBe(200);

    const calls = mocks.updateNodeMock.mock.calls;
    for (const call of calls) {
      expect(call[1]).not.toHaveProperty('description');
    }
  });

  it('leaves a ProseMirror-doc description alone (curated in the UI)', async () => {
    seed(
      linkedNode({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: OLD_BODY }] }],
      }),
    );

    await postEdited(editedPayload({ bodyFrom: OLD_BODY }));

    for (const call of mocks.updateNodeMock.mock.calls) {
      expect(call[1]).not.toHaveProperty('description');
    }
  });

  it('still applies the title while dropping the curated description', async () => {
    seed(linkedNode('curated'));

    const res = await postEdited(editedPayload({ bodyFrom: OLD_BODY }));
    expect(res.json().matched).toBe(true);

    expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('description');
    expect(fields).toHaveProperty('text');
  });
});

describe('issues.edited × title prefix preservation', () => {
  it('keeps the #NNNN prefix when the GH title changes', async () => {
    seed(linkedNode(OLD_BODY, '#42 old title'));

    await postEdited(
      editedPayload({ titleFrom: 'old title', title: 'brand new title', bodyFrom: OLD_BODY }),
    );

    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.text).toBe('#42 brand new title');
  });

  it('does not force a prefix onto nodes that never had one', async () => {
    seed(linkedNode(OLD_BODY, 'manually linked node'));

    await postEdited(
      editedPayload({ titleFrom: 'old title', title: 'brand new title', bodyFrom: OLD_BODY }),
    );

    const fields = mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.text).toBe('brand new title');
  });
});
