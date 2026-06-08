/**
 * Round-trip tests for the per-map triage flags exposed via PUT /api/maps/:id.
 *
 * The columns `triage_enabled` and `triage_label_writeback` exist on the
 * `maps` table and were only flip-able via SQL until the UI toggle landed.
 * These tests lock down the API surface so the frontend toggle can write
 * to them, and the GET map handler reads them back as `triageEnabled` /
 * `triageLabelWriteback` camelCase on the MindMap response.
 *
 * Mock pattern mirrors admin-endpoints-guard.test.ts — stub the DB +
 * permissions module so we exercise route wiring without standing up
 * Postgres. The interesting assertion is that the PUT request body is
 * forwarded verbatim to `mapDb.updateMap` (camelCase keys preserved).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const updateMapMock = vi.fn();
const getMapMock = vi.fn();
const listMapsForUserMock = vi.fn(async () => []);
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

const getPermissionMock = vi.fn(async () => 'edit' as 'view' | 'edit' | 'admin' | null);
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

describe('PUT /api/maps/:id — triage flag round-trip', () => {
  it('forwards triageEnabled to updateMap and returns the updated row', async () => {
    updateMapMock.mockResolvedValueOnce({
      id: MAP_ID,
      name: 'My Map',
      triageEnabled: true,
      triageLabelWriteback: false,
      autoImportNewIssues: true,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { triageEnabled: true },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledOnce();
    expect(updateMapMock.mock.calls[0][0]).toBe(MAP_ID);
    expect(updateMapMock.mock.calls[0][1]).toEqual({ triageEnabled: true });
    expect(res.json().triageEnabled).toBe(true);
  });

  it('forwards triageLabelWriteback to updateMap and returns the updated row', async () => {
    updateMapMock.mockResolvedValueOnce({
      id: MAP_ID,
      name: 'My Map',
      triageEnabled: true,
      triageLabelWriteback: true,
      autoImportNewIssues: true,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { triageLabelWriteback: true },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock.mock.calls[0][1]).toEqual({ triageLabelWriteback: true });
    expect(res.json().triageLabelWriteback).toBe(true);
  });

  it('round-trips both flags in a single PATCH (e.g. disable cascade)', async () => {
    updateMapMock.mockResolvedValueOnce({
      id: MAP_ID,
      name: 'My Map',
      triageEnabled: false,
      triageLabelWriteback: false,
      autoImportNewIssues: true,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { triageEnabled: false, triageLabelWriteback: false },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateMapMock.mock.calls[0][1]).toEqual({
      triageEnabled: false,
      triageLabelWriteback: false,
    });
    expect(res.json().triageEnabled).toBe(false);
    expect(res.json().triageLabelWriteback).toBe(false);
  });

  it('403s when the caller lacks edit permission (regression guard)', async () => {
    getPermissionMock.mockResolvedValueOnce('view' as const);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { triageEnabled: true },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
  });
});
