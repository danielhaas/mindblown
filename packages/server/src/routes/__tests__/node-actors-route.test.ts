/**
 * Route test for GET /api/maps/:id/nodes/actors — the Workload view's
 * attribution fallback.
 *
 * The one thing worth locking down here is routing, not SQL: the path
 * sits under the same prefix as GET /api/maps/:id/nodes/:nodeId, so a
 * regression in registration order (or a rename to a param-shaped path)
 * would silently route "actors" into the single-node handler and return
 * a 404 NODE_NOT_FOUND instead of the actor map. That failure looks like
 * "Workload is empty again", which is exactly the bug this whole change
 * set exists to fix.
 *
 * Mock pattern mirrors phase-node-routes.test.ts — stub the DB layer,
 * exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const getLastActorByNodeMock = vi.fn();
const getNodeMock = vi.fn(async () => null);

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return { ...actual, getNode: () => getNodeMock() };
});

vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
  listEvents: vi.fn(async () => []),
  getLastActorByNode: (...args: unknown[]) => getLastActorByNodeMock(...args),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({
  updateGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
}));
vi.mock('../integrations.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));

import { nodeRoutes } from '../nodes.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu-uuuu-uuuu-uuuu';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  getLastActorByNodeMock.mockReset();
  getNodeMock.mockReset();
  getNodeMock.mockResolvedValue(null as never);
});

describe('GET /api/maps/:id/nodes/actors', () => {
  it('returns the actor map for the requested map', async () => {
    getLastActorByNodeMock.mockResolvedValueOnce([
      { nodeId: 'n1', userId: 'u-dan', userName: 'Daniel Haas' },
      { nodeId: 'n2', userId: 'u-mike', userName: 'Mike' },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/actors` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(getLastActorByNodeMock).toHaveBeenCalledWith(MAP_ID);
    expect(res.json().actors).toEqual([
      { nodeId: 'n1', userId: 'u-dan', userName: 'Daniel Haas' },
      { nodeId: 'n2', userId: 'u-mike', userName: 'Mike' },
    ]);
  });

  it('is not shadowed by the /nodes/:nodeId handler', async () => {
    getLastActorByNodeMock.mockResolvedValueOnce([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/actors` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actors: [] });
    expect(getNodeMock).not.toHaveBeenCalled(); // would mean "actors" was read as a node id
  });

  it('still resolves a real node id on the sibling route', async () => {
    getNodeMock.mockResolvedValueOnce({ id: 'n1', mapId: MAP_ID } as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/nodes/n1` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('n1');
    expect(getLastActorByNodeMock).not.toHaveBeenCalled();
  });
});
