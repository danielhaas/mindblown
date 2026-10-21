/**
 * Asks inbox routes — the contract the orchestrator pushes against and the
 * Questions section (Fleet tab) / MCP tools read and answer through. DB + service stubbed;
 * what matters here: auth (edit for push/answer, view for read), the
 * document shape check, the map_id mismatch refusal, the asks:updated
 * broadcast, and the answer fan-out (node:updated + GitHub sync).
 *
 * Keyed by fleet since #479: the map routes forward to the map's fleet
 * (409 without one); the fleet routes take a fleet-wide collector's push,
 * scope the read to the maps the reader can view, and resolve an answer
 * to one row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const FLEET = 'ffff-ffff';
const MAP_ID = 'mmmm-mmmm';
const OTHER = 'oooo-oooo';
const LONE = 'llll-llll';

const replaceAsksMock = vi.fn();
const listAsksMock = vi.fn(async () => []);
const findAsksMock = vi.fn(async () => [] as unknown[]);
const getPushMetaMock = vi.fn(async () => null);
const clearWorkerPendingMock = vi.fn(async () => 1);
const answerAskMock = vi.fn();
const syncMock = vi.fn(async () => {});
const broadcastMock = vi.fn();
const openDerivedAsksMock = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const state = vi.hoisted(() => ({
  perm: {} as Record<string, string | null>,
  view: null as unknown,
}));

vi.mock('../../db/asks.js', () => ({
  replaceAsks: (...a: unknown[]) => replaceAsksMock(...a),
  listAsks: (...a: unknown[]) => listAsksMock(...(a as [])),
  findAsks: (...a: unknown[]) => findAsksMock(...(a as [])),
  getPushMeta: (...a: unknown[]) => getPushMetaMock(...(a as [])),
  clearWorkerPending: (...a: unknown[]) => clearWorkerPendingMock(...(a as [])),
}));
vi.mock('../../db/fleet.js', () => ({}));
vi.mock('../../db/fleets.js', () => ({
  getMapFleetId: async (id: string) => (id === LONE ? null : FLEET),
  listFleetMaps: async () => [{ id: MAP_ID }, { id: OTHER }],
}));
vi.mock('../../services/fleets.js', () => ({ getFleetForUser: async () => state.view }));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../services/asks.js', async () => {
  const real = await vi.importActual<typeof import('../../services/asks.js')>('../../services/asks.js');
  return { ...real, answerAsk: (...a: unknown[]) => answerAskMock(...a) };
});
vi.mock('../../services/derivedAsks.js', () => ({ openDerivedAsks: (...a: unknown[]) => openDerivedAsksMock(...a) }));
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'stuck-node' ? OTHER : null) }));
vi.mock('../nodes.js', () => ({ syncNodeToGitHub: (...a: unknown[]) => syncMock(...(a as [])) }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));

import { asksRoutes } from '../asks.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId });
  });
  await app.register(asksRoutes);
  return app;
}

const doc = {
  meta: { generated_at: '2026-09-03T08:00:00', tick: '20260903T0800Z', map_id: MAP_ID, counts: { total: 1 } },
  items: [{ id: '#6823', ticket: 6823, question: 'skip or keep?', answerer: 'Dan', hint: 'decision', unblocks: { node_id: 'n1' } }],
};

/** A reader of MAP_ID only — OTHER is hidden, so fleet-level asks and fleet-wide counts are too. */
const partialView = { id: FLEET, isOwner: false, hiddenMapCount: 1, maps: [{ id: MAP_ID, name: 'Alpha' }] };
const fullView = { id: FLEET, isOwner: false, hiddenMapCount: 0, maps: [{ id: MAP_ID, name: 'Alpha' }, { id: OTHER, name: 'Beta' }] };

beforeEach(() => {
  vi.clearAllMocks();
  state.perm = { [MAP_ID]: 'edit', [OTHER]: 'edit', [LONE]: 'edit' };
  state.view = fullView;
  userId = 'u1';
  replaceAsksMock.mockResolvedValue({ pushedAt: '2026-09-03T08:01:00.000Z', received: 1, removed: 0, kept: 0 });
});

