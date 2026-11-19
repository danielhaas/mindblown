/**
 * GET /api/maps/:id/export.md (#637): the real maps plugin, DB stubbed, the
 * schedule and the renderer run for real. What the route owns: view access,
 * ?root / ?detail / ?tz parsing and validation (400), 404 for an unknown
 * map, text/markdown on success.
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

function node(id: string, over: Record<string, unknown> = {}) {
  return {
    id, mapId: MAP_ID, parentId: null, childrenIds: [], text: id, description: null,
    effortEstimate: null, percentComplete: null, status: null, blockedReason: null,
    tags: [], dependencies: [], externalLinks: [], startDate: null, dueDate: null,
    completedAt: null, priority: null, priorityRank: null, createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const mapData = () => ({
  map: {
    id: MAP_ID, workspaceId: 'ws', name: 'Loke-Support', rootNodeId: 'root', effortUnit: 'days',
    hoursPerDay: 8, workerCount: 1, focusFactor: 1, projectStartDate: '2026-11-02',
    holidayJurisdiction: null, holidayOverrides: { add: [], remove: [] },
    statusWorkflow: [
      { id: 'todo', name: 'Todo', category: 'todo', color: '#ccc', position: 0 },
      { id: 'done', name: 'Done', category: 'done', color: '#0f0', position: 1 },
    ],
  },
  nodes: [
    node('root', { text: 'Loke-Support', childrenIds: ['m1'] }),
    node('m1', { text: 'M1 Infrastructure', parentId: 'root', childrenIds: ['vm', 'ci'] }),
    node('vm', { text: 'AWS VM', parentId: 'm1', tags: ['external'], effortEstimate: 1, description: 'Owner: LOKE IT' }),
    node('ci', { text: 'CI pipeline', parentId: 'm1', effortEstimate: 3 }),
  ],
});

beforeEach(() => {
  getMapMock.mockReset();
  getPermissionMock.mockReset();
  getPermissionMock.mockResolvedValue('view');
});

describe('GET /api/maps/:id/export.md (#637)', () => {
  it('renders the timeline as text/markdown for a viewer', async () => {
    getMapMock.mockResolvedValue(mapData());
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/export.md?tz=Europe/Zurich` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown/);
    expect(res.body).toMatch(/^# Loke-Support — timeline/);
    expect(res.body).toContain('(Europe/Zurich)');
    expect(res.body).toContain('## M1 Infrastructure');
    expect(res.body).toContain('**AWS VM** — Owner: LOKE IT');
    expect(res.body).not.toContain('`vm`');
    expect(getMapMock).toHaveBeenCalledWith(MAP_ID);
  });

  it('honours ?root and ?detail=full', async () => {
    getMapMock.mockResolvedValue(mapData());
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/export.md?root=m1&detail=full` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^# Loke-Support — M1 Infrastructure — timeline/);
    expect(res.body).toContain('`vm`');
  });

  it('400s a bad detail, zone or root; 404s an unknown map', async () => {
    getMapMock.mockResolvedValue(mapData());
    const app = await buildApp();
    const bad = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/export.md?${qs}` }));
    const d = await bad('detail=everything');
    expect(d.statusCode).toBe(400);
    expect(d.json().error.message).toMatch(/detail/);
    expect((await bad('tz=Mars/Olympus')).statusCode).toBe(400);
    expect((await bad('root=elsewhere')).json().error.message).toMatch(/not on this map/);
    getMapMock.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/export.md` })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses a non-member', async () => {
    getPermissionMock.mockResolvedValue(null);
    getMapMock.mockResolvedValue(mapData());
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/export.md` });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});
