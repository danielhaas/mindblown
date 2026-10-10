/**
 * POST /api/maps/:mapId/github/audit-closed-issues lets robots in (#315 —
 * it is the audit_closed_issues MCP tool's route) but only ever as a dry
 * run: write mode reopens tickets and rolls nodes back, so a leaked admin
 * key must not reach it with `dryRun: false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({ audit: vi.fn(async () => ({ condemned: [], reopened: [] })) }));

vi.mock('../../sync/closedIssueAudit.js', () => ({ auditClosedIssues: mocks.audit }));
vi.mock('../../auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../auth.js');
  return { ...actual, requireAdmin: vi.fn(async () => true) };
});
vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: vi.fn(async () => ({ owner: 'o', repo: 'r', token: 't', forge: {} })),
}));
vi.mock('../../lib/mapAccess.js', () => ({ guardMapRoutes: vi.fn(), requireMapAccess: vi.fn(async () => true) }));
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}));
vi.mock('../../db/schema.js', () => ({
  integrations: {}, versions: {}, nodes: {}, maps: {}, triageDecisions: {}, users: {},
}));
vi.mock('../../db/nodes.js', () => ({
  getNode: vi.fn(), createNode: vi.fn(), updateNode: vi.fn(), setExternalLinkState: vi.fn(),
  findNodeIdByExternalId: vi.fn(), notDeleted: {},
}));
vi.mock('../../sync/githubCatchup.js', () => ({ reconcileRepo: vi.fn() }));
vi.mock('../../sync/driftAudit.js', () => ({ runDriftAudit: vi.fn() }));
vi.mock('../../sync/webhookAuthCheck.js', () => ({ recordWebhookCall: vi.fn() }));
vi.mock('../../sync/parentEpicRollup.js', () => ({ rollupParentsForChildTitle: vi.fn() }));
vi.mock('../../sync/githubIngest.js', () => ({
  ingestNewIssuesForRepo: vi.fn(), ensureInboxNode: vi.fn(), ensureNodeForIssue: vi.fn(),
  findNodesByExternalIds: vi.fn(), syncIssueLabelsToNodes: vi.fn(async () => 0),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../sync/triage.js', () => ({
  triageAvailable: () => true, triageIssue: vi.fn(), clearTriageDebounce: vi.fn(),
  computeInputHash: vi.fn(), markTriageDebounce: vi.fn(), isWithinDebounceWindow: vi.fn(() => false),
}));
vi.mock('../../sync/mapContext.js', () => ({ buildMapContext: vi.fn() }));
vi.mock('../../sync/triageHistory.js', () => ({ recordTriageHistory: vi.fn() }));
vi.mock('../../sync/triageLabelWriteback.js', () => ({ applyTriageLabel: vi.fn() }));
vi.mock('../../sync/workStartSync.js', () => ({ markWorkStarted: vi.fn(async () => 0) }));

import { integrationRoutes } from '../integrations.js';

async function buildApp(who: { authSource: 'jwt' | 'api-key'; actor: 'person' | 'agent' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'u1';
    req.authSource = who.authSource;
    req.actor = who.actor;
  });
  await app.register(integrationRoutes);
  return app;
}

const post = (app: FastifyInstance) =>
  app.inject({ method: 'POST', url: '/api/maps/m1/github/audit-closed-issues', payload: { dryRun: false } });

beforeEach(() => mocks.audit.mockClear());

describe('audit-closed-issues write mode (#315)', () => {
  it.each([
    ['an API key', { authSource: 'api-key', actor: 'agent' }],
    ['the /mcp loopback or a long-lived token', { authSource: 'jwt', actor: 'agent' }],
  ] as const)('%s asking for dryRun:false still gets a dry run', async (_label, who) => {
    const app = await buildApp(who);
    const res = await post(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('an admin\'s web session gets write mode when it asks for it', async () => {
    const app = await buildApp({ authSource: 'jwt', actor: 'person' });
    const res = await post(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });
});
