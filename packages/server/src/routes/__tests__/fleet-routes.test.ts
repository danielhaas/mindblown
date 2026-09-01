/**
 * Fleet telemetry routes — the contract the satellites' rollup.sh and the
 * orchestrator push against, and what the Fleet card reads back.
 * DB layer stubbed; the interesting assertions are the shape checks
 * (a rollup for the wrong host/map is refused), the fleet:updated
 * broadcast, and the tick timestamp handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const upsertRollupMock = vi.fn();
const insertTickMock = vi.fn();
const listRollupsMock = vi.fn(async () => []);
const listTicksMock = vi.fn(async () => []);
const broadcastMock = vi.fn();

vi.mock('../../db/fleet.js', () => ({
  upsertRollup: (...args: unknown[]) => upsertRollupMock(...args),
  insertTick: (...args: unknown[]) => insertTickMock(...args),
  listRollups: (...args: unknown[]) => listRollupsMock(...(args as [])),
  listTicks: (...args: unknown[]) => listTicksMock(...(args as [])),
}));
vi.mock('../../ws.js', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }));

import { fleetRoutes } from '../fleet.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fleetRoutes);
  return app;
}

const rollup = {
  v: 1,
  host: 'njoerd',
  generated_at: '2026-09-01T10:00:00Z',
  map_id: MAP_ID,
  draining: null,
  workers: [{ v: 1, session: 'njoerd:worker-1:default', state: 'parked', claim: null }],
  counts: { parked: 1 },
  dead: [],
};

beforeEach(() => {
  upsertRollupMock.mockReset();
  insertTickMock.mockReset();
  broadcastMock.mockReset();
  listRollupsMock.mockClear();
  listTicksMock.mockClear();
});

describe('PUT /api/maps/:id/fleet-status/:host', () => {
  it('stores a v1 rollup verbatim and broadcasts fleet:updated', async () => {
    upsertRollupMock.mockResolvedValueOnce({ host: 'njoerd', generatedAt: '2026-09-01T10:00:00.000Z', receivedAt: '2026-09-01T10:00:05.000Z', rollup });
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/njoerd`, payload: rollup });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(upsertRollupMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ host: 'njoerd', workers: rollup.workers }));
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'fleet:updated', kind: 'rollup', host: 'njoerd' }));
    expect(res.json()).toMatchObject({ host: 'njoerd', workers: 1 });
  });

  it('refuses a malformed body, a host mismatch, and a rollup for another map', async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/njoerd`, payload: { host: 'njoerd' } });
    const mismatch = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/sat2`, payload: rollup });
    const otherMap = await app.inject({ method: 'PUT', url: `/api/maps/other-map/fleet-status/njoerd`, payload: rollup });
    await app.close();
    expect([bad.statusCode, mismatch.statusCode, otherMap.statusCode]).toEqual([400, 400, 400]);
    expect(upsertRollupMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses a free-form host key (unauthenticated route, host is half the PK)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/${encodeURIComponent('a b/../c')}`, payload: { ...rollup, host: 'a b/../c' } });
    const long = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/${'h'.repeat(65)}`, payload: { ...rollup, host: 'h'.repeat(65) } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(long.statusCode).toBe(400);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });

  it('rejects a body over the push limit', async () => {
    const app = await buildApp();
    const fat = { ...rollup, workers: Array.from({ length: 3000 }, (_, i) => ({ session: `njoerd:worker-${i}:default`, state: 'parked', claim: null, blocked_nodes: [] })) };
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/njoerd`, payload: fat });
    await app.close();
    expect(res.statusCode).toBe(413);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });

  it('maps an FK violation to 404', async () => {
    upsertRollupMock.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/fleet-status/njoerd`, payload: rollup });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/maps/:id/fleet-ticks', () => {
  it('stores the decision with the given tickAt and broadcasts', async () => {
    insertTickMock.mockResolvedValueOnce({ id: 't1', tickAt: '2026-09-01T10:30:00.000Z', receivedAt: '2026-09-01T10:30:02.000Z', payload: {} });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/fleet-ticks`,
      payload: { tickAt: '2026-08-31T10:30:00Z', assessment: 'fleet idle', anomalies: [], asks: ['#1: decide'] },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    const [mapId, payload, tickAt] = insertTickMock.mock.calls[0] as [string, Record<string, unknown>, Date];
    expect(mapId).toBe(MAP_ID);
    expect(payload).toMatchObject({ assessment: 'fleet idle', asks: ['#1: decide'] });
    expect(payload).not.toHaveProperty('tickAt'); // column, not payload
    expect(tickAt.toISOString()).toBe('2026-08-31T10:30:00.000Z');
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'fleet:updated', kind: 'tick' }));
  });

  it('falls back to now for a missing/invalid/future tickAt and rejects a non-object body', async () => {
    insertTickMock.mockResolvedValue({ id: 't2', tickAt: 'x', receivedAt: 'y', payload: {} });
    const app = await buildApp();
    const before = Date.now();
    const ok = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/fleet-ticks`, payload: { tickAt: 'yesterday', assessment: 'x' } });
    const future = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/fleet-ticks`, payload: { tickAt: '2099-01-01T00:00:00Z', assessment: 'x' } });
    const bad = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/fleet-ticks`, payload: '"just a string"', headers: { 'content-type': 'application/json' } });
    await app.close();
    expect(ok.statusCode).toBe(201);
    expect(future.statusCode).toBe(201);
    for (const call of insertTickMock.mock.calls) {
      const tickAt = call[2] as Date;
      expect(tickAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(tickAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /api/maps/:id/fleet', () => {
  it('returns hosts, recent ticks and the server clock', async () => {
    listRollupsMock.mockResolvedValueOnce([{ host: 'njoerd', generatedAt: 'g', receivedAt: 'r', rollup }] as never);
    listTicksMock.mockResolvedValueOnce([{ id: 't1', tickAt: 'a', receivedAt: 'b', payload: { assessment: 'x' } }] as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/fleet` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().hosts).toHaveLength(1);
    expect(res.json().ticks[0].payload.assessment).toBe('x');
    expect(typeof res.json().now).toBe('string');
    expect(listTicksMock).toHaveBeenCalledWith(MAP_ID, 20);
  });
});
