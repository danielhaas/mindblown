/**
 * Route tests for GET /api/maps/:id/board-summary (#589). The summary rules
 * are core's (core/__tests__/boardSummary.test.ts); here: access, the limit
 * param, the 404, and that the map's nodes reach summarizeBoard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

let permissionLevel: 'view' | 'edit' | 'admin' | null = 'view';

vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => permissionLevel),
  hasPermission: (perm: string | null, level: 'view' | 'edit' | 'admin') => {
    if (!perm) return false;
    const order = { view: 0, edit: 1, admin: 2 } as const;
    return order[perm as keyof typeof order] >= order[level];
  },
}));

const leaf = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentId: 'root',
  childrenIds: [],
  text: `Task ${id}`,
  status,
  percentComplete: 0,
  blockedReason: null,
  dependencies: [],
  startedAt: null,
  ...extra,
});

const mapData = {
  map: {
    id: 'map-1',
    name: 'Launch',
    rootNodeId: 'root',
    wipLimit: 2,
    statusWorkflow: [
      { id: 'todo', name: 'Todo', category: 'todo', color: '#ccc', position: 0 },
      { id: 'doing', name: 'Doing', category: 'in_progress', color: '#00f', position: 1 },
    ],
  },
  nodes: [
    { id: 'root', parentId: null, childrenIds: ['a', 'b', 'c'], text: 'Launch', status: null, dependencies: [] },
    leaf('a', 'doing'),
    leaf('b', 'doing'),
    leaf('c', 'todo', { blockedReason: 'Needs Dan' }),
  ],
};

vi.mock('../../db/maps.js', () => ({
  getMap: vi.fn(async (id: string) => (id === 'map-1' ? mapData : null)),
}));

const { boardRoutes } = await import('../board.js');

async function buildApp(userId: string | null = 'user-1'): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as unknown as { userId: string | null }).userId = userId;
  });
  await app.register(boardRoutes);
  return app;
}

const get = async (url: string, userId: string | null = 'user-1') => (await buildApp(userId)).inject({ method: 'GET', url });

beforeEach(() => {
  permissionLevel = 'view';
});

describe('GET /api/maps/:id/board-summary', () => {
  it('returns the summary to a viewer', async () => {
    const res = await get('/api/maps/map-1/board-summary');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mapId: 'map-1',
      mapName: 'Launch',
      inProgress: { count: 2 },
      blocked: { count: 1, items: [{ id: 'c', reason: 'Needs Dan' }] },
      wip: { count: 2, limit: 2 },
    });
  });

  it('caps the lists at ?limit, keeping the count', async () => {
    const res = await get('/api/maps/map-1/board-summary?limit=1');
    expect(res.json().inProgress.count).toBe(2);
    expect(res.json().inProgress.items).toHaveLength(1);
  });

  it.each(['0', '21', 'abc', '1.5'])('400 on limit=%s', async (limit) => {
    expect((await get(`/api/maps/map-1/board-summary?limit=${limit}`)).statusCode).toBe(400);
  });

  it('401 without a user, 403 without view', async () => {
    expect((await get('/api/maps/map-1/board-summary', null)).statusCode).toBe(401);
    permissionLevel = null;
    expect((await get('/api/maps/map-1/board-summary')).statusCode).toBe(403);
  });

  it('404 for an unknown map', async () => {
    expect((await get('/api/maps/nope/board-summary')).statusCode).toBe(404);
  });
});
