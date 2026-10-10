/**
 * PATCH /api/maps/:id/nodes/bulk (#115): each item runs the single-node
 * update path; items succeed or fail independently and the answer carries
 * one result per item, in order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));

const mocks = vi.hoisted(() => ({
  mapOf: new Map<string, string>(),
  updateNode: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({ db: { insert: () => ({ values: async () => {} }) } }));
vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: async (id: string) => ({ id, mapId: mocks.mapOf.get(id), externalLinks: [], completedAt: null, status: null, blockedReason: null, parentId: 'root' }),
    getNodeMapId: async (id: string) => mocks.mapOf.get(id) ?? null,
    updateNode: (...args: unknown[]) => mocks.updateNode(...args),
  };
});
vi.mock('../../db/events.js', () => ({ recordFieldChanges: async () => {}, recordClaimTransition: async () => {} }));
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../ws.js', () => ({ broadcast: (...a: unknown[]) => mocks.broadcast(...a) }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';
import { RevisionConflictError } from '../../db/nodes.js';

async function patch(payload: unknown) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(nodeRoutes);
  const res = await app.inject({ method: 'PATCH', url: '/api/maps/m1/nodes/bulk', payload: payload as never });
  await app.close();
  return res;
}

beforeEach(() => {
  mocks.mapOf = new Map([['a', 'm1'], ['b', 'm1'], ['x', 'm2']]);
  mocks.updateNode.mockReset();
  mocks.broadcast.mockReset();
});

describe('PATCH /nodes/bulk (#115)', () => {
  it('partial failure: success, revision conflict and a node of another map — one result each, in order', async () => {
    mocks.updateNode.mockImplementation(async (id: string, fields: Record<string, unknown>, rev?: number) => {
      if (id === 'b') throw new RevisionConflictError({ id: 'b', revision: 9 } as never);
      return { id, mapId: 'm1', parentId: 'root', externalLinks: [], completedAt: null, status: null, blockedReason: null, ...fields, revision: (rev ?? 0) + 1 };
    });
    const res = await patch({
      updates: [
        { id: 'a', fields: { priorityRank: 65536 }, expectedRevision: 3 },
        { id: 'b', fields: { priorityRank: 131072 }, expectedRevision: 3 },
        { id: 'x', fields: { priorityRank: 1 } },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ updated: 1, failed: 2 });
    expect(body.results.map((r: { id: string; ok: boolean; status?: number }) => [r.id, r.ok, r.status])).toEqual([
      ['a', true, undefined],
      ['b', false, 409],
      ['x', false, 404],
    ]);
    expect(body.results[1].error).toMatchObject({ code: 'REVISION_CONFLICT', current: { id: 'b', revision: 9 } });
    // the single-node path ran for the success: optimistic lock passed through, broadcast once
    expect(mocks.updateNode).toHaveBeenCalledWith('a', { priorityRank: 65536 }, 3);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    // the other map's node was never written
    expect(mocks.updateNode.mock.calls.map((c) => c[0])).not.toContain('x');
  });

  it('400 for a missing, empty or oversized list; a malformed item fails alone', async () => {
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ updates: [] })).statusCode).toBe(400);
    expect((await patch({ updates: Array.from({ length: 501 }, () => ({ id: 'a', fields: {} })) })).statusCode).toBe(400);
    mocks.updateNode.mockResolvedValue({ id: 'a', mapId: 'm1', parentId: 'root', externalLinks: [], completedAt: null, status: null, blockedReason: null });
    const res = await patch({ updates: [{ id: 'a' }, { id: 'a', fields: [] }, { id: 'a', fields: { text: 'x', expectedRevision: 7 } }] });
    expect(res.json().results.map((r: { ok: boolean }) => r.ok)).toEqual([false, false, true]);
    expect(mocks.updateNode).toHaveBeenLastCalledWith('a', { text: 'x' }, undefined); // lock key stripped from fields
  });

  it('an unexpected error on one item is that item\'s 500 — the rest still answer', async () => {
    mocks.updateNode
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce({ id: 'b', mapId: 'm1', parentId: 'root', externalLinks: [], completedAt: null, status: null, blockedReason: null });
    const res = await patch({ updates: [{ id: 'a', fields: { text: 'x' } }, { id: 'b', fields: { text: 'y' } }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { ok: boolean; status?: number }) => [r.ok, r.status])).toEqual([[false, 500], [true, undefined]]);
  });
});
