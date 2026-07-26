/**
 * Route tests for GET /api/maps/:id/release-composition — the split
 * between requirement work and everything else in a release.
 *
 * The math is unit-tested in core; what matters here is the wiring the
 * route owns and core cannot: release ordering, the ?versionId filter,
 * the unattributed cap (an overview must not ship every leaf of every
 * release), and the 404s.
 *
 * Mock pattern mirrors phase-map-routes.test.ts — stub the DB layer so
 * we exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const getMapMock = vi.fn();
const listVersionsMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);

vi.mock('../../db/maps.js', () => ({
  updateMap: vi.fn(),
  getMap: (...args: unknown[]) => getMapMock(...args),
  listMapsForUser: vi.fn(async () => []),
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));

vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => 'edit'),
  hasPermission: (actual: string | null, required: string) => {
    if (actual == null) return false;
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return (rank[actual] ?? 0) >= (rank[required] ?? 0);
  },
}));

vi.mock('../../db/versions.js', () => ({
  listVersions: (...args: unknown[]) => listVersionsMock(...args),
}));
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

// ── Fixtures ──────────────────────────────────────────────────────

const USER_ID = 'uuuu-uuuu-uuuu-uuuu';
const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const V1 = 'ver-1';
const V2 = 'ver-2';

const version = (id: string, name: string, targetDate: string | null) => ({
  id,
  mapId: MAP_ID,
  name,
  status: 'active',
  targetDate,
  sortOrder: 0,
});

function node(partial: Record<string, unknown> & { id: string }) {
  return {
    mapId: MAP_ID,
    parentId: null,
    childrenIds: [],
    text: partial.id,
    tags: [],
    externalLinks: [],
    effortEstimate: null,
    percentComplete: null,
    versionId: null,
    requirementId: null,
    ...partial,
  };
}

/** One requirement with a ticket beneath it, plus loose work in each release. */
function fixtureNodes() {
  return [
    node({ id: 'root', childrenIds: ['req', 'loose1', 'loose2', 'loose3', 'v2work'] }),
    node({ id: 'req', parentId: 'root', requirementId: 'PER-01', childrenIds: ['w1'] }),
    node({ id: 'w1', parentId: 'req', versionId: V1, effortEstimate: 2, percentComplete: 100 }),
    node({ id: 'loose1', parentId: 'root', versionId: V1, effortEstimate: 3, tags: ['type:bug'] }),
    node({ id: 'loose2', parentId: 'root', versionId: V1, effortEstimate: 1 }),
    node({ id: 'loose3', parentId: 'root', versionId: V1 }),
    node({ id: 'v2work', parentId: 'root', versionId: V2, effortEstimate: 5 }),
  ];
}

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
  getMapMock.mockReset();
  listVersionsMock.mockReset();
  getMapMock.mockResolvedValue({
    map: { id: MAP_ID, effortUnit: 'days' },
    nodes: fixtureNodes(),
  });
  listVersionsMock.mockResolvedValue([
    version(V2, 'V2', '2026-12-01'),
    version(V1, 'V1', '2026-09-02'),
  ]);
});

// ── Cases ─────────────────────────────────────────────────────────

describe('GET /api/maps/:id/release-composition', () => {
  it('returns every release, chronologically, with the requirement split', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/release-composition` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Sorted by target date — V1 ships before V2 even though the DB
    // handed them back the other way round.
    expect(body.releases.map((r: { versionName: string }) => r.versionName)).toEqual(['V1', 'V2']);

    const v1 = body.releases[0];
    expect(v1.requirementWork.count).toBe(1);
    expect(v1.otherWork.count).toBe(3);
    expect(v1.coveragePct).toBe(25);
    expect(v1.byRequirement[0].requirementId).toBe('PER-01');
    expect(v1.otherWork.unestimated).toBe(1);
  });

  it('carries the effort unit so the client does not have to guess', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/release-composition` });
    await app.close();
    expect(res.json().effortUnit).toBe('days');
  });

  it('restricts to one release with ?versionId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition?versionId=${V2}`,
    });
    await app.close();

    const body = res.json();
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0].versionName).toBe('V2');
  });

  it('caps unattributed items but reports the true total', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition?limit=1`,
    });
    await app.close();

    const v1 = res.json().releases[0];
    expect(v1.unattributed).toHaveLength(1);
    // The cap must never masquerade as the answer.
    expect(v1.unattributedTotal).toBe(3);
  });

  it('clamps an absurd limit instead of streaming the whole map', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition?limit=999999`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().releases[0].unattributed.length).toBeLessThanOrEqual(500);
  });

  it('falls back to the default cap when limit is not a number', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition?limit=banana`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().releases[0].unattributed).toHaveLength(3);
  });

  it('404s on an unknown map', async () => {
    getMapMock.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition`,
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MAP_NOT_FOUND');
  });

  it('404s on a version that does not belong to the map', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition?versionId=nope`,
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('VERSION_NOT_FOUND');
  });

  it('reports a release with no work as null coverage, not 0 %', async () => {
    listVersionsMock.mockResolvedValue([version('ver-empty', 'V9', null)]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/release-composition`,
    });
    await app.close();
    expect(res.json().releases[0].coveragePct).toBeNull();
  });
});
