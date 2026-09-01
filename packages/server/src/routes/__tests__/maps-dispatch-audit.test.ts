/**
 * PUT /api/maps/:id — the two things the Dispatch card relies on beyond the
 * write itself: the caller is forwarded to updateMap (so the change_events
 * row is attributed), and the updated row is broadcast as `map:updated` so
 * an open cockpit follows an orchestrator's cap write instead of showing
 * the stale value.
 *
 * Harness mirrors maps-triage-flags.test.ts (DB + permissions stubbed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const updateMapMock = vi.fn();
const getMapMock = vi.fn();
const broadcastMock = vi.fn();

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: (...args: unknown[]) => getMapMock(...args),
  listMapsForUser: vi.fn(async () => []),
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../ws.js', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
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
  broadcastMock.mockReset();
  getPermissionMock.mockClear();
});

describe('PUT /api/maps/:id — dispatch knobs', () => {
  it('forwards the caller to updateMap and broadcasts the updated row as map:updated', async () => {
    const updated = { id: MAP_ID, name: 'Roadmap', maxActiveClaims: 6, dispatchGate: ['version:mvp'], dispatchPolicy: [] };
    updateMapMock.mockResolvedValueOnce(updated);
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { maxActiveClaims: 6 } });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, { maxActiveClaims: 6 }, USER_ID);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, { type: 'map:updated', map: updated });
    expect(res.json().maxActiveClaims).toBe(6);
  });

  it('does not broadcast when the map is unknown', async () => {
    updateMapMock.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { maxActiveClaims: 6 } });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses view-only callers before touching the knobs', async () => {
    getPermissionMock.mockResolvedValueOnce('view');
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { maxActiveClaims: 0 } });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
