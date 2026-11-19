/**
 * Comments on the HTTP surface — the fleet note (claude-fleet#92).
 *
 *   - POST takes `kind` ('comment' default | 'fleet-note'), refuses others.
 *   - GET forwards `?kind&since` to the DB filter; a bad value is a 400.
 *   - PATCH …/comments/:id marks a fleet note delivered (default now, an
 *     explicit time, first time kept), refuses a plain comment and one on
 *     another node, and broadcasts the update.
 *   - Writing needs edit on the map, reading view (the map guard).
 *
 * Mounts the real commentRoutes and mocks db/comments below it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  permission: 'edit' as 'view' | 'edit' | 'admin' | null,
  createComment: vi.fn(),
  listComments: vi.fn(),
  getComment: vi.fn(),
  markCommentDelivered: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../../db/permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/permissions.js')>();
  return { ...actual, getPermission: async () => mocks.permission };
});
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/nodes.js', () => ({ getNodeMapId: async (id: string) => (id === 'n-other' ? 'map-2' : 'map-1') }));
vi.mock('../../db/comments.js', () => ({
  createComment: mocks.createComment,
  listComments: mocks.listComments,
  getComment: mocks.getComment,
  markCommentDelivered: mocks.markCommentDelivered,
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcast }));

import { commentRoutes } from '../comments.js';

const BASE = '/api/maps/map-1/nodes/n-1/comments';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  nodeId: 'n-1',
  userId: 'user-1',
  text: 'Use v2',
  kind: 'fleet-note',
  deliveredAt: null,
  createdAt: new Date('2026-11-19T10:00:00Z'),
  updatedAt: new Date('2026-11-19T10:00:00Z'),
  ...over,
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(commentRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = 'edit';
  mocks.createComment.mockImplementation(async (input: Record<string, unknown>) => row({ ...input, deliveredAt: null }));
  mocks.listComments.mockResolvedValue([]);
});

describe('POST comments — kind', () => {
  it("defaults to 'comment'", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: BASE, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(201);
    expect(mocks.createComment).toHaveBeenCalledWith({ nodeId: 'n-1', userId: 'user-1', text: 'hi', kind: 'comment' });
  });

  it("accepts 'fleet-note' and broadcasts it", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: BASE, payload: { text: 'Use v2', kind: 'fleet-note' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'fleet-note', deliveredAt: null, text: 'Use v2' });
    expect(mocks.createComment).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fleet-note' }));
    expect(mocks.broadcast).toHaveBeenCalledWith('map-1', expect.objectContaining({ type: 'comment:created', nodeId: 'n-1' }));
  });

  it('refuses any other kind', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: BASE, payload: { text: 'x', kind: 'fleet-note-ack' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it('needs edit on the map', async () => {
    mocks.permission = 'view';
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: BASE, payload: { text: 'x', kind: 'fleet-note' } });
    expect(res.statusCode).toBe(403);
    expect(mocks.createComment).not.toHaveBeenCalled();
  });
});

describe('GET comments — ?kind&since', () => {
  it('without a query lists everything', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    expect(mocks.listComments).toHaveBeenCalledWith('n-1', {});
  });

  it('forwards kind and since to the DB filter', async () => {
    mocks.permission = 'view';
    mocks.listComments.mockResolvedValue([row()]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}?kind=fleet-note&since=2026-11-19T09:30:00Z` });
    expect(res.statusCode).toBe(200);
    expect(mocks.listComments).toHaveBeenCalledWith('n-1', { kind: 'fleet-note', since: new Date('2026-11-19T09:30:00Z') });
    expect(res.json()).toEqual([expect.objectContaining({ id: 'c-1', kind: 'fleet-note', createdAt: '2026-11-19T10:00:00.000Z' })]);
  });

  it.each([['kind=bogus'], ['since=yesterday']])('refuses %s', async (q) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${BASE}?${q}` });
    expect(res.statusCode).toBe(400);
    expect(mocks.listComments).not.toHaveBeenCalled();
  });

  it('404s for a node on another map', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/maps/map-1/nodes/n-other/comments' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH comments/:id — the worker picked the note up', () => {
  it('marks it delivered now by default and broadcasts the update', async () => {
    mocks.getComment.mockResolvedValue(row());
    mocks.markCommentDelivered.mockImplementation(async (_id: string, at: Date) => row({ deliveredAt: at }));
    const app = await buildApp();
    const before = Date.now();
    const res = await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: {} });
    expect(res.statusCode).toBe(200);
    const at = mocks.markCommentDelivered.mock.calls[0][1] as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(res.json().deliveredAt).toBe(at.toISOString());
    expect(mocks.broadcast).toHaveBeenCalledWith('map-1', expect.objectContaining({ type: 'comment:updated', nodeId: 'n-1' }));
  });

  it('takes an explicit deliveredAt', async () => {
    mocks.getComment.mockResolvedValue(row());
    mocks.markCommentDelivered.mockImplementation(async (_id: string, at: Date) => row({ deliveredAt: at }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: { deliveredAt: '2026-11-19T10:03:00Z' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.markCommentDelivered).toHaveBeenCalledWith('c-1', new Date('2026-11-19T10:03:00Z'));
  });

  it('keeps the first time on a second mark', async () => {
    mocks.getComment.mockResolvedValue(row({ deliveredAt: new Date('2026-11-19T10:01:00Z') }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: { deliveredAt: '2026-11-19T11:00:00Z' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveredAt).toBe('2026-11-19T10:01:00.000Z');
    expect(mocks.markCommentDelivered).not.toHaveBeenCalled();
  });

  it('refuses a plain comment (409), one on another node (404), a bad time (400)', async () => {
    const app = await buildApp();
    mocks.getComment.mockResolvedValue(row({ kind: 'comment' }));
    expect((await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: {} })).statusCode).toBe(409);
    mocks.getComment.mockResolvedValue(row({ nodeId: 'n-2' }));
    expect((await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: {} })).statusCode).toBe(404);
    mocks.getComment.mockResolvedValue(row());
    expect((await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: { deliveredAt: 'soon' } })).statusCode).toBe(400);
    expect(mocks.markCommentDelivered).not.toHaveBeenCalled();
  });

  it('needs edit on the map', async () => {
    mocks.permission = 'view';
    mocks.getComment.mockResolvedValue(row());
    const app = await buildApp();
    expect((await app.inject({ method: 'PATCH', url: `${BASE}/c-1`, payload: {} })).statusCode).toBe(403);
  });
});
