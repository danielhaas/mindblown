/**
 * Route test: descriptionSource ('ai' = a brief the brief-draft job wrote)
 * on the node write surface — "Accept" (null) and an explicit 'ai' reach
 * the DB layer through PUT, and POST forwards it with a description.
 * Harness as verification-fields-route.test.ts: the real routes, the DB stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// The map guard (#403) asks permissions first; this user may do anything.
vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));

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
    getNodeMapId: async () => null, // the map guard (#403) passes an unknown node to the handler
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

function stubNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: NODE_ID, mapId: MAP_ID, parentId: 'pppp-pppp', childrenIds: [], text: 'stub node', externalLinks: [], attachments: [], ...overrides };
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

describe('descriptionSource on the node routes', () => {
  it('PUT forwards "Accept" (null) and returns the node', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ description: 'Brief.', descriptionSource: null }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`, payload: { descriptionSource: null } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ descriptionSource: null });
    expect(res.json().descriptionSource).toBeNull();
  });

  it('PUT forwards an AI brief with its marker', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ description: 'Brief.', descriptionSource: 'ai' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`, payload: { description: 'Brief.', descriptionSource: 'ai' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ description: 'Brief.', descriptionSource: 'ai' });
    expect(res.json().descriptionSource).toBe('ai');
  });

  it('POST forwards it with the description', async () => {
    createNodeMock.mockResolvedValueOnce(stubNode({ description: 'Brief.', descriptionSource: 'ai' }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'stub node', description: 'Brief.', descriptionSource: 'ai' },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(createNodeMock.mock.calls[0][0]).toMatchObject({ description: 'Brief.', descriptionSource: 'ai' });
  });
});
