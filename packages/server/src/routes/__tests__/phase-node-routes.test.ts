/**
 * Route tests for the phase column on the node write surface.
 *
 * nodes.phaseId references a PhaseDef.id from maps.phases (statusWorkflow
 * idiom). These tests lock down the REST wiring:
 *   - PUT  /api/maps/:id/nodes/:nodeId forwards phaseId (set AND null/clear)
 *     verbatim to db updateNode,
 *   - POST /api/maps/:id/nodes forwards phaseId on create,
 *   - PhaseIdValidationError from the DB layer maps to 400 UNKNOWN_PHASE_ID
 *     on both routes.
 *
 * Mock pattern mirrors maps-triage-flags.test.ts — stub the DB layer +
 * side-effect modules, exercise route wiring without Postgres. The DB
 * module is spread from the real one so error classes keep identity for
 * the route's `instanceof` checks.
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
import { PhaseIdValidationError } from '../../db/nodes.js';

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
    phaseId: null,
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

describe('PUT /api/maps/:id/nodes/:nodeId — phaseId round-trip', () => {
  it('forwards phaseId (set) to updateNode and returns the updated node', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ phaseId: 'ph-1' }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { phaseId: 'ph-1' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock).toHaveBeenCalledOnce();
    expect(updateNodeMock.mock.calls[0][0]).toBe(NODE_ID);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ phaseId: 'ph-1' });
    expect(res.json().phaseId).toBe('ph-1');
  });

  it('forwards phaseId: null (clear) — null survives as a value, not an omission', async () => {
    updateNodeMock.mockResolvedValueOnce(stubNode({ phaseId: null }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { phaseId: null },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock.mock.calls[0][1]).toEqual({ phaseId: null });
    expect(res.json().phaseId).toBeNull();
  });

  it('maps PhaseIdValidationError to 400 UNKNOWN_PHASE_ID', async () => {
    updateNodeMock.mockRejectedValueOnce(new PhaseIdValidationError('ph-nope'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}`,
      payload: { phaseId: 'ph-nope' },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_PHASE_ID');
    expect(res.json().error.message).toContain('ph-nope');
  });
});

describe('POST /api/maps/:id/nodes — phaseId on create', () => {
  it('forwards phaseId to createNode', async () => {
    createNodeMock.mockResolvedValueOnce(stubNode({ phaseId: 'ph-2', text: 'phased task' }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'phased task', phaseId: 'ph-2' },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    expect(createNodeMock).toHaveBeenCalledOnce();
    expect(createNodeMock.mock.calls[0][0]).toMatchObject({
      mapId: MAP_ID,
      parentId: 'pppp-pppp',
      text: 'phased task',
      phaseId: 'ph-2',
    });
    expect(res.json().phaseId).toBe('ph-2');
  });

  it('maps PhaseIdValidationError to 400 UNKNOWN_PHASE_ID on create', async () => {
    createNodeMock.mockRejectedValueOnce(new PhaseIdValidationError('ph-nope'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/maps/${MAP_ID}/nodes`,
      payload: { parentId: 'pppp-pppp', text: 'phased task', phaseId: 'ph-nope' },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_PHASE_ID');
  });
});
