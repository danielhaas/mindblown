/**
 * DELETE /api/maps/:id/nodes/:nodeId — the change-log snapshot carries the
 * node's inherited release (#333).
 *
 * The Overview attributes scope change per release. For a live node the
 * client walks the parent chain itself; for a deleted node that chain is
 * gone, so the server has to resolve the version while it still can and
 * stamp it into the `node.deleted` snapshot next to effortEstimate/isLeaf.
 *
 * Mock pattern mirrors node-assignees-route.test.ts — stub the DB layer +
 * side-effect modules, exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const getNodeMock = vi.fn(async (_id: string): Promise<unknown> => null);
const deleteNodeMock = vi.fn();
const resolveInheritedVersionIdMock = vi.fn(async (_id: string): Promise<string | null> => null);
const recordEventMock = vi.fn(async (_evt: unknown) => {});

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: (id: string) => getNodeMock(id),
    deleteNode: (...args: unknown[]) => deleteNodeMock(...args),
    resolveInheritedVersionId: (id: string) => resolveInheritedVersionIdMock(id),
  };
});
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: (evt: unknown) => recordEventMock(evt),
  recordFieldChanges: vi.fn(async () => {}),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu-uuuu-uuuu-uuuu';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  getNodeMock.mockReset();
  deleteNodeMock.mockReset();
  resolveInheritedVersionIdMock.mockReset();
  recordEventMock.mockReset();
});

describe('DELETE /api/maps/:id/nodes/:nodeId — change-log snapshot', () => {
  it('stamps the inherited versionId into the primary delete snapshot', async () => {
    getNodeMock.mockResolvedValueOnce({
      id: NODE_ID,
      mapId: MAP_ID,
      parentId: 'pppp-pppp',
      childrenIds: [],
      text: 'leaf under a V1 branch',
      effortEstimate: 3,
      percentComplete: 0,
      versionId: null, // inherits from the branch
    });
    resolveInheritedVersionIdMock.mockResolvedValueOnce('vvvv-v1');
    deleteNodeMock.mockResolvedValueOnce({ deletedIds: [NODE_ID], parentChildIndex: 2 });

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}` });
    expect(res.statusCode).toBe(204);

    expect(resolveInheritedVersionIdMock).toHaveBeenCalledWith(NODE_ID);
    expect(recordEventMock).toHaveBeenCalledTimes(1);
    const evt = recordEventMock.mock.calls[0][0] as { eventType: string; nodeId: string; oldValue: Record<string, unknown> };
    expect(evt.eventType).toBe('node.deleted');
    expect(evt.nodeId).toBe(NODE_ID);
    expect(evt.oldValue).toEqual({
      text: 'leaf under a V1 branch',
      parentId: 'pppp-pppp',
      effortEstimate: 3,
      percentComplete: 0,
      isLeaf: true,
      parentChildIndex: 2,
      versionId: 'vvvv-v1',
    });
  });

  it('records versionId: null when nothing in the chain is tagged, and no snapshot for secondary ids', async () => {
    getNodeMock.mockResolvedValueOnce({ id: NODE_ID, mapId: MAP_ID, parentId: 'pppp', childrenIds: ['kid'], text: 'branch' });
    resolveInheritedVersionIdMock.mockResolvedValueOnce(null);
    deleteNodeMock.mockResolvedValueOnce({ deletedIds: [NODE_ID, 'kid'], parentChildIndex: 0 });

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}` });
    expect(res.statusCode).toBe(204);

    const byNode = Object.fromEntries(
      recordEventMock.mock.calls.map((c) => {
        const e = c[0] as { nodeId: string; oldValue: unknown };
        return [e.nodeId, e.oldValue];
      }),
    );
    expect((byNode[NODE_ID] as { versionId: unknown; isLeaf: boolean })).toMatchObject({ versionId: null, isLeaf: false });
    expect(byNode['kid']).toBeNull();
  });
});