describe('PUT /api/maps/:id/asks', () => {
  it('stores the collector document on the map\'s fleet, every item on this map, and broadcasts', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ pushedAt: '2026-09-03T08:01:00.000Z', received: 1, removed: 0, kept: 0, fleetId: FLEET });
    expect(replaceAsksMock).toHaveBeenCalledWith(
      FLEET,
      MAP_ID,
      [{ ask: expect.objectContaining({ id: '#6823', ticket: 6823, unblocks: expect.objectContaining({ node_id: 'n1' }) }), mapId: MAP_ID }],
      doc.meta,
    );
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'asks:updated', kind: 'push' }));
    await app.close();
  });

  it('refuses a document for another map, a malformed body, and a viewer', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: { ...doc, meta: { map_id: 'other' } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: { meta: {} } });
    expect(res.statusCode).toBe(400);
    state.perm[MAP_ID] = 'view';
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(403);
    userId = undefined;
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(401);
    expect(replaceAsksMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('a map without a fleet gets 409 with a hint', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${LONE}/asks`, payload: { ...doc, meta: {} } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_FLEET');
    expect(replaceAsksMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/maps/:id/asks', () => {
  it('defaults to open, reads this map of the fleet, returns counts + push meta', async () => {
    state.perm[MAP_ID] = 'view';
    getPushMetaMock.mockResolvedValueOnce({ pushedAt: '2026-09-03T08:01:00.000Z', meta: { tick: 't' }, fleetWide: false } as never);
    listAsksMock.mockResolvedValueOnce([
      { ask: { ...doc.items[0], answerer: 'Rita', hint: 'decision', priority: null, idle_hours: 1, sources: [], options: [], unblocks: {} }, status: 'open' },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/asks?answerer=Rita&limit=5` });
    expect(res.statusCode).toBe(200);
    expect(listAsksMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: MAP_ID }, { status: 'open', hint: undefined, answerer: 'Rita', since: undefined, limit: 5 });
    const body = JSON.parse(res.body);
    expect(body.counts).toEqual({ total: 1, byAnswerer: { Rita: 1 }, byHint: { decision: 1 }, byStatus: { open: 1 } });
    expect(body.pushedAt).toBe('2026-09-03T08:01:00.000Z');
    expect(body.meta).toEqual({ tick: 't' });
    await app.close();
  });

  it('cuts a fleet-wide push\'s meta to its time for a reader who can\'t view every map', async () => {
    state.view = partialView;
    getPushMetaMock.mockResolvedValueOnce({ pushedAt: 'p', meta: { generated_at: 'g', tick: 't', counts: { total: 9, by_answerer: { Dan: 9 } } }, fleetWide: true } as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/asks` });
    expect(res.json().meta).toEqual({ generated_at: 'g', tick: 't' });
    await app.close();
  });

  it('is empty for a map without a fleet, and rejects an unknown status', async () => {
    const app = await buildApp();
    const lone = await app.inject({ method: 'GET', url: `/api/maps/${LONE}/asks` });
    expect(lone.json()).toMatchObject({ items: [], pushedAt: null });
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/asks?status=bogus` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/maps/:id/asks/:askId/answer', () => {
  it('runs the service with the row key and fans out node:updated + GitHub sync + asks:updated', async () => {
    const node = { id: 'n1', mapId: MAP_ID, status: 'todo' };
    answerAskMock.mockResolvedValueOnce({
      row: { ask: doc.items[0], status: 'answered', writes: [] },
      plan: { github: null, node: null, worker: null, skip: null },
      ok: true,
      node,
      changedFields: ['blockedReason', 'description', 'tags', 'status'],
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/${encodeURIComponent('#6823')}/answer`, payload: { action: 'answered', decision: 'skip' } });
    expect(res.statusCode).toBe(200);
    expect(answerAskMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: MAP_ID, askId: '#6823' }, { action: 'answered', decision: 'skip' }, 'u1');
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'node:updated', nodeId: 'n1' }));
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'asks:updated', kind: 'answer', askId: '#6823', status: 'answered' }));
    expect(syncMock).toHaveBeenCalledWith(node, ['blockedReason', 'description', 'tags', 'status']);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, node: { id: 'n1', status: 'todo' } });
    await app.close();
  });

  it('turns the service\'s validation and not-found errors into 400 / 404', async () => {
    const { AskValidationError, AskNotFoundError } = await import('../../services/asks.js');
    const app = await buildApp();
    answerAskMock.mockRejectedValueOnce(new AskValidationError('answered needs a decision'));
    let res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/x/answer`, payload: { action: 'answered' } });
    expect(res.statusCode).toBe(400);
    answerAskMock.mockRejectedValueOnce(new AskNotFoundError('x'));
    res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/x/answer`, payload: { action: 'later' } });
    expect(res.statusCode).toBe(404);
    state.perm[MAP_ID] = 'view';
    res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/x/answer`, payload: { action: 'later' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /api/maps/:id/asks/worker-ack', () => {
  it('clears the worker flag for the given ids on this map of the fleet', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/worker-ack`, payload: { askIds: ['#6823', 7] } });
    expect(res.statusCode).toBe(200);
    expect(clearWorkerPendingMock).toHaveBeenCalledWith(FLEET, MAP_ID, ['#6823']);
    expect(JSON.parse(res.body)).toEqual({ cleared: 1 });
    await app.close();
  });
});

describe('fleet routes (#479)', () => {
  const fleetDoc = {
    meta: { tick: 't' },
    items: [
      { id: '#1', question: 'A?', map_id: MAP_ID },
      { id: '#1', question: 'B?', map_id: OTHER },
      { id: 'fleet:budget', question: 'More hosts?' },
    ],
  };

  it('a fleet-wide push stores each item on its own map (none = fleet-level) and broadcasts to every map', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/asks`, payload: fleetDoc });
    expect(res.statusCode).toBe(200);
    const [fleetId, mapId, items] = replaceAsksMock.mock.calls[0] as [string, null, Array<{ ask: { id: string }; mapId: string | null }>];
    expect([fleetId, mapId]).toEqual([FLEET, null]);
    expect(items.map((i) => [i.ask.id, i.mapId])).toEqual([['#1', MAP_ID], ['#1', OTHER], ['fleet:budget', null]]);
    expect(broadcastMock).toHaveBeenCalledWith(OTHER, expect.objectContaining({ type: 'asks:updated', kind: 'push' }));
    await app.close();
  });

  it('a fleet push needs edit on every map, and refuses items for maps outside the fleet', async () => {
    const app = await buildApp();
    const stray = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/asks`, payload: { items: [{ id: 'x', question: 'q', map_id: LONE }] } });
    state.perm[OTHER] = 'view';
    const partial = await app.inject({ method: 'PUT', url: `/api/fleets/${FLEET}/asks`, payload: fleetDoc });
    await app.close();
    expect([stray.statusCode, partial.statusCode]).toEqual([400, 403]);
    expect(replaceAsksMock).not.toHaveBeenCalled();
  });

  it('the fleet read covers the viewable maps; fleet-level asks only for a reader of every map', async () => {
    state.view = partialView;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks` });
    state.view = fullView;
    await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks` });
    state.view = { status: 404, code: 'FLEET_NOT_FOUND', message: 'nope' };
    const hidden = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const scopes = (listAsksMock.mock.calls as unknown as unknown[][]).map((c) => c[0]);
    expect(scopes[0]).toEqual({ fleetId: FLEET, visibleMapIds: [MAP_ID], fleetLevel: false });
    expect(scopes[1]).toEqual({ fleetId: FLEET, visibleMapIds: [MAP_ID, OTHER], fleetLevel: true });
    expect(res.json().maps).toEqual([{ id: MAP_ID, name: 'Alpha' }]);
    expect(hidden.statusCode).toBe(404);
  });

  it('an answer through the fleet resolves one row, asks for mapId when the id is shared, and checks edit on its map', async () => {
    const row = (mapId: string | null) => ({ ask: { id: '#1' }, mapId, status: 'open' });
    answerAskMock.mockResolvedValue({ row: { status: 'answered' }, plan: {}, ok: true, node: null, changedFields: [] });
    const app = await buildApp();
    findAsksMock.mockResolvedValueOnce([row(MAP_ID), row(OTHER)]);
    const ambiguous = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/${encodeURIComponent('#1')}/answer`, payload: { action: 'later' } });
    findAsksMock.mockResolvedValueOnce([row(MAP_ID), row(OTHER)]);
    const picked = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/${encodeURIComponent('#1')}/answer?mapId=${OTHER}`, payload: { action: 'later' } });
    state.perm[OTHER] = 'view';
    findAsksMock.mockResolvedValueOnce([row(OTHER)]);
    const denied = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/${encodeURIComponent('#1')}/answer`, payload: { action: 'later' } });
    await app.close();
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error.code).toBe('ASK_AMBIGUOUS');
    expect(picked.statusCode).toBe(200);
    expect(answerAskMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: OTHER, askId: '#1' }, { action: 'later' }, 'u1');
    expect(broadcastMock).toHaveBeenCalledWith(OTHER, expect.objectContaining({ type: 'asks:updated', kind: 'answer' }));
    expect(denied.statusCode).toBe(403);
  });

  it('adds MindBlown\'s own rows (stalled, steps) to an open read of the viewable maps, through the hint filter', async () => {
    const derived = [
      { ask: { id: 'stalled-stuck-node', question: 'done?', answerer: 'Dan', hint: 'decision', options: ['Done'], unblocks: { node_id: 'stuck-node' } }, mapId: OTHER, status: 'open', pushedAt: 'p', firstSeenAt: 'f' },
      { ask: { id: 'step-phone', question: 'Next step: check on a phone', answerer: 'Dan', hint: 'ops-task', options: ['Done'], unblocks: { node_id: 'phone' } }, mapId: MAP_ID, status: 'open', pushedAt: 'p', firstSeenAt: 'f' },
    ];
    openDerivedAsksMock.mockResolvedValue(derived);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks` });
    const steps = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks?hint=ops-task` });
    const answered = await app.inject({ method: 'GET', url: `/api/fleets/${FLEET}/asks?status=answered` });
    await app.close();
    expect(openDerivedAsksMock).toHaveBeenCalledTimes(2); // not for the answered read
    expect(openDerivedAsksMock.mock.calls[0][1]).toEqual([MAP_ID, OTHER]);
    expect(res.json().items.map((r: { ask: { id: string } }) => r.ask.id).sort()).toEqual(['stalled-stuck-node', 'step-phone']);
    expect(res.json().counts.total).toBe(2);
    expect(steps.json().items.map((r: { ask: { id: string } }) => r.ask.id)).toEqual(['step-phone']);
    expect(answered.json().items).toEqual([]);
    openDerivedAsksMock.mockResolvedValue([]);
  });

  it('an answer to a derived row (not stored while open) resolves to its node\'s map', async () => {
    answerAskMock.mockResolvedValue({ row: { status: 'answered' }, plan: {}, ok: true, node: null, changedFields: [] });
    const app = await buildApp();
    const ok = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/stalled-stuck-node/answer`, payload: { action: 'answered', decision: 'Done' } });
    const step = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/step-stuck-node/answer`, payload: { action: 'answered', decision: 'Fleet can do it' } });
    const gone = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/stalled-elsewhere/answer`, payload: { action: 'answered', decision: 'Done' } });
    await app.close();
    expect(ok.statusCode).toBe(200);
    expect(answerAskMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: OTHER, askId: 'stalled-stuck-node' }, { action: 'answered', decision: 'Done' }, 'u1');
    expect(step.statusCode).toBe(200);
    expect(answerAskMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: OTHER, askId: 'step-stuck-node' }, { action: 'answered', decision: 'Fleet can do it' }, 'u1');
    expect(gone.statusCode).toBe(404);
  });

  it('a fleet-level answer needs edit on every map and tells every map', async () => {
    answerAskMock.mockResolvedValue({ row: { status: 'answered' }, plan: {}, ok: true, node: null, changedFields: [] });
    findAsksMock.mockResolvedValue([{ ask: { id: 'fleet:budget' }, mapId: null, status: 'open' }]);
    const app = await buildApp();
    const ok = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/fleet:budget/answer`, payload: { action: 'answered', decision: 'yes' } });
    state.perm[OTHER] = 'view';
    const denied = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/fleet:budget/answer`, payload: { action: 'answered', decision: 'yes' } });
    await app.close();
    expect([ok.statusCode, denied.statusCode]).toEqual([200, 403]);
    expect(answerAskMock).toHaveBeenCalledWith({ fleetId: FLEET, mapId: null, askId: 'fleet:budget' }, expect.anything(), 'u1');
    for (const m of [MAP_ID, OTHER]) expect(broadcastMock).toHaveBeenCalledWith(m, expect.objectContaining({ type: 'asks:updated' }));
  });

  it('the fleet worker-ack clears the ids across the fleet', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/fleets/${FLEET}/asks/worker-ack`, payload: { askIds: ['#1'] } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(clearWorkerPendingMock).toHaveBeenCalledWith(FLEET, null, ['#1']);
  });
});
