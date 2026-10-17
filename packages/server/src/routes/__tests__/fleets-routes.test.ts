/**
 * /api/fleets (#477) — the fleet entity routes. DB stubbed; the assertions
 * are the access rules: the owner administers, a viewer of a connected map
 * may read (and sees only the maps they can view), everyone else gets a
 * 404 that doesn't reveal the fleet exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const OWNER = 'owner-user';
const VIEWER = 'viewer-user';
const STRANGER = 'stranger-user';
const FLEET_ID = '11111111-2222-4333-8444-555555555555';
const MAP_A = 'map-a';
const MAP_B = 'map-b';

const fleetRow = () => ({
  id: FLEET_ID,
  name: 'big-blower',
  ownerId: OWNER,
  maxActiveClaims: 3,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
});
const connected = [
  { id: MAP_A, name: 'Alpha', fleetShare: 1, maxActiveClaims: 2, archivedAt: null },
  { id: MAP_B, name: 'Beta', fleetShare: 2, maxActiveClaims: 2, archivedAt: null },
];

const db = vi.hoisted(() => ({
  getFleet: vi.fn(),
  listFleetsByOwnerOrIds: vi.fn(),
  listFleetMaps: vi.fn(),
  createFleet: vi.fn(),
  updateFleet: vi.fn(),
  deleteFleet: vi.fn(),
  /** Maps each user can view, with their fleetId. */
  visible: {} as Record<string, Array<{ id: string; fleetId: string | null }>>,
}));

vi.mock('../../db/fleets.js', () => ({
  getFleet: (...a: unknown[]) => db.getFleet(...a),
  listFleetsByOwnerOrIds: (...a: unknown[]) => db.listFleetsByOwnerOrIds(...a),
  listFleetMaps: (...a: unknown[]) => db.listFleetMaps(...a),
  createFleet: (...a: unknown[]) => db.createFleet(...a),
  updateFleet: (...a: unknown[]) => db.updateFleet(...a),
  deleteFleet: (...a: unknown[]) => db.deleteFleet(...a),
}));
vi.mock('../../db/maps.js', () => ({
  listMapsForUser: async (userId: string) => db.visible[userId] ?? [],
}));
vi.mock('../../db/permissions.js', () => ({ getPermission: async () => null, hasPermission: () => false }));

import { fleetEntityRoutes } from '../fleets.js';

async function call(userId: string | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (userId) req.userId = userId;
  });
  await app.register(fleetEntityRoutes);
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await app.close();
  return res;
}

beforeEach(() => {
  for (const fn of [db.getFleet, db.listFleetsByOwnerOrIds, db.listFleetMaps, db.createFleet, db.updateFleet, db.deleteFleet]) fn.mockReset();
  db.getFleet.mockResolvedValue(fleetRow());
  db.listFleetMaps.mockResolvedValue(connected);
  db.listFleetsByOwnerOrIds.mockResolvedValue([fleetRow()]);
  db.updateFleet.mockResolvedValue(fleetRow());
  db.deleteFleet.mockResolvedValue(true);
  db.visible = {
    [OWNER]: [{ id: MAP_A, fleetId: FLEET_ID }, { id: MAP_B, fleetId: FLEET_ID }],
    [VIEWER]: [{ id: MAP_A, fleetId: FLEET_ID }],
    [STRANGER]: [],
  };
});

describe('auth', () => {
  it('401s every route without a user', async () => {
    for (const [m, u] of [['GET', '/api/fleets'], ['POST', '/api/fleets'], ['GET', `/api/fleets/${FLEET_ID}`], ['PATCH', `/api/fleets/${FLEET_ID}`], ['DELETE', `/api/fleets/${FLEET_ID}`]] as const) {
      expect((await call(null, m, u, m === 'POST' || m === 'PATCH' ? {} : undefined)).statusCode).toBe(401);
    }
  });
});

