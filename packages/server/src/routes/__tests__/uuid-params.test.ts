/**
 * A map name where the map id goes is the caller's mistake, not a server
 * error: `GET /api/maps/Loke-Support` used to reach Postgres and come back
 * as a 500 (`invalid input syntax for type uuid`).
 *
 * Mounts the real mapRoutes / nodeRoutes / versionRoutes behind the uuid
 * param guard and the error handler as index.ts wires them:
 *   - a non-UUID map / node / version id → 404 NOT_FOUND naming it, no DB call;
 *   - a valid but unknown UUID → the route's own 404, as before;
 *   - Postgres 22P02 reaching the error handler → 400, not 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const m = vi.hoisted(() => ({
  getMap: vi.fn(),
  getNode: vi.fn(),
  getNodeMapId: vi.fn(),
  getVersion: vi.fn(),
  getPermission: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  db: new Proxy({}, { get: () => { throw new Error('db touched'); } }),
}));
vi.mock('../../db/permissions.js', () => {
  const levels: Record<string, number> = { view: 1, edit: 2, admin: 3 };
  return {
    getPermission: (...a: unknown[]) => m.getPermission(...a),
    hasPermission: (actual: string | null, required: string) => !!actual && levels[actual] >= levels[required],
  };
});
vi.mock('../../db/maps.js', () => ({
  getMap: (...a: unknown[]) => m.getMap(...a),
  updateMap: vi.fn(),
  listMapsForUser: async () => [],
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: (...a: unknown[]) => m.getNode(...a),
    getNodeMapId: (...a: unknown[]) => m.getNodeMapId(...a),
    updateNode: vi.fn(),
    createNode: vi.fn(),
  };
});
vi.mock('../../db/versions.js', () => ({ getVersion: (...a: unknown[]) => m.getVersion(...a) }));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../db/events.js', () => ({ recordEvent: vi.fn(async () => {}), recordFieldChanges: vi.fn(async () => {}) }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));
vi.mock('../../lib/releaseForecast.js', () => ({ computeReleaseForecast: vi.fn() }));
vi.mock('../../lib/releaseSnapshots.js', () => ({ snapshotReleaseForecastForMap: vi.fn() }));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));

import { mapRoutes } from '../maps.js';
import { nodeRoutes } from '../nodes.js';
import { versionRoutes } from '../versions.js';
import { registerInvalidInputErrorHandler, registerUuidParamGuard } from '../../middleware/uuidParams.js';

let app: FastifyInstance;

beforeEach(async () => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.getMap.mockResolvedValue(null);
  m.getNode.mockResolvedValue(null);
  m.getNodeMapId.mockResolvedValue(null);
  m.getVersion.mockResolvedValue(null);
  m.getPermission.mockResolvedValue('admin');

  app = Fastify({ logger: false });
  registerInvalidInputErrorHandler(app);
  await registerUuidParamGuard(app);
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
    req.authSource = 'jwt';
  });
  await app.register(mapRoutes);
  await app.register(nodeRoutes);
  await app.register(versionRoutes);
  app.get('/boom/:kind', async (req) => {
    const pg = Object.assign(new Error('invalid input syntax for type uuid: "Loke-Support"'), { code: '22P02' });
    const kind = (req.params as { kind: string }).kind;
    if (kind === 'raw') throw pg;
    if (kind === 'wrapped') throw Object.assign(new Error('Failed query: select …'), { cause: pg });
    throw new Error('something else');
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const noDbCalls = () => {
  for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
};

describe('non-UUID ids in the URL', () => {
  it('a map name is a 404 that says ids are UUIDs and where to list them — no DB call', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/Loke-Support' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: "No map 'Loke-Support' — map ids are UUIDs; list them with GET /api/maps",
      },
    });
    noDbCalls();
  });

  it('holds for writes and sub-routes of the map too', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/maps/Loke-Support', payload: { name: 'x' } });
    expect(put.statusCode).toBe(404);
    const nodes = await app.inject({ method: 'GET', url: '/api/maps/Loke-Support/nodes/' + MAP_ID });
    expect(nodes.statusCode).toBe(404);
    expect(nodes.json().error.message).toContain("No map 'Loke-Support'");
    noDbCalls();
  });

  it('a non-UUID node id is a 404 pointing at the map\'s node list', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/login-page` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: `No node 'login-page' — node ids are UUIDs; list them with GET /api/maps/${MAP_ID}/nodes`,
      },
    });
    noDbCalls();
  });

  it('a non-UUID version id is a 404 the same way', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/versions/V1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({
      code: 'NOT_FOUND',
      message: "No version 'V1' — version ids are UUIDs; list them with GET /api/versions?mapId=…",
    });
    noDbCalls();
  });
});

describe('valid but unknown UUIDs', () => {
  it('map: the route\'s own 404, as before', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/maps/${UNKNOWN}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MAP_NOT_FOUND');
    expect(m.getMap).toHaveBeenCalledWith(UNKNOWN);
  });

  it('node: the route\'s own 404, as before', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/${UNKNOWN}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NODE_NOT_FOUND');
  });

  it('version: the route\'s own 404, as before', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/versions/${UNKNOWN}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('VERSION_NOT_FOUND');
    expect(m.getVersion).toHaveBeenCalledWith(UNKNOWN);
  });
});

describe('error handler: Postgres 22P02 is a 400, not a 500', () => {
  it('the pg error itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/raw' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(res.json().error.message).toContain('invalid input syntax for type uuid: "Loke-Support"');
  });

  it('wrapped as the cause of a query error', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/wrapped' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
  });

  it('anything else is still a 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/other' });
    expect(res.statusCode).toBe(500);
  });
});
