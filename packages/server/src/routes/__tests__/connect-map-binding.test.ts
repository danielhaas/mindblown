/**
 * POST /api/integrations/github/connect with `mapId` (#421): the map the
 * connect comes from is bound to the repo — after the checks, and only
 * after them. A refused map stores nothing.
 *
 * Harness mirrors issues-reopen-gate.test.ts (DB, sync and node layers
 * mocked); the binding helpers and the access check are spied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  dbWrites: [] as string[],
  bindable: vi.fn(),
  bindMap: vi.fn(),
  mapAccess: vi.fn(),
  setUpWebhook: vi.fn(),
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>('@mindblown/integrations');
  return { ...actual, isGitHubAppConfigured: vi.fn(() => false) };
});

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          mocks.dbWrites.push('update');
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => {
          mocks.dbWrites.push('insert');
          return [{ id: 'int-new' }];
        },
      }),
    }),
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
vi.mock('../../lib/githubContext.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));
vi.mock('../../lib/forge.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/forge.js');
  return { ...actual, mapBindableToWorkspaceForge: mocks.bindable, bindMapToForgeRepo: mocks.bindMap };
});
vi.mock('../../lib/mapAccess.js', () => ({
  guardMapRoutes: vi.fn(),
  requireMapAccess: async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }, ...rest: unknown[]) => {
    const ok = await mocks.mapAccess(...rest);
    if (!ok) reply.status(403).send({ error: { code: 'FORBIDDEN' } });
    return ok;
  },
}));
vi.mock('../../lib/forgeWebhook.js', () => ({
  publicWebhookUrl: () => 'https://mb.test/api/webhooks/github',
  setUpWebhookAfterBind: mocks.setUpWebhook,
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { integrationRoutes } from '../integrations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'u1';
  });
  await app.register(integrationRoutes);
  return app;
}

const BODY = { workspaceId: 'ws', token: 't', owner: 'dan', repo: 'product', kind: 'gitea', apiBaseUrl: 'https://git.test', mapId: 'm1' };

beforeEach(() => {
  mocks.dbWrites.length = 0;
  vi.clearAllMocks();
  mocks.mapAccess.mockResolvedValue(true);
  mocks.bindable.mockResolvedValue({ ok: true });
  mocks.setUpWebhook.mockResolvedValue({ status: 'created', hookId: 1, url: 'u', events: [] });
});

describe('connect with mapId (#421)', () => {
  it('binds the map it came from to the repo', async () => {
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/integrations/github/connect', payload: BODY });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ boundMapId: 'm1' });
    expect(mocks.bindMap).toHaveBeenCalledWith('m1', 'dan', 'product');
    expect(mocks.mapAccess).toHaveBeenCalledWith('m1', 'admin');
  });

  it('without admin on the map: 403 and nothing stored', async () => {
    mocks.mapAccess.mockResolvedValue(false);
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/integrations/github/connect', payload: BODY });
    expect(res.statusCode).toBe(403);
    expect(mocks.dbWrites).toEqual([]);
    expect(mocks.bindMap).not.toHaveBeenCalled();
  });

  it('a map of another workspace or an App-bound map: 400 and nothing stored', async () => {
    mocks.bindable.mockResolvedValue({ ok: false, reason: 'this map is bound through the GitHub App' });
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/integrations/github/connect', payload: BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/GitHub App/);
    expect(mocks.dbWrites).toEqual([]);
    expect(mocks.bindMap).not.toHaveBeenCalled();
  });

  it('without mapId the connection is stored and no map is bound', async () => {
    const { mapId: _omit, ...noMap } = BODY;
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/integrations/github/connect', payload: noMap });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ boundMapId: null });
    expect(mocks.bindMap).not.toHaveBeenCalled();
    expect(mocks.mapAccess).not.toHaveBeenCalled();
  });
});
