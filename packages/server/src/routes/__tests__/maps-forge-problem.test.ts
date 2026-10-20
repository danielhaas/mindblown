/**
 * GET /api/maps/:id carries `forgeProblem` (#513) — the only source of the
 * forge-settings banner and the Fleet-tab warning. A failed check must not
 * fail the map load.
 *
 * Harness mirrors maps-fleet-connect.test.ts (DB + permissions stubbed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const state = vi.hoisted(() => ({
  problem: null as unknown,
  throws: false,
}));

vi.mock('../../db/maps.js', () => ({
  getMap: async () => ({
    map: { id: 'mmmm-mmmm-mmmm-mmmm', name: 'Sonarpipe', githubRepoOwner: 'dan', githubRepoName: 'Sonarpipe', fleetId: null },
    nodes: [],
  }),
  updateMap: vi.fn(),
  listMapsForUser: vi.fn(),
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../lib/forgeProblem.js', () => ({
  forgeProblemForMap: async () => {
    if (state.throws) throw new Error('db down');
    return state.problem;
  },
}));
vi.mock('../../lib/githubContext.js', () => ({ getMapForgeKind: async () => null }));
vi.mock('../../lib/stalled.js', () => ({ stalledOrEmpty: async () => [] }));
vi.mock('../../services/fleets.js', () => ({ fleetNameOf: async () => null }));
vi.mock('../../db/fleets.js', () => ({}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => 'view',
  hasPermission: (actual: string | null) => actual != null,
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

async function getMapPayload() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu-uuuu-uuuu-uuuu';
  });
  await app.register(mapRoutes);
  const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}` });
  await app.close();
  return res;
}

beforeEach(() => {
  state.problem = null;
  state.throws = false;
});

describe('GET /api/maps/:id — forgeProblem (#513)', () => {
  it('carries the problem the check found', async () => {
    state.problem = { kind: 'unbound', repo: 'dan/Sonarpipe', message: 'Map names dan/Sonarpipe, but no forge connection binds it' };
    const res = await getMapPayload();
    expect(res.statusCode).toBe(200);
    expect(res.json().map.forgeProblem).toEqual(state.problem);
  });

  it('null when the map reaches its repo', async () => {
    const res = await getMapPayload();
    expect(res.json().map.forgeProblem).toBeNull();
  });

  it('a failing check still loads the map, with no problem claimed', async () => {
    state.throws = true;
    const res = await getMapPayload();
    expect(res.statusCode).toBe(200);
    expect(res.json().map.forgeProblem).toBeNull();
  });
});
