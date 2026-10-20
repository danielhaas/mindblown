/**
 * Route tests for expectedDoneAt (the worker's ETA) on the node write
 * surface: an ISO 8601 date-time with Z or an offset, or null, reaches the
 * DB layer; anything else is a 400 before the write. The DB-side set/clear
 * rules are pinned on updateNode (db/__tests__/startedAt.test.ts).
 *
 * Mock pattern mirrors node-reported-by-route.test.ts.
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
    req.userId = 'uuuu-user';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  createNodeMock.mockReset();
  updateNodeMock.mockReset();
  createNodeMock.mockImplementation(async (input: Record<string, unknown>) => stubNode(input));
  updateNodeMock.mockImplementation(async () => stubNode());
});

const put = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`, payload: body as object });

describe('expectedDoneAt on the node routes', () => {
  it('forwards an ISO timestamp with Z or an offset, and null', async () => {
    const app = await buildApp();
    for (const v of ['2026-10-20T15:40:00Z', '2026-10-20T15:40:00.123+02:00', '2026-10-20T15:40-05:00', null]) {
      const res = await put(app, { expectedDoneAt: v });
      expect(res.statusCode, String(v)).toBe(200);
      expect(updateNodeMock.mock.calls.at(-1)?.[1]).toMatchObject({ expectedDoneAt: v });
    }
  });

  it('rejects what Date.parse would let through: no offset, no time, numbers, rollovers', async () => {
    const app = await buildApp();
    for (const v of ['1', 'tomorrow', '2026-10-20', '2026-10-20T15:40:00', '2026-02-30T00:00:00Z', 1792513720829]) {
      const res = await put(app, { expectedDoneAt: v });
      expect(res.statusCode, String(v)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(updateNodeMock).not.toHaveBeenCalled();
  });

  it('checks the create route too', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 't', expectedDoneAt: 'soon' },
    });
    expect(res.statusCode).toBe(400);
    expect(createNodeMock).not.toHaveBeenCalled();
  });
});
