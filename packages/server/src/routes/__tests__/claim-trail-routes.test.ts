/**
 * Claim trail on the HTTP surface.
 *
 *   - POST …/release forwards the optional free-text `reason` to the service.
 *   - PUT …/nodes/:id that moves a claimed node to done leaves a
 *     `node.released(done)` row with the held time — the DB layer clears
 *     the claim as a side effect, so the route is the only place that
 *     transition can be observed. Runs the REAL events module over a
 *     captured insert (recordClaimTransition reaches recordEvent through a
 *     module-internal reference, so stubbing the export would test nothing).
 *   - GET …/changes accepts a comma-separated `eventType` list and maps it
 *     to the IN-filter; a single value keeps its old path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  getNodeMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  updateNodeMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  listEventsMock: vi.fn(async () => []),
  releaseNodeMock: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        mocks.inserted.push(row);
      },
    }),
  },
}));
vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: () => mocks.getNodeMock(),
    updateNode: (...args: unknown[]) => mocks.updateNodeMock(...(args as [])),
  };
});
vi.mock('../../db/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/events.js')>();
  return { ...actual, listEvents: mocks.listEventsMock };
});
vi.mock('../../db/maps.js', () => ({ updateMap: vi.fn() }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({
  updateGitHubIssue: vi.fn(),
  getGitHubIssue: vi.fn(),
}));
vi.mock('../integrations.js', () => ({
  getGitHubContextForMap: vi.fn(async () => null),
}));
vi.mock('../../services/orchestration.js', () => {
  class OrchestrationNotFoundError extends Error {}
  class ClaimOwnershipError extends Error {}
  return {
    readyNodes: vi.fn(),
    claimNode: vi.fn(),
    releaseNode: mocks.releaseNodeMock,
    conflictScan: vi.fn(),
    getNextTicket: vi.fn(),
    OrchestrationNotFoundError,
    ClaimOwnershipError,
  };
});

import { nodeRoutes } from '../nodes.js';
import { orchestrationRoutes } from '../orchestration.js';

const MAP_ID = 'map-1';
const NODE_ID = 'n-1';
const WORKER = 'njoerd:worker-3:default';

function stubNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NODE_ID,
    mapId: MAP_ID,
    parentId: 'root',
    childrenIds: [],
    text: 'stub node',
    status: 'in_progress',
    percentComplete: 50,
    blockedReason: null,
    completedAt: null,
    claimedBySession: null,
    claimedAt: null,
    externalLinks: [],
    attachments: [],
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(nodeRoutes);
  await app.register(orchestrationRoutes);
  return app;
}

beforeEach(() => {
  mocks.inserted.length = 0;
  mocks.getNodeMock.mockReset();
  mocks.getNodeMock.mockResolvedValue(null);
  mocks.updateNodeMock.mockReset();
  mocks.updateNodeMock.mockResolvedValue(null);
  mocks.listEventsMock.mockReset();
  mocks.listEventsMock.mockResolvedValue([]);
  mocks.releaseNodeMock.mockReset();
});

describe('POST /api/maps/:id/nodes/:nodeId/release — reason pass-through', () => {
  it('forwards a free-text reason to the service', async () => {
    mocks.releaseNodeMock.mockResolvedValue({ node: { id: NODE_ID, text: 'x' }, released: true });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/release`,
      payload: { sessionId: WORKER, reason: 'dead worker' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.releaseNodeMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, WORKER, { reason: 'dead worker' });
  });

  it('passes reason: null when the body has none (old clients keep working)', async () => {
    mocks.releaseNodeMock.mockResolvedValue({ node: { id: NODE_ID, text: 'x' }, released: true });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/release`,
      payload: { sessionId: WORKER },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.releaseNodeMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, WORKER, { reason: null });
  });
});

describe('PUT /api/maps/:id/nodes/:nodeId — claim transition rows', () => {
  it('status → done on a claimed node records node.released(done) with the held time', async () => {
    const claimedAt = new Date(Date.now() - 42 * 60_000).toISOString();
    mocks.getNodeMock.mockResolvedValue(stubNode({ claimedBySession: WORKER, claimedAt }));
    mocks.updateNodeMock.mockResolvedValue(
      stubNode({
        status: 'done',
        percentComplete: 100,
        claimedBySession: null,
        claimedAt: null,
        completedAt: new Date().toISOString(),
      }),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { status: 'done' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);

    // The history writes are fire-and-forget behind the response.
    await vi.waitFor(() => {
      expect(mocks.inserted.some((r) => r.eventType === 'node.released')).toBe(true);
    });
    const released = mocks.inserted.find((r) => r.eventType === 'node.released')!;
    expect(released).toMatchObject({
      mapId: MAP_ID,
      nodeId: NODE_ID,
      userId: 'user-1',
      fieldName: 'claimedBySession',
      oldValue: WORKER,
    });
    expect(released.newValue).toMatchObject({
      session: WORKER,
      host: 'njoerd',
      worker: 'worker-3',
      profile: 'default',
      reason: 'done',
      note: null,
      claimedAt,
    });
    expect((released.newValue as { heldMinutes: number }).heldMinutes).toBeGreaterThanOrEqual(41);
    expect((released.newValue as { heldMinutes: number }).heldMinutes).toBeLessThanOrEqual(43);
    // The ordinary field changes still land next to it.
    expect(mocks.inserted.filter((r) => r.eventType === 'node.field_changed').map((r) => r.fieldName)).toEqual(
      expect.arrayContaining(['status', 'percentComplete']),
    );
  });

  it('status → blocked with the claim dropped records node.released(blocked) carrying the blockedReason', async () => {
    mocks.getNodeMock.mockResolvedValue(stubNode({ claimedBySession: WORKER, claimedAt: new Date().toISOString() }));
    mocks.updateNodeMock.mockResolvedValue(
      stubNode({ status: 'blocked', blockedReason: 'waiting on PR #8770', claimedBySession: null, claimedAt: null }),
    );

    const app = await buildApp();
    await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { status: 'blocked', blockedReason: 'waiting on PR #8770', claimedBySession: null },
    });
    await app.close();

    await vi.waitFor(() => {
      expect(mocks.inserted.some((r) => r.eventType === 'node.released')).toBe(true);
    });
    const released = mocks.inserted.find((r) => r.eventType === 'node.released')!;
    expect(released.newValue).toMatchObject({ reason: 'blocked', note: 'waiting on PR #8770' });
  });

  it('a write that leaves the claim untouched records no claim row', async () => {
    mocks.getNodeMock.mockResolvedValue(stubNode({ claimedBySession: WORKER, claimedAt: new Date().toISOString() }));
    mocks.updateNodeMock.mockResolvedValue(
      stubNode({ claimedBySession: WORKER, claimedAt: new Date().toISOString(), percentComplete: 70 }),
    );

    const app = await buildApp();
    await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { percentComplete: 70 },
    });
    await app.close();

    await vi.waitFor(() => {
      expect(mocks.inserted.some((r) => r.fieldName === 'percentComplete')).toBe(true);
    });
    expect(mocks.inserted.some((r) => r.eventType === 'node.released' || r.eventType === 'node.claimed')).toBe(false);
  });
});

describe('GET /api/maps/:id/changes — eventType list', () => {
  it('splits a comma-separated eventType into the IN-filter', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/maps/${MAP_ID}/changes?nodeId=${NODE_ID}&eventType=node.claimed,node.released,node.pr_merged&limit=50`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(mocks.listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mapId: MAP_ID,
        nodeId: NODE_ID,
        eventType: undefined,
        eventTypes: ['node.claimed', 'node.released', 'node.pr_merged'],
        limit: 50,
      }),
    );
  });

  it('keeps a single eventType on the equality path', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/changes?eventType=map.field_changed` });
    await app.close();
    expect(mocks.listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'map.field_changed', eventTypes: undefined }),
    );
  });
});
