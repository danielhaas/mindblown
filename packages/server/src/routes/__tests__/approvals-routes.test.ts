/**
 * Approval routes (#494) — the real plugin, the service stubbed. What the
 * route owns: 401 without a user, the map guard (view to list, edit to
 * decide, a node of another map is a 404), which service call each route
 * makes with which body, error → status, and the fan-out after a decision
 * (node:updated + asks:updated, forge sync only for an edited description).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const OTHER = 'oooo-oooo';

const listMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
const syncMock = vi.fn(async () => {});
const broadcastMock = vi.fn();
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));

vi.mock('../../services/approvals.js', () => ({
  listPendingApprovals: (...a: unknown[]) => listMock(...a),
  approveTicket: (...a: unknown[]) => approveMock(...a),
  rejectTicket: (...a: unknown[]) => rejectMock(...a),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'foreign' ? OTHER : MAP) }));
vi.mock('../nodes.js', () => ({ syncNodeToGitHub: (...a: unknown[]) => syncMock(...(a as [])) }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));

import { approvalsRoutes } from '../approvals.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId });
  });
  await app.register(approvalsRoutes);
  return app;
}

const node = { id: 'n1', mapId: MAP, approval: { state: 'approved', merge: 'pr-only', by: 'u1', at: '2026-10-29T02:00:00Z' } };

beforeEach(() => {
  userId = 'u1';
  state.perm = { [MAP]: 'edit' };
  listMock.mockReset().mockResolvedValue({ items: [], now: 'x' });
  approveMock.mockReset().mockResolvedValue({ node, changedFields: ['approval'], writes: [] });
  rejectMock.mockReset();
  syncMock.mockClear();
  broadcastMock.mockClear();
});

describe('approval routes', () => {
  it('401s without a user', async () => {
    userId = undefined;
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/approvals' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/approve`, payload: {} })).statusCode).toBe(401);
  });

  it('lists by map, by fleet, or over all the reader\'s maps', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/approvals' });
    await app.inject({ method: 'GET', url: `/api/maps/${MAP}/approvals` });
    await app.inject({ method: 'GET', url: '/api/fleets/f1/approvals' });
    expect(listMock.mock.calls.map((c) => c[1])).toEqual([{}, { mapId: MAP }, { fleetId: 'f1' }]);
  });

  it('needs view to list a map, edit to decide', async () => {
    state.perm = { [MAP]: 'view' };
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/approvals` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/approve`, payload: {} })).statusCode).toBe(403);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('404s a node that belongs to another map', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/foreign/reject`, payload: {} })).statusCode).toBe(404);
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('approve forwards merge + description and announces the change', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/approve`, payload: { merge: 'auto', description: 'new', extra: 1 } });
    expect(res.statusCode).toBe(200);
    expect(approveMock).toHaveBeenCalledWith('u1', MAP, 'n1', { merge: 'auto', description: 'new' });
    expect(res.json()).toMatchObject({ approval: node.approval, writes: [], ok: true });
    expect(broadcastMock).toHaveBeenCalledWith(MAP, expect.objectContaining({ type: 'node:updated', nodeId: 'n1', fields: ['approval'] }));
    expect(broadcastMock).toHaveBeenCalledWith(MAP, expect.objectContaining({ type: 'asks:updated', kind: 'approval' }));
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('syncs an edited description to the forge', async () => {
    approveMock.mockResolvedValue({ node, changedFields: ['description', 'approval'], writes: [] });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/approve`, payload: { description: 'x' } });
    expect(syncMock).toHaveBeenCalledWith(node, ['description', 'approval']);
  });

  it('reject passes note + closeIssue (strictly true) and reports a failed write', async () => {
    rejectMock.mockResolvedValue({ node, changedFields: ['approval'], writes: [{ kind: 'comment', target: 'o/r#1', done: false, error: 'boom' }] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/reject`, payload: { note: 'no', closeIssue: 'yes' } });
    expect(rejectMock).toHaveBeenCalledWith('u1', MAP, 'n1', { note: 'no', closeIssue: false });
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('maps a service refusal to its status', async () => {
    approveMock.mockResolvedValue({ status: 403, code: 'NOT_TRUSTED', message: 'nope' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/nodes/n1/approve`, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'NOT_TRUSTED', message: 'nope' } });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