describe('POST /api/fleets', () => {
  it('creates a fleet owned by the caller', async () => {
    db.createFleet.mockResolvedValue({ ...fleetRow(), ownerId: STRANGER, maxActiveClaims: 0 });
    const res = await call(STRANGER, 'POST', '/api/fleets', { name: '  big-blower  ' });
    expect(res.statusCode).toBe(201);
    expect(db.createFleet).toHaveBeenCalledWith({ name: 'big-blower', ownerId: STRANGER, maxActiveClaims: undefined });
    expect(res.json()).toMatchObject({ isOwner: true, maps: [], hiddenMapCount: 0 });
  });

  it('400s a missing name and a negative cap', async () => {
    expect((await call(OWNER, 'POST', '/api/fleets', {})).statusCode).toBe(400);
    expect((await call(OWNER, 'POST', '/api/fleets', { name: 'x', maxActiveClaims: -1 })).statusCode).toBe(400);
    expect((await call(OWNER, 'POST', '/api/fleets', { name: 'x', maxActiveClaims: 1.5 })).statusCode).toBe(400);
    expect(db.createFleet).not.toHaveBeenCalled();
  });
});

describe('GET /api/fleets/:id', () => {
  it('shows the owner every connected map', async () => {
    const res = await call(OWNER, 'GET', `/api/fleets/${FLEET_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isOwner: true, hiddenMapCount: 0 });
    expect(res.json().maps.map((m: { id: string }) => m.id)).toEqual([MAP_A, MAP_B]);
  });

  it('shows a viewer of one connected map only that map, the other as a count', async () => {
    const res = await call(VIEWER, 'GET', `/api/fleets/${FLEET_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isOwner: false, hiddenMapCount: 1 });
    expect(res.json().maps.map((m: { id: string }) => m.id)).toEqual([MAP_A]);
    expect(JSON.stringify(res.json())).not.toContain('Beta');
  });

  it('404s someone with no connected map — same answer as a missing fleet', async () => {
    const res = await call(STRANGER, 'GET', `/api/fleets/${FLEET_ID}`);
    expect(res.statusCode).toBe(404);
    db.getFleet.mockResolvedValue(null);
    const missing = await call(STRANGER, 'GET', `/api/fleets/${FLEET_ID}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(res.json());
  });
});

describe('GET /api/fleets', () => {
  it("asks for the caller's own fleets plus the fleets of maps they can view", async () => {
    const res = await call(VIEWER, 'GET', '/api/fleets');
    expect(res.statusCode).toBe(200);
    expect(db.listFleetsByOwnerOrIds).toHaveBeenCalledWith(VIEWER, [FLEET_ID]);
    expect(res.json()[0]).toMatchObject({ id: FLEET_ID, hiddenMapCount: 1, isOwner: false });
  });
});

describe('PATCH /api/fleets/:id', () => {
  it('lets the owner rename and set the cap', async () => {
    const res = await call(OWNER, 'PATCH', `/api/fleets/${FLEET_ID}`, { name: 'renamed', maxActiveClaims: 5 });
    expect(res.statusCode).toBe(200);
    expect(db.updateFleet).toHaveBeenCalledWith(FLEET_ID, { name: 'renamed', maxActiveClaims: 5 });
  });

  it('403s a viewer, 404s a stranger', async () => {
    expect((await call(VIEWER, 'PATCH', `/api/fleets/${FLEET_ID}`, { maxActiveClaims: 9 })).statusCode).toBe(403);
    expect((await call(STRANGER, 'PATCH', `/api/fleets/${FLEET_ID}`, { maxActiveClaims: 9 })).statusCode).toBe(404);
    expect(db.updateFleet).not.toHaveBeenCalled();
  });

  it('400s an empty name', async () => {
    expect((await call(OWNER, 'PATCH', `/api/fleets/${FLEET_ID}`, { name: '   ' })).statusCode).toBe(400);
  });
});

describe('DELETE /api/fleets/:id', () => {
  it('lets the owner delete, refuses a viewer', async () => {
    expect((await call(VIEWER, 'DELETE', `/api/fleets/${FLEET_ID}`)).statusCode).toBe(403);
    expect(db.deleteFleet).not.toHaveBeenCalled();
    expect((await call(OWNER, 'DELETE', `/api/fleets/${FLEET_ID}`)).statusCode).toBe(204);
    expect(db.deleteFleet).toHaveBeenCalledWith(FLEET_ID);
  });
});
