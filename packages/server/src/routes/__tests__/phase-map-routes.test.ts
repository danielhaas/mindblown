/**
 * Round-trip tests for the map-level phases list (PhaseDef[]) exposed via
 * PUT /api/maps/:id — the write surface behind "add / rename / reorder
 * phases". REPLACE mode: the full array is forwarded verbatim to
 * mapDb.updateMap (statusWorkflow idiom; ids stay stable so node.phaseId
 * references survive renames).
 *
 * Mock pattern mirrors maps-triage-flags.test.ts — stub the DB +
 * permissions module so we exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const updateMapMock = vi.fn();
const getMapMock = vi.fn();
const listMapsForUserMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const createBaselineMock = vi.fn();
const deleteMapMock = vi.fn();
const createMapMock = vi.fn();

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: (...args: unknown[]) => getMapMock(...args),
  listMapsForUser: (...args: unknown[]) => listMapsForUserMock(...args),
  createBaseline: (...args: unknown[]) => createBaselineMock(...args),
  deleteMap: (...args: unknown[]) => deleteMapMock(...args),
  createMap: (...args: unknown[]) => createMapMock(...args),
}));

const getPermissionMock = vi.fn<(...args: unknown[]) => Promise<'view' | 'edit' | 'admin' | null>>(async () => 'edit');
vi.mock('../../db/permissions.js', () => ({
  getPermission: (...args: unknown[]) => getPermissionMock(...args),
  hasPermission: (actual: string | null, required: string) => {
    if (actual == null) return false;
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return (rank[actual] ?? 0) >= (rank[required] ?? 0);
  },
}));

vi.mock('../../db/versions.js', () => ({}));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({
  workspaces: {},
  users: {},
  releaseSnapshots: {},
}));
vi.mock('../../lib/releaseForecast.js', () => ({
  computeReleaseForecast: vi.fn(),
}));
vi.mock('../../lib/releaseSnapshots.js', () => ({
  snapshotReleaseForecastForMap: vi.fn(),
}));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  lte: vi.fn(),
  desc: vi.fn(),
}));

import { mapRoutes } from '../maps.js';

// ── Test harness ──────────────────────────────────────────────────

const USER_ID = 'uuuu-uuuu-uuuu-uuuu';
const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = USER_ID;
    req.authSource = 'jwt';
  });
  await app.register(mapRoutes);
  return app;
}

beforeEach(() => {
  updateMapMock.mockReset();
  getMapMock.mockReset();
  getPermissionMock.mockClear();
});

// ── Cases ─────────────────────────────────────────────────────────

describe('PUT /api/maps/:id — phases (PhaseDef[]) round-trip', () => {
  it('forwards a new phases array to updateMap and returns the updated row', async () => {
    const phases = [
      { id: 'ph-1', name: 'M1 – Grundgerüst', position: 0 },
      { id: 'ph-2', name: 'M2 – Auth', position: 1 },
    ];
    updateMapMock.mockResolvedValueOnce({ id: MAP_ID, name: 'My Map', phases });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { phases },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledOnce();
    expect(updateMapMock.mock.calls[0][0]).toBe(MAP_ID);
    expect(updateMapMock.mock.calls[0][1]).toEqual({ phases });
    expect(res.json().phases).toEqual(phases);
  });

  it('round-trips a reorder — same ids, swapped positions', async () => {
    const reordered = [
      { id: 'ph-2', name: 'M2 – Auth', position: 0 },
      { id: 'ph-1', name: 'M1 – Grundgerüst', position: 1 },
    ];
    updateMapMock.mockResolvedValueOnce({ id: MAP_ID, name: 'My Map', phases: reordered });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { phases: reordered },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Ids must be forwarded untouched — node.phaseId references depend on it.
    expect(updateMapMock.mock.calls[0][1]).toEqual({ phases: reordered });
    expect(res.json().phases.map((p: { id: string }) => p.id)).toEqual(['ph-2', 'ph-1']);
  });

  it('round-trips a rename — same id, new name', async () => {
    const renamed = [{ id: 'ph-1', name: 'M1 – Fundament', position: 0 }];
    updateMapMock.mockResolvedValueOnce({ id: MAP_ID, name: 'My Map', phases: renamed });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { phases: renamed },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock.mock.calls[0][1]).toEqual({ phases: renamed });
  });

  it('403s when the caller lacks edit permission (regression guard)', async () => {
    getPermissionMock.mockResolvedValueOnce('view' as const);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { phases: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
  });
});
