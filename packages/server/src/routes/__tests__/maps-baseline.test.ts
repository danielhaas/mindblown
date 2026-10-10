/**
 * #113 routes: freezing a baseline (name optional), deleting one, and the
 * schedule route reporting missed due dates instead of stretching bars.
 * DB + permissions stubbed as in maps-triage-flags.test.ts; the schedule
 * itself runs for real (lib/mapSchedule.ts is pure).
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
const deleteBaselineMock = vi.fn();

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: (...args: unknown[]) => getMapMock(...args),
  listMapsForUser: (...args: unknown[]) => listMapsForUserMock(...args),
  createBaseline: (...args: unknown[]) => createBaselineMock(...args),
  deleteMap: (...args: unknown[]) => deleteMapMock(...args),
  createMap: (...args: unknown[]) => createMapMock(...args),
  deleteBaseline: (...args: unknown[]) => deleteBaselineMock(...args),
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

beforeEach(() => {
  createBaselineMock.mockReset();
  deleteBaselineMock.mockReset();
  getMapMock.mockReset();
  getPermissionMock.mockReset();
  getPermissionMock.mockResolvedValue('edit');
});

describe('POST /api/maps/:id/baseline (#113)', () => {
  it('names the baseline after today when no name is given', async () => {
    createBaselineMock.mockResolvedValueOnce({ id: MAP_ID, baselines: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/baseline`, payload: {} });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(createBaselineMock.mock.calls[0][1]).toBe(`Baseline ${new Date().toISOString().slice(0, 10)}`);
  });

  it('keeps a given name and refuses a view-only member', async () => {
    createBaselineMock.mockResolvedValueOnce({ id: MAP_ID, baselines: [] });
    let app = await buildApp();
    await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/baseline`, payload: { name: '  Q4 kickoff ' } });
    await app.close();
    expect(createBaselineMock.mock.calls[0][1]).toBe('Q4 kickoff');

    getPermissionMock.mockResolvedValue('view');
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/baseline`, payload: {} });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/maps/:id/baseline/:baselineId (#113)', () => {
  it('drops it, 404s an unknown one, refuses view-only', async () => {
    deleteBaselineMock.mockResolvedValueOnce({ id: MAP_ID, baselines: [] }).mockResolvedValueOnce(null);
    let app = await buildApp();
    const ok = await app.inject({ method: 'DELETE', url: `/api/maps/${MAP_ID}/baseline/b1` });
    const missing = await app.inject({ method: 'DELETE', url: `/api/maps/${MAP_ID}/baseline/nope` });
    await app.close();
    expect(ok.statusCode).toBe(200);
    expect(deleteBaselineMock).toHaveBeenCalledWith(MAP_ID, 'b1');
    expect(missing.statusCode).toBe(404);

    getPermissionMock.mockResolvedValue('view');
    app = await buildApp();
    const denied = await app.inject({ method: 'DELETE', url: `/api/maps/${MAP_ID}/baseline/b1` });
    await app.close();
    expect(denied.statusCode).toBe(403);
  });
});

describe('GET /api/maps/:id/schedule — missed due dates (#113)', () => {
  it('lists the node that lands after its due date', async () => {
    const node = (id: string, over: Record<string, unknown>) => ({
      id, parentId: null, childrenIds: [], text: id, dependencies: [], effortEstimate: 1, percentComplete: null,
      status: 'todo', priority: null, priorityRank: null, startDate: null, dueDate: null, completedAt: null,
      createdAt: '2026-09-01T00:00:00Z', ...over,
    });
    getMapMock.mockResolvedValueOnce({
      map: { id: MAP_ID, projectStartDate: '2026-10-01', effortUnit: 'days', workerCount: 1, focusFactor: 1, baselines: [] },
      nodes: [node('late', { effortEstimate: 5, dueDate: '2026-10-03', priority: 'P0' }), node('fine', { effortEstimate: 1, dueDate: '2026-12-01', priority: 'P3' })],
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/schedule` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dueViolations).toEqual([
      { nodeId: 'late', text: 'late', dueDate: '2026-10-03', projectedEnd: '2026-10-06', lateDays: 3 },
    ]);
    expect(body.offsetToDate).toBeUndefined();
    expect(body.barDates).toBeUndefined();
  });
});
