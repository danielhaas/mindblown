/**
 * The reporter's check routes — the real plugin, the service stubbed. What
 * the route owns: 401, the map guard (view to list, edit to signal or
 * decide, a node of another map 404s), the service call per route, that
 * an API key may signal a deploy but not decide a reply, and the fan-out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const OTHER = 'oooo-oooo';

const listMock = vi.fn();
const deployedMock = vi.fn();
const reopenMock = vi.fn();
const closeMock = vi.fn();
const broadcastMock = vi.fn();
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));

vi.mock('../../services/reporterCheck.js', () => ({
  listReporterChecks: (...a: unknown[]) => listMock(...a),
  markDeployed: (...a: unknown[]) => deployedMock(...a),
  reopenAfterCheck: (...a: unknown[]) => reopenMock(...a),
  closeAfterCheck: (...a: unknown[]) => closeMock(...a),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'foreign' ? OTHER : MAP) }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));

import { reporterChecksRoutes } from '../reporterChecks.js';

let userId: string | undefined = 'u1';
let auth: { authSource: 'jwt' | 'api-key'; actor?: 'person' | 'agent' } = { authSource: 'jwt' };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId, ...auth });
  });
  await app.register(reporterChecksRoutes);
  return app;
}

const node = { id: 'n1', mapId: MAP };

beforeEach(() => {
  userId = 'u1';
  auth = { authSource: 'jwt' };
  state.perm = { [MAP]: 'edit' };
  listMock.mockReset().mockResolvedValue({ items: [], now: 'x' });
  deployedMock.mockReset().mockResolvedValue({ asked: [{ nodeId: 'n1', issue: 'o/r#1' }], failed: [] });
  reopenMock.mockReset().mockResolvedValue({ node, changedFields: ['status'], writes: [{ kind: 'comment', target: 'o/r#1', done: true }] });
  closeMock.mockReset().mockResolvedValue({ node, changedFields: [], writes: [{ kind: 'close', target: 'o/r#1', done: false, error: 'boom' }] });
  broadcastMock.mockClear();
});

describe('reporter check routes', () => {
  it('401s without a user', async () => {
    userId = undefined;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/reporter-checks' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/deployed` })).statusCode).toBe(401);
  });

  it('lists by map, by fleet, or over all the reader\'s maps', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/reporter-checks' });
    await app.inject({ method: 'GET', url: `/api/maps/${MAP}/reporter-checks` });
    await app.inject({ method: 'GET', url: '/api/fleets/f1/reporter-checks' });
    expect(listMock.mock.calls.map((c) => c[1])).toEqual([{}, { mapId: MAP }, { fleetId: 'f1' }]);
  });

  it('deployed: an API key may signal it (a deploy script), needs edit, and tells open cards', async () => {
    auth = { authSource: 'api-key', actor: 'agent' };
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/deployed` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ asked: [{ issue: 'o/r#1' }], ok: true });
    expect(deployedMock).toHaveBeenCalledWith(MAP);
    expect(broadcastMock).toHaveBeenCalledWith(MAP, expect.objectContaining({ type: 'asks:updated', kind: 'reporter-check' }));

    state.perm = { [MAP]: 'view' };
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/deployed` })).statusCode).toBe(403);
  });

  it('reopen and close need a web session', async () => {
    auth = { authSource: 'api-key', actor: 'agent' };
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reporter-check/reopen`, payload: { note: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CHECK_NEEDS_SESSION');
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reporter-check/close` })).statusCode).toBe(403);
    expect(reopenMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('reopen forwards the note and announces the node; close reports a failed write', async () => {
    const app = await buildApp();
    const r1 = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reporter-check/reopen`, payload: { note: 'still broken', extra: 1 } });
    expect(reopenMock).toHaveBeenCalledWith('u1', MAP, 'n1', { note: 'still broken' });
    expect(r1.json()).toMatchObject({ ok: true });
    expect(broadcastMock).toHaveBeenCalledWith(MAP, expect.objectContaining({ type: 'node:updated', nodeId: 'n1', fields: ['status'] }));
    const r2 = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reporter-check/close` });
    expect(r2.json()).toMatchObject({ ok: false });
  });

  it('maps a service error to its status, and 404s a node of another map', async () => {
    closeMock.mockResolvedValue({ status: 409, code: 'NOT_OPEN', message: 'still waiting' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reporter-check/close` });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/foreign/reporter-check/close` })).statusCode).toBe(404);
  });
});
