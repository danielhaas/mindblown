/**
 * Holiday calendar (#110) through the map routes: PUT validates and
 * normalises the two fields, GET /schedule schedules in working days once a
 * calendar is set and ships the holidays it used.
 *
 * Mock pattern: maps-triage-flags.test.ts. The holiday resolution itself is
 * real (date-holidays), so the LI dates below are the library's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Node } from '@mindblown/core';

const updateMapMock = vi.fn();
const getMapMock = vi.fn();

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: (...args: unknown[]) => getMapMock(...args),
  listMapsForUser: async () => [],
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => 'edit',
  hasPermission: () => true,
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

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu';
    req.authSource = 'jwt';
  });
  await app.register(mapRoutes);
  return app;
}

function node(overrides: Partial<Node> & { id: string }): Node {
  return {
    mapId: MAP_ID,
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    priorityRank: null,
    completedAt: null,
    createdAt: '2026-12-01T00:00:00Z',
    updatedAt: '2026-12-01T00:00:00Z',
    ...overrides,
  } as Node;
}

function mapWith(holidays: { holidayJurisdiction?: string | null; holidayOverrides?: { add: string[]; remove: string[] } }) {
  return {
    map: {
      id: MAP_ID,
      name: 'Map',
      rootNodeId: 'root',
      effortUnit: 'days',
      hoursPerDay: 8,
      workerCount: 1,
      focusFactor: 1,
      projectStartDate: '2026-12-23',
      holidayOverrides: { add: [], remove: [] },
      ...holidays,
    },
    nodes: [
      node({ id: 'root', childrenIds: ['a', 'b'] }),
      node({ id: 'a', parentId: 'root', effortEstimate: 3 }),
      // Pinned to start on Monday 28 Dec — 2 working days after the anchor on LI.
      node({ id: 'b', parentId: 'root', effortEstimate: 1, startDate: '2026-12-28' }),
    ],
  };
}

beforeEach(() => {
  updateMapMock.mockReset();
  getMapMock.mockReset();
});

describe('PUT /api/maps/:id — holiday calendar (#110)', () => {
  it('normalises the code and the override lists before writing', async () => {
    updateMapMock.mockResolvedValueOnce({ id: MAP_ID });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { holidayJurisdiction: 'ch-zh', holidayOverrides: { add: ['2026-12-31', '2026-12-24', '2026-12-31'], remove: [] } },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(updateMapMock.mock.calls[0][1]).toEqual({
      holidayJurisdiction: 'CH-ZH',
      holidayOverrides: { add: ['2026-12-24', '2026-12-31'], remove: [] },
    });
  });

  it('refuses a code the library does not know, and a malformed date', async () => {
    const app = await buildApp();
    const unknown = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { holidayJurisdiction: 'CH-QQ' } });
    const badDate = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { holidayOverrides: { add: ['2026-02-30'], remove: [] } },
    });
    await app.close();
    expect(unknown.statusCode).toBe(400);
    expect(badDate.statusCode).toBe(400);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('null clears the jurisdiction', async () => {
    updateMapMock.mockResolvedValueOnce({ id: MAP_ID });
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { holidayJurisdiction: null } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(updateMapMock.mock.calls[0][1]).toEqual({ holidayJurisdiction: null });
  });
});

describe('GET /api/maps/:id/schedule — working calendar (#110)', () => {
  it('without a calendar every day counts and no holidays are shipped', async () => {
    getMapMock.mockResolvedValueOnce(mapWith({ holidayJurisdiction: null }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/schedule` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().workingCalendar).toBeNull();
    // Pin on 28 Dec = 5 calendar days after 23 Dec.
    expect(res.json().schedule.find((s: { nodeId: string }) => s.nodeId === 'b').computedStart).toBeGreaterThanOrEqual(5);
  });

  it('with LI the pin lands in working days and the holidays travel with the schedule', async () => {
    getMapMock.mockResolvedValueOnce(mapWith({ holidayJurisdiction: 'LI' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/schedule` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workingCalendar.jurisdiction).toBe('LI');
    expect(body.workingCalendar.holidays).toEqual(expect.arrayContaining(['2026-12-25', '2026-12-26']));
    // 23 Dec → 28 Dec is 2 working days (23, 24; 25/26 holidays, 27 Sunday).
    const b = body.schedule.find((s: { nodeId: string }) => s.nodeId === 'b');
    expect(b.computedStart).toBeGreaterThanOrEqual(2);
    expect(b.computedStart).toBeLessThan(5);
  });
});
