/**
 * Deploy-drift route — the real plugin, the service stubbed. What the
 * route owns: view access, the map id it hands the service, the shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));
const svc = vi.hoisted(() => ({ forMap: vi.fn() }));

vi.mock('../../services/deployDrift.js', () => ({
  deployDriftForMap: (...a: unknown[]) => svc.forMap(...a),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));

import { deployDriftRoutes } from '../deployDrift.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId });
  });
  await app.register(deployDriftRoutes);
  return app;
}

beforeEach(() => {
  userId = 'u1';
  state.perm = { [MAP]: 'view' };
  svc.forMap.mockReset();
});

describe('GET /api/maps/:id/deploy-drift', () => {
  it('a viewer gets the drift for that map', async () => {
    const drift = { sha: 'a'.repeat(40), undeployed: 1, undeployedSince: '2026-11-18T08:42:05Z', checkedAt: 'x', commits: [] };
    svc.forMap.mockResolvedValue(drift);
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/maps/${MAP}/deploy-drift` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ drift });
    expect(svc.forMap).toHaveBeenCalledWith(MAP);
  });

  it('null passes through', async () => {
    svc.forMap.mockResolvedValue(null);
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/maps/${MAP}/deploy-drift` });
    expect(res.json()).toEqual({ drift: null });
  });

  it('no access → 403, no login → 401, and the service is never asked', async () => {
    state.perm = {};
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/deploy-drift` })).statusCode).toBe(403);
    userId = undefined;
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/deploy-drift` })).statusCode).toBe(401);
    expect(svc.forMap).not.toHaveBeenCalled();
  });
});
