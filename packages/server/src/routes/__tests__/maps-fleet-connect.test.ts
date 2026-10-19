/**
 * PUT /api/maps/:id { fleetId, fleetShare } (#477) — who may connect a map
 * to a fleet. Connecting or disconnecting needs admin on the map; connecting
 * also needs ownership of the target fleet. fleetShare is an ordinary
 * edit-level knob.
 *
 * Harness mirrors maps-dispatch-audit.test.ts (DB + permissions stubbed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const updateMapMock = vi.fn();
const getFleetMock = vi.fn();
/** Maps the caller can view (drives whether a foreign fleet is readable) and the map's current fleet. */
const state = vi.hoisted(() => ({
  visible: [] as Array<{ id: string; fleetId: string | null }>,
  currentFleetId: null as string | null,
}));

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: vi.fn(),
  listMapsForUser: async () => state.visible,
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../db/fleets.js', () => ({
  getFleet: (...args: unknown[]) => getFleetMock(...args),
  getMapFleetId: async () => state.currentFleetId,
  countActiveClaims: async () => 2,
  listFleetMaps: async () => state.visible.map((m) => ({ id: m.id, name: 'Other', fleetShare: 1, maxActiveClaims: 0, archivedAt: null })),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

const perm = vi.hoisted(() => ({ level: 'admin' as 'view' | 'edit' | 'admin' | null }));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => perm.level,
  hasPermission: (actual: string | null, required: string) => {
    if (actual == null) return false;
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return (rank[actual] ?? 0) >= (rank[required] ?? 0);
  },
}));

vi.mock('../../db/versions.js', () => ({}));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({ workspaces: {}, users: {}, releaseSnapshots: {} }));
vi.mock('../../lib/releaseForecast.js', () => ({ computeReleaseForecast: vi.fn() }));
vi.mock('../../lib/releaseSnapshots.js', () => ({ snapshotReleaseForecastForMap: vi.fn() }));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), lte: vi.fn(), desc: vi.fn() }));

import { mapRoutes } from '../maps.js';

const USER_ID = 'uuuu-uuuu-uuuu-uuuu';
const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const FLEET_ID = '11111111-2222-4333-8444-555555555555';

async function put(payload: Record<string, unknown>) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = USER_ID;
  });
  await app.register(mapRoutes);
  const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload });
  await app.close();
  return res;
}

beforeEach(() => {
  perm.level = 'admin';
  state.visible = [];
  state.currentFleetId = null;
  updateMapMock.mockReset();
  updateMapMock.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({ id: MAP_ID, name: 'M', ...input }));
  getFleetMock.mockReset();
  getFleetMock.mockResolvedValue({ id: FLEET_ID, name: 'big-blower', ownerId: USER_ID, maxActiveClaims: 2 });
});

describe('PUT /api/maps/:id — fleet connection', () => {
  it('connects when the caller is map admin and fleet owner', async () => {
    const res = await put({ fleetId: FLEET_ID });
    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, { fleetId: FLEET_ID }, USER_ID);
  });

  it('refuses an edit-level member (connecting is an admin act)', async () => {
    perm.level = 'edit';
    const res = await put({ fleetId: FLEET_ID });
    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it("refuses a map admin who can read the fleet but doesn't own it (403)", async () => {
    getFleetMock.mockResolvedValue({ id: FLEET_ID, name: 'other', ownerId: 'someone-else', maxActiveClaims: 0 });
    state.visible = [{ id: 'other-map', fleetId: FLEET_ID }];
    const res = await put({ fleetId: FLEET_ID });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/owner/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a foreign fleet the admin can't even read — same as a missing one", async () => {
    getFleetMock.mockResolvedValue({ id: FLEET_ID, name: 'other', ownerId: 'someone-else', maxActiveClaims: 0 });
    const res = await put({ fleetId: FLEET_ID });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FLEET_NOT_FOUND');
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('404s an unknown fleet', async () => {
    getFleetMock.mockResolvedValue(null);
    const res = await put({ fleetId: FLEET_ID });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FLEET_NOT_FOUND');
  });

  it('disconnects with null — admin on the map is enough', async () => {
    const res = await put({ fleetId: null });
    expect(res.statusCode).toBe(200);
    expect(getFleetMock).not.toHaveBeenCalled();
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, { fleetId: null }, USER_ID);
  });

  it('refuses disconnecting by an edit-level member', async () => {
    perm.level = 'edit';
    const res = await put({ fleetId: null });
    expect(res.statusCode).toBe(403);
  });

  it('lets an edit-level member set fleetShare on a map without a fleet (inert there)', async () => {
    perm.level = 'edit';
    const res = await put({ fleetShare: 2 });
    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, { fleetShare: 2 }, USER_ID);
  });

  it("refuses fleetShare on a connected map to anyone but the fleet's owner — even a map admin", async () => {
    state.currentFleetId = FLEET_ID;
    getFleetMock.mockResolvedValue({ id: FLEET_ID, name: 'other', ownerId: 'someone-else', maxActiveClaims: 0 });
    const res = await put({ fleetShare: 100 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/share/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('lets the fleet owner set fleetShare on a connected map, at edit level on the map', async () => {
    perm.level = 'edit';
    state.currentFleetId = FLEET_ID;
    const res = await put({ fleetShare: 3 });
    expect(res.statusCode).toBe(200);
  });

  it('400s a fleetId that is neither a string nor null', async () => {
    const res = await put({ fleetId: 42 });
    expect(res.statusCode).toBe(400);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('400s a non-numeric fleetShare', async () => {
    const res = await put({ fleetShare: 'lots' });
    expect(res.statusCode).toBe(400);
  });
});
