/**
 * Route tests for reportedBy (#490) on the node write surface.
 *
 * The reporter is whoever is authenticated on the create — the UI user,
 * or the API-key owner behind an MCP call (the MCP server reaches this
 * route with a loopback token carrying the key owner's userId). A
 * reportedBy in the create body is never trusted; that updates never
 * write it is pinned on updateNode itself (db/__tests__/reportedBy.test.ts).
 *
 * Mock pattern mirrors node-assignees-route.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'admin', hasPermission: () => true }));

const createNodeMock = vi.fn();
const updateNodeMock = vi.fn();

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    createNode: (...args: unknown[]) => createNodeMock(...args),
    updateNode: (...args: unknown[]) => updateNodeMock(...args),
    getNode: async () => null,
    getNodeMapId: async () => null,
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

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';
const KEY_OWNER = 'uuuu-key-owner';

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
    reportedBy: null,
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = KEY_OWNER;
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  createNodeMock.mockReset();
  updateNodeMock.mockReset();
});

describe('POST /api/maps/:id/nodes — reportedBy (#490)', () => {
  it('records the authenticated user as reporter and returns it', async () => {
    const reporter = { kind: 'user', userId: KEY_OWNER };
    createNodeMock.mockResolvedValueOnce(stubNode({ reportedBy: reporter }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'task' },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(createNodeMock.mock.calls[0][0].reportedBy).toEqual(reporter);
    expect(res.json().reportedBy).toEqual(reporter);
  });

  it('ignores a reportedBy passed in the body', async () => {
    createNodeMock.mockResolvedValueOnce(stubNode());
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: {
        parentId: 'pppp-pppp',
        text: 'spoofed',
        reportedBy: { kind: 'forge', provider: 'github', login: 'someone-else' },
      },
    });
    await app.close();

    expect(createNodeMock.mock.calls[0][0].reportedBy).toEqual({ kind: 'user', userId: KEY_OWNER });
  });
});
