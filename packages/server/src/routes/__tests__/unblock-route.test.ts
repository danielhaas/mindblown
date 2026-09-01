/**
 * POST /api/maps/:id/nodes/:nodeId/unblock — release a parked ticket.
 *
 * The fleet's give-up path latches a ticket with three fields; the old
 * clear_blocker undid one and left the node status=blocked, invisible to
 * dispatch. This pins the one-call undo: status back to the workflow's
 * todo, blockedReason cleared, `blocked` tag removed, attributed
 * change_events, node:updated broadcast — and that finished work is not
 * re-opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const updateNodeMock = vi.fn();
const getNodeMock = vi.fn();
const getStatusWorkflowMock = vi.fn();
const recordFieldChangesMock = vi.fn(async () => {});
const broadcastMock = vi.fn();

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    updateNode: (...args: unknown[]) => updateNodeMock(...args),
    getNode: (...args: unknown[]) => getNodeMock(...args),
  };
});
vi.mock('../../db/maps.js', () => ({
  updateMap: vi.fn(),
  getStatusWorkflow: (...args: unknown[]) => getStatusWorkflowMock(...args),
}));
vi.mock('../../db/events.js', () => ({
  recordEvent: vi.fn(async () => {}),
  recordFieldChanges: (...args: unknown[]) => recordFieldChangesMock(...(args as [])),
}));
vi.mock('../../ws.js', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const NODE_ID = 'nnnn-nnnn-nnnn-nnnn';
const USER_ID = 'uuuu-uuuu-uuuu-uuuu';

const WORKFLOW = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
  { id: 'in_progress', name: 'Doing', category: 'in_progress', color: '#000', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 2 },
];

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NODE_ID,
    mapId: MAP_ID,
    parentId: 'pppp',
    childrenIds: [],
    text: '#8755 FM mail relay token',
    status: 'blocked',
    blockedReason: 'needs Dan: deploy CT122',
    tags: ['app:fm', 'blocked'],
    externalLinks: [],
    attachments: [],
    dependencies: [],
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = USER_ID;
    req.authSource = 'jwt';
  });
  await app.register(nodeRoutes);
  return app;
}

beforeEach(() => {
  updateNodeMock.mockReset();
  getNodeMock.mockReset();
  getStatusWorkflowMock.mockReset();
  recordFieldChangesMock.mockClear();
  broadcastMock.mockReset();
  getStatusWorkflowMock.mockResolvedValue(WORKFLOW);
});

describe('POST /api/maps/:id/nodes/:nodeId/unblock', () => {
  it('undoes all three latch fields in one write and reports the status reset', async () => {
    const before = node();
    const after = node({ status: 'todo', blockedReason: null, tags: ['app:fm'] });
    getNodeMock.mockResolvedValueOnce(before);
    updateNodeMock.mockResolvedValueOnce(after);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/unblock` });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateNodeMock).toHaveBeenCalledWith(NODE_ID, { blockedReason: null, tagsRemove: ['blocked'], status: 'todo' });
    expect(recordFieldChangesMock).toHaveBeenCalledWith(MAP_ID, NODE_ID, USER_ID, before, after);
    expect(broadcastMock).toHaveBeenCalledWith(MAP_ID, expect.objectContaining({ type: 'node:updated', nodeId: NODE_ID, node: after }));
    expect(res.json()).toEqual({ node: after, statusReset: true });
  });

  it('re-queues an in_progress ticket too (the worker is gone), but never re-opens done work', async () => {
    getNodeMock.mockResolvedValueOnce(node({ status: 'in_progress', tags: [] }));
    updateNodeMock.mockResolvedValueOnce(node({ status: 'todo', blockedReason: null, tags: [] }));
    let app = await buildApp();
    let res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/unblock` });
    await app.close();
    expect(updateNodeMock).toHaveBeenLastCalledWith(NODE_ID, { blockedReason: null, status: 'todo' });
    expect(res.json().statusReset).toBe(true);

    getNodeMock.mockResolvedValueOnce(node({ status: 'done' }));
    updateNodeMock.mockResolvedValueOnce(node({ status: 'done', blockedReason: null, tags: ['app:fm'] }));
    app = await buildApp();
    res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/unblock` });
    await app.close();
    expect(updateNodeMock).toHaveBeenLastCalledWith(NODE_ID, { blockedReason: null, tagsRemove: ['blocked'] });
    expect(res.json().statusReset).toBe(false);
  });

  it('404s for a node outside the map and writes nothing', async () => {
    getNodeMock.mockResolvedValueOnce(node({ mapId: 'other-map' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP_ID}/nodes/${NODE_ID}/unblock` });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(updateNodeMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
