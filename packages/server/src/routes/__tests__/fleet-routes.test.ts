/**
 * Fleet telemetry routes — the contract the satellites' rollup.sh and the
 * orchestrator push against, and what the Fleet card reads back. Keyed by
 * fleet since #479: the map routes forward to the map's fleet, the fleet
 * routes take the fleet id.
 *
 * DB layers stubbed, services real: what is pinned here is the forwarding
 * (a v1 push through a map lands on its fleet), the 409 for a map without a
 * fleet, the shape checks, the fleet:updated broadcast to every connected
 * map, the tick timestamp handling, and the redaction of claims on maps the
 * reader can't view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const FLEET = '11111111-1111-4111-8111-111111111111';
const MAP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const upsertRollupMock = vi.fn();
const insertTickMock = vi.fn();
const listRollupsMock = vi.fn(async () => [] as unknown[]);
const listTicksMock = vi.fn(async () => [] as unknown[]);
const broadcastMock = vi.fn();

const originMock = vi.fn(async () => null as unknown);
vi.mock('../../db/fleet.js', () => ({
  getRollupOrigin: (...args: unknown[]) => originMock(...(args as [])),
  upsertRollup: (...args: unknown[]) => upsertRollupMock(...args),
  insertTick: (...args: unknown[]) => insertTickMock(...args),
  listRollups: (...args: unknown[]) => listRollupsMock(...(args as [])),
  listTicks: (...args: unknown[]) => listTicksMock(...(args as [])),
}));
vi.mock('../../ws.js', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }));
// Every node id in these tests hangs on MAP_A except `on-b` and `on-lone`.
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'on-b' ? MAP_B : id === 'on-lone' ? LONE : MAP_A) }));

// One fleet serving maps A and B; LONE has no fleet. The reader sees A
// (and LONE), not B — B's claims must come back redacted.
const state = vi.hoisted(() => ({
  perm: {} as Record<string, 'admin' | 'edit' | 'view' | null>,
  visibleMaps: [] as string[],
  ownerId: 'owner-1',
}));
vi.mock('../../db/fleets.js', () => ({
  isFleetId: () => true,
  getMapFleetId: async (mapId: string) => (mapId === MAP_A || mapId === MAP_B ? FLEET : null),
  getFleet: async (id: string) =>
    id === FLEET ? { id: FLEET, name: 'Fleet', ownerId: state.ownerId, maxActiveClaims: 0, createdAt: 'c', updatedAt: 'u' } : null,
  listFleetMaps: async (id: string) =>
    id === FLEET
      ? [MAP_A, MAP_B].map((m) => ({ id: m, name: m === MAP_A ? 'Alpha' : 'Beta', fleetShare: 1, maxActiveClaims: 1, archivedAt: null }))
      : [],
}));
vi.mock('../../db/maps.js', () => ({
  listMapsForUser: async () => state.visibleMaps.map((id) => ({ id, fleetId: id === LONE ? null : FLEET })),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (p: string | null, need: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return p != null && rank[p] >= rank[need];
  },
}));

import { fleetRoutes, fleetTelemetryRoutes } from '../fleet.js';

async function buildApp(opts: { anonymous?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Every route is guarded (#405): the satellites send the Fleet user's key.
  app.addHook('preHandler', async (req) => {
    if (!opts.anonymous) req.userId = 'user-1';
  });
  await app.register(fleetRoutes);
  await app.register(fleetTelemetryRoutes);
  return app;
}

const rollup = {
  v: 1,
  host: 'njoerd',
  generated_at: '2026-09-01T10:00:00Z',
  map_id: MAP_A,
  draining: null,
  workers: [{ v: 1, session: 'njoerd:worker-1:default', state: 'parked', claim: null }],
  counts: { parked: 1 },
  dead: [],
};

const statusRow = (host: string, mapIds: string[], workers: unknown[]) => ({
  host,
  generatedAt: '2026-09-01T10:00:00.000Z',
  receivedAt: '2026-09-01T10:00:05.000Z',
  mapIds,
  rollup: { v: 2, host, generated_at: '2026-09-01T10:00:00Z', maps: mapIds, workers },
});

beforeEach(() => {
  // Pushes ask permissions (edit on every map named / of the fleet); reads
  // ask the visible-map list. Kept apart so each rule is tested on its own.
  state.perm = { [MAP_A]: 'admin', [MAP_B]: 'edit', [LONE]: 'admin' };
  state.visibleMaps = [MAP_A, LONE];
  originMock.mockReset();
  originMock.mockResolvedValue(null);
  state.ownerId = 'owner-1';
  upsertRollupMock.mockReset();
  upsertRollupMock.mockImplementation(async (_f: string, r: { host: string }, via: string | null) => ({
    host: r.host,
    generatedAt: '2026-09-01T10:00:00.000Z',
    receivedAt: '2026-09-01T10:00:05.000Z',
    mapIds: via ? [via] : [],
    rollup: r,
  }));
  insertTickMock.mockReset();
  insertTickMock.mockResolvedValue({ id: 't1', tickAt: '2026-09-01T10:30:00.000Z', receivedAt: '2026-09-01T10:30:02.000Z', payload: {} });
  broadcastMock.mockReset();
  listRollupsMock.mockReset();
  listRollupsMock.mockResolvedValue([]);
  listTicksMock.mockReset();
  listTicksMock.mockResolvedValue([]);
});

describe('PUT /api/maps/:id/fleet-status/:host', () => {
  it('forwards a v1 rollup to the map\'s fleet and broadcasts to every connected map', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(upsertRollupMock).toHaveBeenCalledWith(FLEET, expect.objectContaining({ host: 'njoerd', workers: rollup.workers }), MAP_A);
    for (const m of [MAP_A, MAP_B]) {
      expect(broadcastMock).toHaveBeenCalledWith(m, expect.objectContaining({ type: 'fleet:updated', kind: 'rollup', host: 'njoerd' }));
    }
    expect(res.json()).toMatchObject({ host: 'njoerd', workers: 1, fleetId: FLEET, mapIds: [MAP_A] });
  });

  it('refuses a push for a map without a fleet with 409 and a hint', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${LONE}/fleet-status/njoerd`, payload: { ...rollup, map_id: LONE } });
    const tick = await app.inject({ method: 'POST', url: `/api/maps/${LONE}/fleet-ticks`, payload: { assessment: 'x' } });
    await app.close();
    expect([res.statusCode, tick.statusCode]).toEqual([409, 409]);
    expect(res.json().error.code).toBe('NO_FLEET');
    expect(res.json().error.message).toMatch(/Connect it first/);
    expect(upsertRollupMock).not.toHaveBeenCalled();
    expect(insertTickMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed body, a host mismatch, and a rollup for another map', async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { host: 'njoerd' } });
    const mismatch = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/sat2`, payload: rollup });
    const otherMap = await app.inject({ method: 'PUT', url: `/api/maps/${LONE}/fleet-status/njoerd`, payload: rollup });
    const badMaps = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { ...rollup, maps: 'all' } });
    await app.close();
    expect([bad.statusCode, mismatch.statusCode, otherMap.statusCode, badMaps.statusCode]).toEqual([400, 400, 400, 400]);
    expect(upsertRollupMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('a v2 rollup through a map route must list that map and only maps of the fleet', async () => {
    const v2 = { ...rollup, v: 2, map_id: undefined };
    const app = await buildApp();
    const notListed = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { ...v2, maps: [MAP_B] } });
    const stray = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { ...v2, maps: [MAP_A, LONE] } });
    const ok = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { ...v2, maps: [MAP_A, MAP_B] } });
    await app.close();
    expect([notListed.statusCode, stray.statusCode, ok.statusCode]).toEqual([400, 400, 200]);
    expect(stray.json().error.message).toContain(LONE);
    expect(upsertRollupMock).toHaveBeenCalledTimes(1);
  });

  it('a v1 host already reporting for another map of the fleet gets 409 instead of flapping', async () => {
    originMock.mockResolvedValue({ viaMapId: MAP_B, receivedAt: new Date().toISOString() });
    const app = await buildApp();
    const fresh = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    originMock.mockResolvedValue({ viaMapId: MAP_B, receivedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const stale = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    originMock.mockResolvedValue({ viaMapId: MAP_A, receivedAt: new Date().toISOString() });
    const same = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    await app.close();
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json().error.code).toBe('HOST_SERVES_SEVERAL_MAPS');
    // A stale row from the other map (the host moved) or its own map's row is fine.
    expect([stale.statusCode, same.statusCode]).toEqual([200, 200]);
  });

  it('a v2 rollup naming a map the pusher can\'t edit is refused', async () => {
    state.perm[MAP_B] = 'view';
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: { ...rollup, v: 2, map_id: undefined, maps: [MAP_A, MAP_B] } });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });

  it('refuses a free-form host key (host is half the PK)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/${encodeURIComponent('a b/../c')}`, payload: { ...rollup, host: 'a b/../c' } });
    const long = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/${'h'.repeat(65)}`, payload: { ...rollup, host: 'h'.repeat(65) } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(long.statusCode).toBe(400);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });

  it('rejects a body over the push limit', async () => {
    const app = await buildApp();
    const fat = { ...rollup, workers: Array.from({ length: 3000 }, (_, i) => ({ session: `njoerd:worker-${i}:default`, state: 'parked', claim: null, blocked_nodes: [] })) };
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: fat });
    await app.close();
    expect(res.statusCode).toBe(413);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/maps/:id/fleet-ticks', () => {
  it('stores the decision on the map\'s fleet with the given tickAt and broadcasts', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_A}/fleet-ticks`,
      payload: { tickAt: '2026-08-31T10:30:00Z', assessment: 'fleet idle', anomalies: [], asks: ['#1: decide'] },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(res.json().fleetId).toBe(FLEET);
    const [fleetId, payload, tickAt, via] = insertTickMock.mock.calls[0] as [string, Record<string, unknown>, Date, string];
    expect([fleetId, via]).toEqual([FLEET, MAP_A]);
    expect(payload).toMatchObject({ assessment: 'fleet idle', asks: ['#1: decide'] });
    expect(payload).not.toHaveProperty('tickAt'); // column, not payload
    expect(tickAt.toISOString()).toBe('2026-08-31T10:30:00.000Z');
    expect(broadcastMock).toHaveBeenCalledWith(MAP_B, expect.objectContaining({ type: 'fleet:updated', kind: 'tick' }));
  });

  it('a tick needs edit on every map of the fleet (every cockpit shows it)', async () => {
    state.perm[MAP_B] = 'view';
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_A}/fleet-ticks`, payload: { assessment: 'x' } });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(insertTickMock).not.toHaveBeenCalled();
  });

  it('falls back to now for a missing/invalid/future tickAt and rejects a non-object body', async () => {
    const app = await buildApp();
    const before = Date.now();
    const ok = await app.inject({ method: 'POST', url: `/api/maps/${MAP_A}/fleet-ticks`, payload: { tickAt: 'yesterday', assessment: 'x' } });
    const future = await app.inject({ method: 'POST', url: `/api/maps/${MAP_A}/fleet-ticks`, payload: { tickAt: '2099-01-01T00:00:00Z', assessment: 'x' } });
    const bad = await app.inject({ method: 'POST', url: `/api/maps/${MAP_A}/fleet-ticks`, payload: '"just a string"', headers: { 'content-type': 'application/json' } });
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
  it('reads the map\'s fleet: hosts serving this map only, claims on maps the reader can\'t view redacted', async () => {
    listRollupsMock.mockResolvedValueOnce([
      statusRow('both', [MAP_A, MAP_B], [
        { session: 'both:worker-1:default', state: 'working', claim: { mapId: MAP_A, nodeId: 'n1', title: 'Visible ticket' } },
        {
          session: 'both:worker-2:default',
          state: 'prompt',
          claim: { mapId: MAP_B, nodeId: 'n2', title: 'Secret ticket' },
          prompt_question: 'Secret: merge the payroll PR?',
          waiting: { since: 'x', reason: 'Secret review' },
          pr_number: 4711,
          blocked_nodes: [{ node: 'secret-node', at: 'x' }],
        },
      ]),
      statusRow('only-b', [MAP_B], [{ session: 'only-b:worker-1:default', state: 'parked', claim: null }]),
    ]);
    listTicksMock.mockResolvedValueOnce([
      { id: 't1', tickAt: 'a', receivedAt: 'b', payload: { assessment: 'Secret: B is stuck on payroll', asks: ['Secret ask'], summary: { claims: 2, cap: 4 } } },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fleetId).toBe(FLEET);
    expect(body.hosts.map((h: { host: string }) => h.host)).toEqual(['both']);
    const [visible, hidden] = body.hosts[0].rollup.workers;
    expect(visible.claim.title).toBe('Visible ticket');
    expect(hidden.claim).toEqual({ redacted: true });
    // Everything else about B's ticket goes with the claim.
    for (const k of ['prompt_question', 'waiting', 'pr_number', 'blocked_nodes']) expect(hidden).not.toHaveProperty(k);
    expect(body.hosts[0].mapIds).toEqual([MAP_A]);
    expect(body.hosts[0].rollup.maps).toEqual([MAP_A]);
    // The reader can't view B: the tick keeps its numbers, loses its prose.
    expect(body.ticks[0].payload).toEqual({ redacted: true, summary: { claims: 2, cap: 4 } });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
    expect(listTicksMock).toHaveBeenCalledWith(FLEET, { since: null, until: null, limit: 20 });
    expect(body.window).toEqual({ since: null, until: null, limit: 20 });
  });

  it('a reader who sees every map of the fleet gets the full tick', async () => {
    state.visibleMaps = [MAP_A, MAP_B];
    listTicksMock.mockResolvedValueOnce([{ id: 't1', tickAt: 'a', receivedAt: 'b', payload: { assessment: 'all fine' } }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet` });
    await app.close();
    expect(res.json().ticks[0].payload).toEqual({ assessment: 'all fine' });
  });

  it('is an empty read for a map without a fleet', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${LONE}/fleet` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fleetId: null, hosts: [], ticks: [] });
    expect(listRollupsMock).not.toHaveBeenCalled();
  });

  it('forwards since/until/limit to the store and echoes the window', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?since=2026-09-01T20:00:00Z&until=2026-09-02T06:00:00Z&limit=50` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const [fleetId, window] = listTicksMock.mock.calls[0] as unknown as [string, { since: Date; until: Date; limit: number }];
    expect(fleetId).toBe(FLEET);
    expect(window.since.toISOString()).toBe('2026-09-01T20:00:00.000Z');
    expect(window.until.toISOString()).toBe('2026-09-02T06:00:00.000Z');
    expect(window.limit).toBe(50);
    expect(res.json().window).toEqual({ since: '2026-09-01T20:00:00.000Z', until: '2026-09-02T06:00:00.000Z', limit: 50 });
  });

  it('defaults to the full history limit with since, clamps limit to 1..500', async () => {
    const app = await buildApp();
    const dflt = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?since=2026-09-01T20:00:00Z` });
    const high = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?limit=100000` });
    const low = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?limit=0` });
    await app.close();
    expect(dflt.json().window.limit).toBe(500);
    expect(high.json().window.limit).toBe(500);
    expect(low.json().window.limit).toBe(1);
    expect(listTicksMock.mock.calls.map((c) => (c as unknown as [string, { limit: number }])[1].limit)).toEqual([500, 500, 1]);
  });

  it('refuses an unparsable date or limit with 400 instead of silently returning the default window', async () => {
    const app = await buildApp();
    const since = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?since=yesterday` });
    const until = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?until=soon` });
    const limit = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?limit=many` });
    const repeated = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet?since=2026-09-01T00:00:00Z&since=2026-09-02T00:00:00Z` });
    await app.close();
    expect([since.statusCode, until.statusCode, limit.statusCode, repeated.statusCode]).toEqual([400, 400, 400, 400]);
    expect(since.json().error.code).toBe('VALIDATION_ERROR');
    expect(listTicksMock).not.toHaveBeenCalled();
  });
});

describe('telemetry pushes need a credential with edit on the map (#405)', () => {
  it('an anonymous rollup or tick is refused with 401 and stores nothing', async () => {
    const app = await buildApp({ anonymous: true });
    const put = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    const post = await app.inject({ method: 'POST', url: `/api/maps/${MAP_A}/fleet-ticks`, payload: { decision: 'hold' } });
    const fleetPut = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/njoerd`, payload: rollup });
    await app.close();
    expect([put.statusCode, post.statusCode, fleetPut.statusCode]).toEqual([401, 401, 401]);
    expect(upsertRollupMock).not.toHaveBeenCalled();
    expect(insertTickMock).not.toHaveBeenCalled();
  });

  it('a view-only member may read the Fleet card but not push to it', async () => {
    state.perm[MAP_A] = 'view';
    const app = await buildApp();
    const put = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_A}/fleet-status/njoerd`, payload: rollup });
    const get = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet` });
    await app.close();
    expect(put.statusCode).toBe(403);
    expect(get.statusCode).toBe(200);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });
});

describe('agent output tail (#585)', () => {
  const v2 = { v: 2, host: 'big', generated_at: '2026-09-01T10:00:00Z', maps: [MAP_A, MAP_B], workers: [] };
  const withTail = (host: string, mapIds: string[], generatedAt: string, claims: unknown[]) => {
    const row = statusRow(host, mapIds, []);
    return { ...row, generatedAt, rollup: { ...row.rollup, generated_at: generatedAt, claims } };
  };

  it('a pushed tail is kept to the last 100 lines; a non-list tail is dropped, not the phase', async () => {
    const tail = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const claims = [
      { nodeId: 'n1', mapId: MAP_A, phase: 'working', tail },
      { nodeId: 'n2', mapId: MAP_A, phase: 'working', tail: 'nope' },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: { ...v2, claims } });
    await app.close();
    expect(res.statusCode).toBe(200);
    const stored = upsertRollupMock.mock.calls[0][1].claims;
    expect(stored[0].tail).toHaveLength(100);
    expect(stored[0].tail[0]).toBe('line 20');
    expect(stored[1]).toEqual({ nodeId: 'n2', mapId: MAP_A, phase: 'working' });
  });

  it('the minute-poll fleet read never carries the tail', async () => {
    listRollupsMock.mockResolvedValueOnce([
      withTail('big', [MAP_A], '2026-09-01T10:00:00.000Z', [{ nodeId: 'n1', mapId: MAP_A, phase: 'working', tail: ['secret line'] }]),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet` });
    await app.close();
    expect(res.json().hosts[0].rollup.claims).toEqual([{ nodeId: 'n1', mapId: MAP_A, phase: 'working' }]);
    expect(res.body).not.toMatch(/secret line/);
  });

  it('the tail route returns the newest report for the ticket on this map', async () => {
    listRollupsMock.mockResolvedValueOnce([
      withTail('old', [MAP_A], '2026-09-01T09:00:00.000Z', [{ nodeId: 'n1', mapId: MAP_A, phase: 'working', tail: ['old'] }]),
      withTail('new', [MAP_A, MAP_B], '2026-09-01T10:00:00.000Z', [
        { nodeId: 'n1', mapId: MAP_A, phase: 'fixing', tail: ['a', 'b'] },
        { nodeId: 'n1', mapId: MAP_B, phase: 'working', tail: ['other map'] },
      ]),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet/tail/n1` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().tail).toEqual({ lines: ['a', 'b'], at: '2026-09-01T10:00:00.000Z', host: 'new', phase: 'fixing' });
  });

  it('is null for a ticket without output and for a map without a fleet', async () => {
    const app = await buildApp();
    const none = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet/tail/n1` });
    const lone = await app.inject({ method: 'GET', url: `/api/maps/${LONE}/fleet/tail/on-lone` });
    await app.close();
    expect(none.json().tail).toBeNull();
    expect(lone.json().tail).toBeNull();
  });

  it("a node of another map is a 404, like any guarded node route", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet/tail/on-b` });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it('needs edit on the map: a view-only member gets 403', async () => {
    state.perm[MAP_A] = 'view';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet/tail/n1` });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(listRollupsMock).not.toHaveBeenCalled();
  });
});

describe('fleet routes (#479)', () => {
  const v2 = { v: 2, host: 'big', generated_at: '2026-09-01T10:00:00Z', maps: [MAP_A, MAP_B], workers: [] };

  it('a v2 rollup naming two maps is stored once on the fleet', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: v2 });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(upsertRollupMock).toHaveBeenCalledWith(FLEET, expect.objectContaining({ maps: [MAP_A, MAP_B] }), null);
  });

  it('#546: the claims list is stored with the rollup; a malformed entry is dropped, not the push', async () => {
    const claims = [{ nodeId: 'n1', mapId: MAP_A, phase: 'pr', ci: 'pending', pr_number: 7, phase_since: '2026-09-01T09:50:00Z' }, { phase: 'pr' }];
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: { ...v2, claims } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(upsertRollupMock).toHaveBeenCalledWith(FLEET, expect.objectContaining({ claims: [claims[0]] }), null);
  });

  it("#546: a read drops the phases of tickets on maps the reader can't view", async () => {
    const row = statusRow('big', [MAP_A, MAP_B], []);
    listRollupsMock.mockResolvedValueOnce([
      { ...row, rollup: { ...row.rollup, claims: [{ nodeId: 'n1', mapId: MAP_A, phase: 'working' }, { nodeId: 'secret-n2', mapId: MAP_B, phase: 'pr' }] } },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_A}/fleet` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().hosts[0].rollup.claims).toEqual([{ nodeId: 'n1', mapId: MAP_A, phase: 'working' }]);
  });

  it('a fleet-route rollup without maps[] is refused (it would serve no map)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: { ...v2, maps: undefined } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(upsertRollupMock).not.toHaveBeenCalled();
  });

  it('pushes need the owner or edit on the maps involved; a fleet the user can\'t read is a 404', async () => {
    state.perm[MAP_A] = 'view';
    const app = await buildApp();
    const viewOnly = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: v2 });
    state.ownerId = 'user-1';
    const owner = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/fleet-ticks`, payload: { assessment: 'x' } });
    state.ownerId = 'owner-1';
    state.visibleMaps = [];
    const stranger = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/fleet-status/big`, payload: v2 });
    await app.close();
    expect([viewOnly.statusCode, owner.statusCode, stranger.statusCode]).toEqual([403, 201, 404]);
    expect(insertTickMock).toHaveBeenCalledWith(FLEET, expect.anything(), expect.any(Date), null);
  });

  it('the fleet read shows every host, with the hidden map dropped and its claims redacted', async () => {
    listRollupsMock.mockResolvedValueOnce([
      statusRow('both', [MAP_A, MAP_B], [{ session: 's2', state: 'working', claim: { mapId: MAP_B, nodeId: 'n2', title: 'Secret ticket' } }]),
      statusRow('only-b', [MAP_B], [{ session: 's3', state: 'working', claim: { nodeId: 'n3', title: 'Also secret' } }]),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/fleet` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hosts.map((h: { host: string }) => h.host)).toEqual(['both', 'only-b']);
    expect(body.hosts[1].mapIds).toEqual([]);
    // A claim without a mapId belongs to the host's only map — B, hidden.
    expect(body.hosts[1].rollup.workers[0].claim).toEqual({ redacted: true });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
  });
});
