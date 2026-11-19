/**
 * Wrong-map guard on the real `nodeRoutes` plugin: create_node warns and
 * holds a ticket naming another map's repo, and move-to-map re-homes it.
 * The DB modules, the forge binding lookup and the fleet rollups are
 * stubbed; services/misfiled.ts and services/moveToMap.ts run for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { dispatchHold, MISFILED_TAG, type Node } from '@mindblown/core';

const MB = 'map-mindblown';
const CF = 'map-claude-fleet';
const OTHER_WS = 'map-other-workspace';

const h = vi.hoisted(() => ({
  nodes: new Map<string, Record<string, unknown>>(),
  rollups: [] as unknown[],
  moveWrite: vi.fn(),
  createNode: vi.fn(),
  createComment: vi.fn(async () => ({})),
  recordEvent: vi.fn(async () => {}),
  recordClaimTransition: vi.fn(async () => {}),
  broadcast: vi.fn(),
}));

vi.mock('../../db/permissions.js', () => {
  const levels: Record<string, number> = { view: 1, edit: 2, admin: 3 };
  return {
    getPermission: async (mapId: string, userId: string) => {
      if (userId === 'dan') return 'admin';
      if (userId === 'source-only') return mapId === 'map-mindblown' ? 'edit' : 'view';
      return null;
    },
    hasPermission: (actual: string | null, required: string) => !!actual && levels[actual] >= levels[required],
  };
});

vi.mock('../../lib/githubContext.js', () => ({
  getForgeRepoForMap: async (mapId: string) =>
    mapId === 'map-mindblown'
      ? { owner: 'danielhaas', name: 'mindblown' }
      : mapId === 'map-claude-fleet'
        ? { owner: 'danielhaas', name: 'claude-fleet' }
        : null,
}));

vi.mock('../../db/maps.js', () => {
  const meta: Record<string, { name: string; workspaceId: string; rootNodeId: string }> = {
    'map-mindblown': { name: 'MindBlown', workspaceId: 'ws', rootNodeId: 'mb-root' },
    'map-claude-fleet': { name: 'claude-fleet', workspaceId: 'ws', rootNodeId: 'cf-root' },
    'map-other-workspace': { name: 'Elsewhere', workspaceId: 'ws2', rootNodeId: 'ow-root' },
  };
  return {
    listMapsForUser: async () => Object.entries(meta).map(([id, m]) => ({ id, ...m, archivedAt: null })),
    getMap: async (mapId: string) => {
      const m = meta[mapId];
      if (!m) return null;
      return { map: { id: mapId, ...m }, nodes: [...h.nodes.values()].filter((n) => n.mapId === mapId) };
    },
    updateMap: vi.fn(),
  };
});

vi.mock('../../db/nodes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/nodes.js')>();
  return {
    ...actual,
    getNode: async (id: string) => h.nodes.get(id) ?? null,
    getNodeMapId: async (id: string) => (h.nodes.get(id)?.mapId as string | undefined) ?? null,
    createNode: h.createNode,
    moveSubtreeToMap: h.moveWrite,
  };
});
vi.mock('../../db/comments.js', () => ({ createComment: h.createComment }));
vi.mock('../../db/events.js', () => ({
  recordEvent: h.recordEvent,
  recordFieldChanges: vi.fn(async () => {}),
  recordClaimTransition: h.recordClaimTransition,
}));
vi.mock('../../db/fleets.js', () => ({ getMapFleetId: async () => 'fleet-1', isFleetUser: async () => false }));
vi.mock('../../db/fleet.js', () => ({ listRollups: async () => h.rollups }));
vi.mock('../../ws.js', () => ({ broadcast: h.broadcast }));
vi.mock('../../ai/embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
vi.mock('@mindblown/integrations', () => ({ updateGitHubIssue: vi.fn(), getGitHubIssue: vi.fn() }));
vi.mock('../integrations.js', () => ({ getGitHubContextForMap: vi.fn(async () => null) }));

import { nodeRoutes } from '../nodes.js';

function node(id: string, mapId: string, over: Partial<Node> = {}): Record<string, unknown> {
  return {
    id,
    mapId,
    parentId: null,
    childrenIds: [],
    text: id,
    description: null,
    effortEstimate: null,
    percentComplete: null,
    status: null,
    priority: null,
    tags: [],
    dependencies: [],
    externalLinks: [],
    attachments: [],
    versionId: null,
    cycleId: null,
    phaseId: null,
    claimedBySession: null,
    claimedAt: null,
    linkedPr: null,
    ...over,
  };
}

const ghLink = (externalId: string) => ({
  provider: 'github',
  externalId,
  url: `https://github.com/${externalId.replace('#', '/issues/')}`,
  syncEnabled: true,
  lastSyncedAt: null,
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  h.rollups = [];
  h.nodes.clear();
  for (const n of [
    node('mb-root', MB, { childrenIds: ['ticket', 'stays'] }),
    node('ticket', MB, {
      parentId: 'mb-root',
      childrenIds: ['sub'],
      text: 'fleet-worker (claude-fleet): keep the worktree',
      description: '**Repo:** github.com/danielhaas/claude-fleet',
      priority: 'P1',
      effortEstimate: 3,
      percentComplete: 20,
      tags: ['fleet', MISFILED_TAG],
      versionId: 'v-mb',
      cycleId: 's-mb',
      phaseId: 'ph',
      externalLinks: [ghLink('danielhaas/claude-fleet#98'), ghLink('danielhaas/mindblown#546'), { provider: 'url', externalId: 'doc', url: 'https://x', syncEnabled: false, lastSyncedAt: null }],
      dependencies: [{ targetNodeId: 'stays', type: 'FS', lag: 0 }],
    }),
    node('sub', MB, { parentId: 'ticket', dependencies: [{ targetNodeId: 'ticket', type: 'FS', lag: 0 }] }),
    node('stays', MB, { parentId: 'mb-root', text: 'panel work', dependencies: [{ targetNodeId: 'sub', type: 'FS', lag: 0 }] }),
    node('cf-root', CF, { childrenIds: [] }),
    node('ow-root', OTHER_WS),
  ]) {
    h.nodes.set(n.id as string, n);
  }
  h.createNode.mockImplementation(async (input: Record<string, unknown>) => ({ ...node('new', input.mapId as string), ...input, id: 'new' }));
  h.moveWrite.mockImplementation(async (w: { rootId: string; toMapId: string; toParentId: string; moved: Array<Record<string, unknown>> }) =>
    w.moved.map((m) => ({ ...h.nodes.get(m.id as string), ...m, mapId: w.toMapId, ...(m.id === w.rootId ? { parentId: w.toParentId } : {}), versionId: null, cycleId: null, phaseId: null, claimedBySession: null })),
  );

  app = Fastify();
  app.addHook('preHandler', async (req) => {
    const u = req.headers['x-user'];
    if (typeof u === 'string' && u) req.userId = u;
  });
  await app.register(nodeRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/maps/${MB}/nodes`, headers: { 'x-user': 'dan' }, payload });
const move = (nodeId: string, payload: Record<string, unknown>, user = 'dan', fromMapId = MB) =>
  app.inject({ method: 'POST', url: `/api/maps/${fromMapId}/nodes/${nodeId}/move-to-map`, headers: { 'x-user': user }, payload });

describe('create_node — wrong-map guard', () => {
  it('the 19.11 case: created, warned, held from the fleet', async () => {
    const res = await create({
      parentId: 'mb-root',
      text: 'fleet-worker (claude-fleet): keep the worktree on a crash',
      description: '**Why:** x\n**Repo:** github.com/danielhaas/claude-fleet',
      tags: ['fleet'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().misfiled).toEqual({ repo: 'danielhaas/claude-fleet', suggestedMapId: CF, suggestedMapName: 'claude-fleet' });
    const input = h.createNode.mock.calls[0][0] as { tags: string[] };
    expect(input.tags).toEqual(['fleet', MISFILED_TAG]);
    const approval = { state: 'approved' as const, merge: 'auto' as const, by: 'dan', at: '2026-11-19T00:00:00Z' };
    expect(dispatchHold({ tags: res.json().tags, blockedReason: null, approval })).toMatchObject({ tag: MISFILED_TAG });
  });

  it('a running-text mention creates a plain node: no warning, no hold', async () => {
    const res = await create({ parentId: 'mb-root', text: 'Panel: show the fleet', description: 'Like claude-fleet #98 does.' });
    expect(res.statusCode).toBe(201);
    expect(res.json().misfiled).toBeUndefined();
    expect((h.createNode.mock.calls[0][0] as { tags?: string[] }).tags).toBeUndefined();
  });

  it("naming the map's own repo is no warning", async () => {
    const res = await create({ parentId: 'mb-root', text: 'mindblown: x', description: 'Repo: danielhaas/mindblown' });
    expect(res.json().misfiled).toBeUndefined();
  });
});

describe('POST /api/maps/:id/nodes/:nodeId/move-to-map', () => {
  it('moves the subtree under the target root: fields carried, per-map fields cleared, hold off', async () => {
    const res = await move('ticket', { toMapId: CF });
    expect(res.statusCode).toBe(200);
    const w = h.moveWrite.mock.calls[0][0];
    expect(w).toMatchObject({ rootId: 'ticket', fromMapId: MB, toMapId: CF, fromParentId: 'mb-root', toParentId: 'cf-root' });
    expect(w.moved.map((m: { id: string }) => m.id)).toEqual(['ticket', 'sub']);
    expect(w.moved[0].tags).toEqual(['fleet']);
    const body = res.json();
    expect(body).toMatchObject({ fromMapId: MB, toMapId: CF, toMapName: 'claude-fleet', movedIds: ['ticket', 'sub'] });
    expect(body.node).toMatchObject({
      id: 'ticket',
      mapId: CF,
      parentId: 'cf-root',
      text: 'fleet-worker (claude-fleet): keep the worktree',
      description: '**Repo:** github.com/danielhaas/claude-fleet',
      priority: 'P1',
      effortEstimate: 3,
      percentComplete: 20,
      versionId: null,
      cycleId: null,
      phaseId: null,
    });
    // Old map drops it (not to the Trash), new map gets it; both change logs say so.
    expect(h.broadcast).toHaveBeenCalledWith(MB, { type: 'node:deleted', nodeId: 'ticket', deletedIds: ['ticket', 'sub'] });
    expect(h.broadcast).toHaveBeenCalledWith(CF, expect.objectContaining({ type: 'node:created' }));
    const logged = (h.recordEvent.mock.calls as unknown as Array<[{ mapId: string; eventType: string }]>).map((c) => c[0]);
    expect(logged.filter((e) => e.eventType === 'node.moved').map((e) => e.mapId)).toEqual([MB, CF]);
  });

  it("keeps an issue link into the target map's repo, drops another repo's with a note", async () => {
    const res = await move('ticket', { toMapId: CF });
    const links = h.moveWrite.mock.calls[0][0].moved[0].externalLinks.map((l: { externalId: string }) => l.externalId);
    expect(links).toEqual(['danielhaas/claude-fleet#98', 'doc']);
    expect(res.json().notes.some((n: string) => n.includes('danielhaas/mindblown#546'))).toBe(true);
    expect(h.createComment).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'ticket', text: expect.stringContaining('danielhaas/mindblown#546') }));
  });

  it('drops dependencies across the maps with a note on both ends; one inside the subtree stays', async () => {
    await move('ticket', { toMapId: CF });
    const w = h.moveWrite.mock.calls[0][0];
    expect(w.moved[0].dependencies).toEqual([]); // ticket → stays: crosses
    expect(w.moved[1].dependencies).toEqual([{ targetNodeId: 'ticket', type: 'FS', lag: 0 }]); // sub → ticket: inside
    expect(w.leftBehind).toEqual([{ id: 'stays', dependencies: [] }]); // stays → sub: crosses
    const noted = (h.createComment.mock.calls as unknown as Array<[{ nodeId: string; text: string }]>).map((c) => c[0]);
    const depNotes = noted.filter((c) => c.text.startsWith('Dependency dropped'));
    expect(depNotes.map((c) => c.nodeId).sort()).toEqual(['stays', 'stays', 'sub', 'ticket'].sort());
  });

  it('takes a parent in the target map; refuses one that is not there', async () => {
    h.nodes.set('cf-epic', node('cf-epic', CF, { parentId: 'cf-root' }));
    expect((await move('ticket', { toMapId: CF, parentId: 'cf-epic' })).statusCode).toBe(200);
    expect(h.moveWrite.mock.calls[0][0].toParentId).toBe('cf-epic');
    const bad = await move('ticket', { toMapId: CF, parentId: 'stays' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('PARENT_NOT_FOUND');
  });

  it('refuses while an agent runs on the ticket; a claim with no agent running is released', async () => {
    h.nodes.set('ticket', { ...h.nodes.get('ticket')!, claimedBySession: 'host/worker-1' });
    const at = new Date().toISOString();
    h.rollups = [{ generatedAt: at, receivedAt: at, rollup: { host: 'big', v: 2, generated_at: at, workers: [], claims: [{ nodeId: 'ticket', phase: 'working' }] } }];
    const refused = await move('ticket', { toMapId: CF });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('AGENT_RUNNING');
    expect(h.moveWrite).not.toHaveBeenCalled();

    h.rollups = [];
    const ok = await move('ticket', { toMapId: CF });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().notes).toContain('"fleet-worker (claude-fleet): keep the worktree": claim released.');
    expect(h.recordClaimTransition).toHaveBeenCalledWith(MB, 'ticket', 'dan', expect.anything(), expect.anything(), expect.objectContaining({ reason: 'release' }));
  });

  it('needs edit on both maps, one workspace, another map, a non-root node', async () => {
    const noTarget = await move('ticket', { toMapId: CF }, 'source-only');
    expect(noTarget.statusCode).toBe(403);
    expect((await move('ticket', { toMapId: OTHER_WS })).json().error.code).toBe('OTHER_WORKSPACE');
    expect((await move('ticket', { toMapId: MB })).json().error.code).toBe('SAME_MAP');
    expect((await move('mb-root', { toMapId: CF })).json().error.code).toBe('ROOT_NODE');
    expect((await move('ticket', {})).statusCode).toBe(400);
    expect(h.moveWrite).not.toHaveBeenCalled();
  });
});
