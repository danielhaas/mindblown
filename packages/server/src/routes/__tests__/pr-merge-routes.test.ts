/**
 * The PR merge routes — the real plugin, the service stubbed. What the
 * route owns: 401, the map guard (view to read, edit to merge, a node of
 * another map 404s), body parsing, the service call per route, a refusal
 * as 409 with both the result and the error envelope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const OTHER = 'oooo-oooo';

const summaryMock = vi.fn();
const mergeMock = vi.fn();
const waitingMock = vi.fn();
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));

vi.mock('../../services/prMerge.js', () => ({
  prSummary: (...a: unknown[]) => summaryMock(...a),
  mergePr: (...a: unknown[]) => mergeMock(...a),
  prsWaiting: (...a: unknown[]) => waitingMock(...a),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'foreign' ? OTHER : MAP) }));

import { prMergeRoutes } from '../prMerge.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId, authSource: 'api-key' });
  });
  await app.register(prMergeRoutes);
  return app;
}

beforeEach(() => {
  userId = 'u1';
  state.perm = { [MAP]: 'edit' };
  summaryMock.mockReset().mockResolvedValue({ number: 12, headSha: 'abc' });
  mergeMock.mockReset().mockResolvedValue({ merged: true, repo: 'o/r', number: 12 });
  waitingMock.mockReset().mockResolvedValue({ items: [], now: 'x' });
});

describe('PR merge routes', () => {
  it('401s without a user', async () => {
    userId = undefined;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/prs/waiting' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/pr/merge`, payload: { expectedHeadSha: 'abc' } })).statusCode).toBe(401);
  });

  it('pr_summary needs view; a node of another map 404s', async () => {
    state.perm = { [MAP]: 'view' };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP}/nodes/n1/pr` });
    expect(res.statusCode).toBe(200);
    expect(summaryMock).toHaveBeenCalledWith(MAP, 'n1');
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/nodes/foreign/pr` })).statusCode).toBe(404);
  });

  it('a service error keeps its status', async () => {
    summaryMock.mockResolvedValue({ status: 404, code: 'NO_PR', message: 'No open PR on record' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP}/nodes/n1/pr` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NO_PR', message: 'No open PR on record' } });
  });

  it('merge needs edit, and passes the user, the pinned sha (trimmed) and the method', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/pr/merge`, payload: { expectedHeadSha: ' abc1234 ', method: 'rebase' } });
    expect(res.statusCode).toBe(200);
    expect(mergeMock).toHaveBeenCalledWith('u1', MAP, 'n1', { expectedHeadSha: 'abc1234', method: 'rebase' });

    state.perm = { [MAP]: 'view' };
    mergeMock.mockClear();
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/pr/merge`, payload: { expectedHeadSha: 'abc' } })).statusCode).toBe(403);
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it('a refusal is a 409 with the result and the error envelope', async () => {
    mergeMock.mockResolvedValue({ merged: false, code: 'CI_RUNNING', message: 'CI is still running' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/pr/merge`, payload: { expectedHeadSha: 'abc1234' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ merged: false, code: 'CI_RUNNING', message: 'CI is still running', error: { code: 'CI_RUNNING', message: 'CI is still running' } });
  });

  it('prs_waiting: all maps, one map, one fleet', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/prs/waiting' });
    await app.inject({ method: 'GET', url: `/api/maps/${MAP}/prs/waiting` });
    await app.inject({ method: 'GET', url: '/api/fleets/f1/prs/waiting' });
    expect(waitingMock.mock.calls).toEqual([['u1', {}], ['u1', { mapId: MAP }], ['u1', { fleetId: 'f1' }]]);
  });
});
