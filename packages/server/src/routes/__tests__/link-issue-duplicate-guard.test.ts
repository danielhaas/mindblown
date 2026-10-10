/**
 * POST /api/maps/:mapId/nodes/:nodeId/github/link (#314): one issue, one
 * node. Linking an issue another live node on the map already carries is a
 * 409 ISSUE_ALREADY_LINKED naming that node — unless allowDuplicate says
 * the second link is deliberate. Re-linking the same node stays allowed.
 *
 * Harness mirrors connect-map-binding.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  linkedRows: [] as Array<{ id: string; text: string; externalLinks: unknown[] }>,
  updateNode: vi.fn(),
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>('@mindblown/integrations');
  return {
    ...actual,
    isGitHubAppConfigured: vi.fn(() => false),
    getGitHubIssue: vi.fn(async () => ({ number: 39, html_url: 'https://git.test/dan/r/issues/39', state: 'open' })),
  };
});
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.linkedRows }) }) },
}));
vi.mock('../../db/schema.js', () => ({
  integrations: { __name: 'integrations' },
  versions: { __name: 'versions' },
  nodes: { __name: 'nodes' },
  maps: { __name: 'maps' },
  triageDecisions: { __name: 'triageDecisions' },
}));
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(async (id: string) => ({ id, mapId: 'm1', externalLinks: [] })),
  findMapNodesLinkingIssue: vi.fn(async () => mocks.linkedRows.map((r) => ({ id: r.id, text: r.text }))),
  createNode: vi.fn(),
  updateNode: (...a: unknown[]) => mocks.updateNode(...a),
  setExternalLinkState: vi.fn(),
  findNodeIdByExternalId: vi.fn(),
  notDeleted: { __pred: true },
}));
vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../auth.js', () => ({ requireAdmin: vi.fn(async () => true) }));
vi.mock('../../sync/parentEpicRollup.js', () => ({ rollupParentsForChildTitle: vi.fn() }));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(),
  ensureInboxNode: vi.fn(),
  ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(),
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
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => ({ owner: 'dan', repo: 'r', forge: { endpoint: { kind: 'gitea' } } })),
}));
vi.mock('../../lib/mapAccess.js', () => ({ guardMapRoutes: vi.fn(), requireMapAccess: async () => true }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { integrationRoutes } from '../integrations.js';

async function link(nodeId: string, extra: Record<string, unknown> = {}) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'u1';
  });
  await app.register(integrationRoutes);
  const res = await app.inject({
    method: 'POST',
    url: `/api/maps/m1/nodes/${nodeId}/github/link`,
    payload: { owner: 'dan', repo: 'r', issueNumber: 39, ...extra },
  });
  await app.close();
  return res;
}

const carrying = (id: string, text: string) => ({
  id,
  text,
  externalLinks: [{ provider: 'gitea', externalId: 'dan/r#39', url: 'u', syncEnabled: true, lastSyncedAt: null }],
});

beforeEach(() => {
  mocks.linkedRows = [];
  mocks.updateNode.mockReset();
  mocks.updateNode.mockImplementation(async (id: string, u: object) => ({ id, ...u }));
});

describe('link issue — one issue, one node (#314)', () => {
  it('refuses an issue another node already carries, naming that node; nothing is written', async () => {
    mocks.linkedRows = [carrying('other', 'Routed crossings lifted to VLANs')];
    const res = await link('n1');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ISSUE_ALREADY_LINKED', nodes: [{ id: 'other', text: 'Routed crossings lifted to VLANs' }] });
    expect(res.json().error.message).toContain('dan/r#39 is already linked to other "Routed crossings lifted to VLANs"');
    expect(mocks.updateNode).not.toHaveBeenCalled();
  });

  it('allowDuplicate links anyway; re-linking the node that already carries it is fine', async () => {
    mocks.linkedRows = [carrying('other', 'x')];
    expect((await link('n1', { allowDuplicate: true })).statusCode).toBe(200);
    mocks.linkedRows = [carrying('n1', 'me')];
    expect((await link('n1')).statusCode).toBe(200);
  });
});
