/**
 * Route tests for assigneeIds on the node write surface.
 *
 * The field existed on the type, the column, and update_node, but had no
 * write surface a person could reach — no editor in the UI — and the DB
 * create path hardcoded an empty array, so even an API caller passing it
 * on create got it silently dropped. These tests lock down the REST half:
 * both create and update must forward the field verbatim to the DB layer.
 *
 * Mock pattern mirrors phase-node-routes.test.ts — stub the DB layer +
 * side-effect modules, exercise route wiring without Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────

const createNodeMock = vi.fn();
const updateNodeMock = vi.fn();
const getNodeMock = vi.fn(async () => null);

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    createNode: (...args: unknown[]) => createNodeMock(...args),
    updateNode: (...args: unknown[]) => updateNodeMock(...args),
    getNode: (...args: unknown[]) => getNodeMock(),
  };
});

vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: vi.fn(async () => {}),
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

// ── Test harness ──────────────────────────────────────────────────

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';

/** Minimal CoreNode-shaped stub the routes can broadcast/sync safely. */
function stubNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NODE_ID,
    mapId: MAP_ID,
    parentId: 'pppp-pppp',
    childrenIds: [],
    text: 'stub node',
    externalLinks: [],
    attachments: [],
    assigneeIds: [],
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu-uuuu-uuuu-uuuu';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  createNodeMock.mockReset();
  updateNodeMock.mockReset();
  getNodeMock.mockReset();
  getNodeMock.mockResolvedValue(null as never);
});

// ── Cases ─────────────────────────────────────────────────────────

describe('POST /api/maps/:id/nodes — assigneeIds', () => {
  it('forwards assigneeIds to createNode', async () => {
    createNodeMock.mockResolvedValueOnce(stubNode({ assigneeIds: ['u-dan'] }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'assigned task', assigneeIds: ['u-dan'] },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(createNodeMock.mock.calls[0][0]).toMatchObject({ assigneeIds: ['u-dan'] });
    expect(res.json().assigneeIds).toEqual(['u-dan']);
  });

  it('omits assigneeIds entirely when the caller does not send it', async () => {
    createNodeMock.mockResolvedValueOnce(stubNode());
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'plain task' },
    });
    await app.close();

    expect(createNodeMock.mock.calls[0][0].assigneeIds).toBeUndefined();
  });
});

describe('PUT /api/maps/:id/nodes/:nodeId — assigneeIds', () => {
  it('forwards an assignee set', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ assigneeIds: ['u-dan', 'u-tom'] }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { assigneeIds: ['u-dan', 'u-tom'] },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ assigneeIds: ['u-dan', 'u-tom'] });
  });

  it('forwards an empty array as a clear — unassigning must not read as "no change"', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ assigneeIds: [] }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { assigneeIds: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ assigneeIds: [] });
  });
});
