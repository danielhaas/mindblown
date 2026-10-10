/**
 * GET /api/maps/:id/release-forecast — the trend deltas (#321). The 7-day
 * fields the Releases table reads stay as they were; ?trendDays=N adds the
 * same comparison over the caller's window, and ignores invalid values.
 *
 * Harness mirrors maps-dispatch-audit.test.ts. The snapshot "table" honours
 * the route's `snapshotDate <= cutoff` filter via the mocked lte().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const DAY = 86_400_000;
const isoDaysAgo = (d: number) => {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - d * DAY).toISOString().slice(0, 10);
};

let snapshots: Array<{ versionId: string; snapshotDate: string; plannedFinishDate: string; velocityAdjustedFinishDate: string; createdAt: Date }> = [];

vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async () => ({ map: { id: MAP_ID }, nodes: [] })),
  isMapArchived: vi.fn(async () => false),
  updateMap: vi.fn(),
  listMapsForUser: vi.fn(async () => []),
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => 'view'),
  hasPermission: (actual: string | null) => actual != null,
}));
vi.mock('../../db/versions.js', () => ({ listVersions: vi.fn(async () => []) }));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../lib/velocityMeasure.js', () => ({ measureMapVelocity: vi.fn(async () => { throw new Error('no rates'); }) }));
vi.mock('../../lib/releaseForecast.js', () => ({
  computeReleaseForecast: vi.fn(() => ({
    releases: [{ versionId: 'v1', plannedFinishDate: '2026-11-10', velocityAdjustedFinishDate: '2026-11-20' }],
  })),
}));
vi.mock('../../lib/releaseSnapshots.js', () => ({ snapshotReleaseForecastForMap: vi.fn() }));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));
vi.mock('../../db/schema.js', () => ({ workspaces: {}, users: {}, releaseSnapshots: {} }));
vi.mock('drizzle-orm', () => ({
  and: (...preds: unknown[]) => preds,
  eq: () => null,
  lte: (_col: unknown, cutoff: string) => ({ cutoff }),
  desc: () => null,
}));
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (pred: unknown) => {
          const cutoff = Array.isArray(pred)
            ? (pred.find((p) => p && typeof p === 'object' && 'cutoff' in (p as object)) as { cutoff: string } | undefined)?.cutoff
            : undefined;
          const rows = snapshots
            .filter((r) => cutoff == null || r.snapshotDate <= cutoff)
            .sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
          const ordered = Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
          return { orderBy: () => ordered };
        },
      }),
    }),
  },
}));

import { mapRoutes } from '../maps.js';

async function get(qs = ''): Promise<{ releases: Array<Record<string, unknown>> }> {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'u';
    req.authSource = 'jwt';
  });
  await app.register(mapRoutes);
  const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/release-forecast${qs}` });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json();
}

beforeEach(() => {
  snapshots = [
    { versionId: 'v1', snapshotDate: isoDaysAgo(8), plannedFinishDate: '2026-11-08', velocityAdjustedFinishDate: '2026-11-15', createdAt: new Date() },
    { versionId: 'v1', snapshotDate: isoDaysAgo(20), plannedFinishDate: '2026-11-01', velocityAdjustedFinishDate: '2026-11-05', createdAt: new Date() },
  ];
});

describe('GET /release-forecast trend (#321)', () => {
  it('7-day fields unchanged, no trend block without ?trendDays', async () => {
    const [row] = (await get()).releases;
    expect(row.plannedFinishDeltaDays7d).toBe(2);
    expect(row.velocityFinishDeltaDays7d).toBe(5);
    expect(row).not.toHaveProperty('trend');
  });

  it('?trendDays=14 compares against the snapshot at or before 14 days ago; 7-day fields stay', async () => {
    const [row] = (await get('?trendDays=14')).releases;
    expect(row.velocityFinishDeltaDays7d).toBe(5);
    expect(row.trend).toEqual({
      days: 14,
      fromDate: isoDaysAgo(20),
      fromVelocityFinishDate: '2026-11-05',
      fromPlannedFinishDate: '2026-11-01',
      plannedFinishDeltaDays: 9,
      velocityFinishDeltaDays: 15,
    });
  });

  it('invalid trendDays is ignored', async () => {
    for (const bad of ['0', 'abc', '91', '2.5']) {
      expect((await get(`?trendDays=${bad}`)).releases[0]).not.toHaveProperty('trend');
    }
  });
});
