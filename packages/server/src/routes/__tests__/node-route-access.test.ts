/**
 * Node routes behind the map guard (#403) — on the real `nodeRoutes`
 * plugin, so the guard's placement is what is tested, not a copy of it.
 *
 * Same stubbed-DB shape as the other node route tests. Two routes stand
 * in for the group: the node GET (a read) and the attachment POST (a
 * write), which have the least wiring of their kind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP_ID = 'mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn';
/** Exists, but hangs on another map. */
const FOREIGN_NODE_ID = 'ffff-ffff';

vi.mock('../../db/permissions.js', () => {
  const levels: Record<string, number> = { view: 1, edit: 2, admin: 3 };
  return {
    getPermission: async (mapId: string, userId: string) =>
      mapId === MAP_ID ? ({ viewer: 'view', editor: 'edit' }[userId] ?? null) : null,
    hasPermission: (actual: string | null, required: string) =>
      !!actual && levels[actual] >= levels[required],
  };
});

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: async (nodeId: string) => {
      if (nodeId === NODE_ID) return { id: NODE_ID, mapId: MAP_ID, text: 'here', attachments: [] };
      if (nodeId === FOREIGN_NODE_ID) return { id: FOREIGN_NODE_ID, mapId: 'other-map', text: 'there', attachments: [] };
      return null;
    },
    getNodeMapId: async (nodeId: string) =>
      nodeId === NODE_ID ? MAP_ID : nodeId === FOREIGN_NODE_ID ? 'other-map' : null,
    addAttachment: async (nodeId: string, input: Record<string, unknown>) => ({
      id: nodeId,
      mapId: MAP_ID,
      attachments: [{ id: 'att-1', ...input, addedAt: '2026-09-27T00:00:00Z' }],
    }),
    removeAttachment: vi.fn(),
    updateNode: vi.fn(),
    createNode: vi.fn(),
  };
});
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  app.addHook('preHandler', async (req) => {
    const u = req.headers['x-user'];
    if (typeof u === 'string' && u) req.userId = u;
  });
  await app.register(nodeRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const getNode = (nodeId: string, user?: string) =>
  app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/${nodeId}`, headers: user ? { 'x-user': user } : {} });
const attach = (nodeId: string, user?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/maps/${MAP_ID}/nodes/${nodeId}/attachments`,
    headers: user ? { 'x-user': user } : {},
    payload: { kind: 'link', url: 'https://example.com/spec' },
  });

describe('node routes — map guard', () => {
  it('a read needs a user with view', async () => {
    expect((await getNode(NODE_ID)).statusCode).toBe(401);
    expect((await getNode(NODE_ID, 'stranger')).statusCode).toBe(403);
    const ok = await getNode(NODE_ID, 'viewer');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: NODE_ID, text: 'here' });
  });

  it('a write needs edit — a viewer is refused, an editor gets through', async () => {
    expect((await attach(NODE_ID)).statusCode).toBe(401);
    expect((await attach(NODE_ID, 'viewer')).statusCode).toBe(403);
    expect((await attach(NODE_ID, 'editor')).statusCode).toBe(201);
  });

  it("a node from another map is 404 under this map's URL, read or write", async () => {
    expect((await getNode(FOREIGN_NODE_ID, 'viewer')).statusCode).toBe(404);
    expect((await attach(FOREIGN_NODE_ID, 'editor')).statusCode).toBe(404);
  });

  it('the 401/403 bodies carry the usual error shape', async () => {
    expect((await getNode(NODE_ID)).json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    expect((await attach(NODE_ID, 'viewer')).json().error.code).toBe('FORBIDDEN');
  });
});
