/**
 * issues.edited webhook × mirror-until-curated guard.
 *
 * `description` has two legitimate writers: the GH issue body (machine
 * mirror) and manual curation in MindBlown (business/audit notes). The
 * fall-through used to apply the webhook body blindly, wiping curation
 * wholesale.
 *
 * Ownership decision + hash mechanics: lib/descriptionMirror.ts. The
 * guard compares the node's description against what the MIRROR last
 * wrote (`link.descriptionMirrorHash`) — NOT against GitHub's prior
 * body, because outbound sync pushes curated text into the GH body and
 * a GH-side comparison would misread that curation as a mirror one
 * round-trip later. Legacy links without a hash fall back to prior-body
 * equality and get the hash stamped on their first applied edit.
 *
 * Also covered: title edits keep the `#NNNN ` prefix convention, and
 * no-op updates (edit storms on curated nodes) skip the write+broadcast.
 *
 * Harness mirrors pr-merge-webhook.test.ts: signature verification is
 * stubbed to pass, DB and node CRUD are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { computeBodyHash } from '../../lib/descriptionMirror.js';

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
  setExternalLinkState: vi.fn(async () => true),
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

const MIRROR_BODY = 'Original spec text from GitHub';
const NEW_BODY = 'Updated spec text from GitHub';

function linkedNode(opts: {
  description: unknown;
  text?: string;
  /** Stamp the link with the hash of this body ("what the mirror last wrote"). */
  mirrorOf?: string | null;
}) {
  return {
    id: 'n-1',
    mapId: 'map-1',
    status: 'todo',
    percentComplete: 0,
    text: opts.text ?? '#42 old title',
    description: opts.description,
    externalLinks: [
      {
        provider: 'github',
        externalId: 'owner/repo#42',
        url: 'https://github.com/owner/repo/issues/42',
        syncEnabled: true,
        lastSyncedAt: null,
        ...(opts.mirrorOf !== undefined
          ? { descriptionMirrorHash: computeBodyHash(opts.mirrorOf) }
          : {}),
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

function updatedFields(): Record<string, unknown> {
  expect(mocks.updateNodeMock).toHaveBeenCalledTimes(1);
  return mocks.updateNodeMock.mock.calls[0][1] as Record<string, unknown>;
}

describe('issues.edited × description guard (mirror-until-curated)', () => {
  it('mirrors the new body when the description is what the mirror last wrote', async () => {
    seed(linkedNode({ description: MIRROR_BODY, mirrorOf: MIRROR_BODY }));

    const res = await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));
    expect(res.statusCode).toBe(200);

    const fields = updatedFields();
    expect(fields.description).toBe(NEW_BODY);
    // The applied write re-stamps the hash for the NEW body.
    const links = fields.externalLinks as Array<{ descriptionMirrorHash?: string }>;
    expect(links[0].descriptionMirrorHash).toBe(computeBodyHash(NEW_BODY));
  });

  it('self-heals a mirror that missed an edit (hash still matches the old mirror write)', async () => {
    // Node still holds the mirror body from two edits ago; the webhook
    // for v2 was missed. The v2→v3 edit arrives with bodyFrom=v2 ≠ the
    // node's text — but the HASH still identifies the description as
    // mirror-written, so the node re-syncs instead of freezing.
    seed(linkedNode({ description: MIRROR_BODY, mirrorOf: MIRROR_BODY }));

    await postEdited(editedPayload({ bodyFrom: 'intermediate body v2' }));

    expect(updatedFields().description).toBe(NEW_BODY);
  });

  it('keeps curation sticky after the outbound write-back round-trip', async () => {
    // The critical case: curated string was pushed to the GH body by
    // outbound sync, so the NEXT GH edit arrives with bodyFrom ===
    // the curated text. A prior-body equality check would misread
    // this as a mirror and wipe the curation — the hash does not.
    const curated = 'Thomas-Review: SPG-02 bei 94%, Notizen siehe Anhang';
    seed(linkedNode({ description: curated, mirrorOf: MIRROR_BODY }));

    const res = await postEdited(editedPayload({ bodyFrom: curated }));
    expect(res.statusCode).toBe(200);

    for (const call of mocks.updateNodeMock.mock.calls) {
      expect(call[1]).not.toHaveProperty('description');
    }
  });

  it('fills an empty description', async () => {
    seed(linkedNode({ description: null, mirrorOf: MIRROR_BODY }));

    await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));

    expect(updatedFields().description).toBe(NEW_BODY);
  });

  it('legacy link without a hash: prior-body equality applies and stamps the hash', async () => {
    seed(linkedNode({ description: MIRROR_BODY }));

    await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));

    const fields = updatedFields();
    expect(fields.description).toBe(NEW_BODY);
    const links = fields.externalLinks as Array<{ descriptionMirrorHash?: string }>;
    expect(links[0].descriptionMirrorHash).toBe(computeBodyHash(NEW_BODY));
  });

  it('legacy link without a hash: curated string is left alone', async () => {
    seed(linkedNode({ description: 'hand-written notes' }));

    await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));

    for (const call of mocks.updateNodeMock.mock.calls) {
      expect(call[1]).not.toHaveProperty('description');
    }
  });

  it('leaves a ProseMirror-doc description alone (curated in the UI)', async () => {
    seed(
      linkedNode({
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: MIRROR_BODY }] }],
        },
        mirrorOf: MIRROR_BODY,
      }),
    );

    await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));

    for (const call of mocks.updateNodeMock.mock.calls) {
      expect(call[1]).not.toHaveProperty('description');
    }
  });

  it('skips the write entirely when nothing survives the guard (edit-storm no-op)', async () => {
    // Body-only edit on a curated node: description is dropped, the
    // (unchanged, re-prefixed) title equals node.text and is deduped —
    // no UPDATE, no node:updated fanout.
    seed(linkedNode({ description: 'curated', mirrorOf: MIRROR_BODY }));

    const res = await postEdited(editedPayload({ bodyFrom: MIRROR_BODY }));
    expect(res.json()).toMatchObject({ matched: true, skipped: 'no_change' });
    expect(mocks.updateNodeMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });
});

describe('issues.edited × title prefix preservation', () => {
  it('keeps the #NNNN prefix when the GH title changes', async () => {
    seed(linkedNode({ description: MIRROR_BODY, mirrorOf: MIRROR_BODY, text: '#42 old title' }));

    await postEdited(
      editedPayload({ titleFrom: 'old title', title: 'brand new title', bodyFrom: MIRROR_BODY }),
    );

    expect(updatedFields().text).toBe('#42 brand new title');
  });

  it('keeps the marker for a bare "#42" node title (auto-link shape)', async () => {
    seed(linkedNode({ description: MIRROR_BODY, mirrorOf: MIRROR_BODY, text: '#42' }));

    await postEdited(
      editedPayload({ titleFrom: 'old title', title: 'brand new title', bodyFrom: MIRROR_BODY }),
    );

    expect(updatedFields().text).toBe('#42 brand new title');
  });

  it('does not force a prefix onto nodes that never had one', async () => {
    seed(
      linkedNode({ description: MIRROR_BODY, mirrorOf: MIRROR_BODY, text: 'manually linked node' }),
    );

    await postEdited(
      editedPayload({ titleFrom: 'old title', title: 'brand new title', bodyFrom: MIRROR_BODY }),
    );

    expect(updatedFields().text).toBe('brand new title');
  });
});
