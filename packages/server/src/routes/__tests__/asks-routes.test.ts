/**
 * Asks inbox routes — the contract the orchestrator pushes against and the
 * Fragen tab / MCP tools read and answer through. DB + service stubbed;
 * what matters here: auth (edit for push/answer, view for read), the
 * document shape check, the map_id mismatch refusal, the asks:updated
 * broadcast, and the answer fan-out (node:updated + GitHub sync).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const replaceAsksMock = vi.fn();
const listAsksMock = vi.fn(async () => []);
const getPushMetaMock = vi.fn(async () => null);
const clearWorkerPendingMock = vi.fn(async () => 1);
const answerAskMock = vi.fn();
const syncMock = vi.fn(async () => {});
const broadcastMock = vi.fn();
let permission: string | null = 'edit';

vi.mock('../../db/asks.js', () => ({
  replaceAsks: (...a: unknown[]) => replaceAsksMock(...a),
  listAsks: (...a: unknown[]) => listAsksMock(...(a as [])),
  getPushMeta: (...a: unknown[]) => getPushMetaMock(...(a as [])),
  clearWorkerPending: (...a: unknown[]) => clearWorkerPendingMock(...(a as [])),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => permission,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));
vi.mock('../../services/asks.js', async () => {
  const real = await vi.importActual<typeof import('../../services/asks.js')>('../../services/asks.js');
  return { ...real, answerAsk: (...a: unknown[]) => answerAskMock(...a) };
});
vi.mock('../nodes.js', () => ({ syncNodeToGitHub: (...a: unknown[]) => syncMock(...(a as [])) }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }));

import { asksRoutes } from '../asks.js';

const MAP_ID = 'mmmm-mmmm';
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

beforeEach(() => {
  vi.clearAllMocks();
  permission = 'edit';
  userId = 'u1';
  replaceAsksMock.mockResolvedValue({ pushedAt: '2026-09-03T08:01:00.000Z', received: 1, removed: 0, kept: 0 });
});

describe('PUT /api/maps/:id/asks', () => {
  it('stores the collector document and broadcasts', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ pushedAt: '2026-09-03T08:01:00.000Z', received: 1, removed: 0, kept: 0 });
    expect(replaceAsksMock).toHaveBeenCalledWith(MAP_ID, [expect.objectContaining({ id: '#6823', ticket: 6823, unblocks: expect.objectContaining({ node_id: 'n1' }) })], doc.meta);
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'asks:updated', kind: 'push' }));
    await app.close();
  });

  it('refuses a document for another map, a malformed body, and a viewer', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: { ...doc, meta: { map_id: 'other' } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: { meta: {} } });
    expect(res.statusCode).toBe(400);
    permission = 'view';
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(403);
    userId = undefined;
    res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(401);
    expect(replaceAsksMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps an unknown map (FK violation) to 404', async () => {
    replaceAsksMock.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/asks`, payload: doc });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/maps/:id/asks', () => {
  it('defaults to open, forwards filters, returns counts + push meta', async () => {
    permission = 'view';
    getPushMetaMock.mockResolvedValueOnce({ pushedAt: '2026-09-03T08:01:00.000Z', meta: { tick: 't' } } as never);
    listAsksMock.mockResolvedValueOnce([
      { ask: { ...doc.items[0], answerer: 'Rita', hint: 'decision', priority: null, idle_hours: 1, sources: [], options: [], unblocks: {} }, status: 'open' },
    ] as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/asks?answerer=Rita&limit=5` });
    expect(res.statusCode).toBe(200);
    expect(listAsksMock).toHaveBeenCalledWith(MAP_ID, { status: 'open', hint: undefined, answerer: 'Rita', since: undefined, limit: 5 });
    const body = JSON.parse(res.body);
    expect(body.counts).toEqual({ total: 1, byAnswerer: { Rita: 1 }, byHint: { decision: 1 }, byStatus: { open: 1 } });
    expect(body.pushedAt).toBe('2026-09-03T08:01:00.000Z');
    expect(body.meta).toEqual({ tick: 't' });
    await app.close();
  });

  it('rejects an unknown status', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/asks?status=bogus` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/maps/:id/asks/:askId/answer', () => {
  it('runs the service and fans out node:updated + GitHub sync + asks:updated', async () => {
    const node = { id: 'n1', status: 'todo' };
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
    expect(answerAskMock).toHaveBeenCalledWith(MAP_ID, '#6823', { action: 'answered', decision: 'skip' }, 'u1');
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
    permission = 'view';
    res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/x/answer`, payload: { action: 'later' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /api/maps/:id/asks/worker-ack', () => {
  it('clears the worker flag for the given ids', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/asks/worker-ack`, payload: { askIds: ['#6823', 7] } });
    expect(res.statusCode).toBe(200);
    expect(clearWorkerPendingMock).toHaveBeenCalledWith(MAP_ID, ['#6823']);
    expect(JSON.parse(res.body)).toEqual({ cleared: 1 });
    await app.close();
  });
});
