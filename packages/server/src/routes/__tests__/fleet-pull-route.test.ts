/**
 * POST /api/fleets/:id/pull-next (#478) — the route's part: body checks,
 * who may pull, and which maps the service may take from (edit on the map,
 * the same level the map route's pull asks). The pull itself is the
 * service's, stubbed here; it runs against real Postgres in
 * services/__tests__/fleet-pull.db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const FLEET_ID = '11111111-2222-4333-8444-555555555555';
const EDITOR = 'editor-user';
const VIEWER = 'viewer-user';
const STRANGER = 'stranger-user';

const s = vi.hoisted(() => ({
  pull: vi.fn(),
  /** user → map → permission */
  perms: {} as Record<string, Record<string, 'view' | 'edit' | 'admin'>>,
}));

vi.mock('../../db/fleets.js', () => ({
  getFleet: async () => ({ id: FLEET_ID, name: 'F', ownerId: 'owner', maxActiveClaims: 4, createdAt: '', updatedAt: '' }),
  listFleetMaps: async () => [
    { id: 'map-a', name: 'Alpha', fleetShare: 1, maxActiveClaims: 2, archivedAt: null },
    { id: 'map-b', name: 'Beta', fleetShare: 1, maxActiveClaims: 2, archivedAt: null },
  ],
}));
vi.mock('../../db/maps.js', () => ({
  listMapsForUser: async (userId: string) =>
    Object.keys(s.perms[userId] ?? {}).map((id) => ({ id, fleetId: FLEET_ID })),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string, userId: string) => s.perms[userId]?.[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../services/orchestration.js', () => ({
  pullFleetTicket: (...a: unknown[]) => s.pull(...a),
  OrchestrationNotFoundError: class extends Error {},
}));

import { fleetEntityRoutes } from '../fleets.js';

async function pull(userId: string | null, payload: unknown) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (userId) req.userId = userId;
  });
  await app.register(fleetEntityRoutes);
  const res = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET_ID}/pull-next`, payload: payload as object });
  await app.close();
  return res;
}

beforeEach(() => {
  s.pull.mockReset();
  s.pull.mockResolvedValue({ granted: false, reason: 'empty', active: 0, cap: 4, skipped: [] });
  s.perms = {
    [EDITOR]: { 'map-a': 'edit', 'map-b': 'view' },
    [VIEWER]: { 'map-a': 'view' },
  };
});

describe('POST /api/fleets/:id/pull-next', () => {
  it('401s without a user, 400s a bad body', async () => {
    expect((await pull(null, { sessionId: 'w' })).statusCode).toBe(401);
    expect((await pull(EDITOR, {})).statusCode).toBe(400);
    expect((await pull(EDITOR, { sessionId: 'w', mapIds: [] })).statusCode).toBe(400);
    expect((await pull(EDITOR, { sessionId: 'w', mapIds: 'map-a' })).statusCode).toBe(400);
    expect((await pull(EDITOR, { sessionId: 'w', profile: 3 })).statusCode).toBe(400);
    expect(s.pull).not.toHaveBeenCalled();
  });

  it("404s someone who can't read the fleet", async () => {
    const res = await pull(STRANGER, { sessionId: 'w' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FLEET_NOT_FOUND');
    expect(s.pull).not.toHaveBeenCalled();
  });

  it('lets the service take only from maps the caller can edit', async () => {
    const res = await pull(EDITOR, { sessionId: 'sat:w1', profile: 'light', mapIds: ['map-a', 'map-b'] });
    expect(res.statusCode).toBe(200);
    const [fleetId, sessionId, opts] = s.pull.mock.calls[0];
    expect(fleetId).toBe(FLEET_ID);
    expect(sessionId).toBe('sat:w1');
    expect(opts.profile).toBe('light');
    expect(opts.mapIds).toEqual(['map-a', 'map-b']);
    expect([...opts.allowedMapIds]).toEqual(['map-a']);
  });

  it('a viewer reaches the service with nothing allowed — and so gets nothing', async () => {
    await pull(VIEWER, { sessionId: 'w' });
    expect([...s.pull.mock.calls[0][2].allowedMapIds]).toEqual([]);
  });
});
