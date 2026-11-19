/**
 * Route tests for the lead-time fields (#654) on the node write surface:
 * leadTime (non-negative number), requestedAt (YYYY-MM-DD) and waitingOn
 * (text), each nullable, reach the DB layer on create and update; anything
 * else is a 400 before the write.
 *
 * Mock pattern mirrors node-expected-done-at-route.test.ts.
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

describe('lead-time fields on the node routes', () => {
  const fields = { leadTime: 5, requestedAt: '2026-11-12', waitingOn: 'LOKE engineering' };

  it('update forwards them, and null clears them', async () => {
    const app = await buildApp();
    let res = await put(app, fields);
    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls.at(-1)?.[1]).toMatchObject(fields);
    res = await put(app, { leadTime: null, requestedAt: null, waitingOn: null });
    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls.at(-1)?.[1]).toMatchObject({ leadTime: null, requestedAt: null, waitingOn: null });
  });

  it('create forwards them to the DB layer', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: '[External] VM', ...fields },
    });
    expect(res.statusCode).toBe(201);
    expect(createNodeMock.mock.calls.at(-1)?.[0]).toMatchObject(fields);
  });

  it('rejects a negative or non-numeric lead time, a non-date requestedAt, non-text waitingOn', async () => {
    const app = await buildApp();
    for (const body of [
      { leadTime: -1 },
      { leadTime: '5' },
      { requestedAt: '2026-11-12T10:00:00Z' },
      { requestedAt: '2026-02-30' },
      { requestedAt: 'last week' },
      { waitingOn: 42 },
    ]) {
      const res = await put(app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(updateNodeMock).not.toHaveBeenCalled();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 't', leadTime: -2 },
    });
    expect(res.statusCode).toBe(400);
    expect(createNodeMock).not.toHaveBeenCalled();
  });
});
