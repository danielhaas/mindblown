/**
 * Map access (#403) — the decision and the two hooks that apply it.
 *
 * Permissions and node lookups are stubbed; what is pinned is the rule:
 * 401 with no user, 403 below the level, 404 for a node on another map,
 * view for reads and edit for writes, and that a hook installed inside a
 * plugin stays inside it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'map-1';
const OTHER = 'map-2';

vi.mock('../../db/permissions.js', () => {
  const levels: Record<string, number> = { view: 1, edit: 2, admin: 3 };
  return {
    getPermission: async (mapId: string, userId: string) => {
      if (mapId !== MAP) return null;
      return { viewer: 'view', editor: 'edit', owner: 'admin' }[userId] ?? null;
    },
    hasPermission: (actual: string | null, required: string) =>
      !!actual && levels[actual] >= levels[required],
  };
});
const nodeMapId = async (nodeId: string) =>
  nodeId === 'n-here' ? MAP : nodeId === 'n-there' ? OTHER : null;

import { checkMapAccess, guardMapIdInPayload, guardMapRoutes } from '../mapAccess.js';

describe('checkMapAccess', () => {
  it('401 without a user, 403 below the level, null at or above it', async () => {
    expect(await checkMapAccess(undefined, MAP, 'view')).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(await checkMapAccess('stranger', MAP, 'view')).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await checkMapAccess('viewer', MAP, 'edit')).toMatchObject({ status: 403 });
    expect(await checkMapAccess('viewer', MAP, 'view')).toBeNull();
    expect(await checkMapAccess('editor', MAP, 'edit')).toBeNull();
    expect(await checkMapAccess('editor', MAP, 'admin')).toMatchObject({ status: 403 });
    expect(await checkMapAccess('owner', MAP, 'admin')).toBeNull();
  });

  it('names the level in the 403 so the caller knows what is missing', async () => {
    expect((await checkMapAccess('viewer', MAP, 'edit'))?.message).toMatch(/edit permission/);
    expect((await checkMapAccess('stranger', MAP, 'view'))?.message).toMatch(/access to this map/);
  });
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** A user is whoever the x-user header names; none = anonymous. */
function withUser(a: FastifyInstance): void {
  a.addHook('preHandler', async (req) => {
    const u = req.headers['x-user'];
    if (typeof u === 'string' && u) req.userId = u;
  });
}

describe('guardMapRoutes', () => {
  async function build(): Promise<FastifyInstance> {
    const a = Fastify();
    withUser(a);
    await a.register(async (plugin) => {
      guardMapRoutes(plugin, { nodeMapId });
      plugin.get('/api/maps/:id/nodes', async () => ({ ok: 'read' }));
      plugin.post('/api/maps/:id/nodes', async () => ({ ok: 'write' }));
      plugin.get('/api/maps/:id/nodes/:nodeId', async () => ({ ok: 'read-node' }));
      plugin.put('/api/maps/:id/nodes/:nodeId', async () => ({ ok: 'write-node' }));
    });
    // A sibling plugin without the guard must stay open: the hook is scoped.
    await a.register(async (plugin) => {
      plugin.get('/api/open/:id', async () => ({ ok: 'open' }));
    });
    await a.ready();
    return a;
  }
  const hit = (method: 'GET' | 'POST' | 'PUT', url: string, user?: string) =>
    app!.inject({ method, url, headers: user ? { 'x-user': user } : {} });

  it('401 anonymous, 403 stranger, view reads, edit writes', async () => {
    app = await build();
    expect((await hit('GET', `/api/maps/${MAP}/nodes`)).statusCode).toBe(401);
    expect((await hit('GET', `/api/maps/${MAP}/nodes`, 'stranger')).statusCode).toBe(403);
    expect((await hit('GET', `/api/maps/${MAP}/nodes`, 'viewer')).json()).toEqual({ ok: 'read' });
    expect((await hit('POST', `/api/maps/${MAP}/nodes`, 'viewer')).statusCode).toBe(403);
    expect((await hit('POST', `/api/maps/${MAP}/nodes`, 'editor')).json()).toEqual({ ok: 'write' });
  });

  it('404s a node that hangs on another map, passes one on this map or none at all', async () => {
    app = await build();
    expect((await hit('GET', `/api/maps/${MAP}/nodes/n-there`, 'viewer')).statusCode).toBe(404);
    expect((await hit('PUT', `/api/maps/${MAP}/nodes/n-there`, 'editor')).statusCode).toBe(404);
    expect((await hit('GET', `/api/maps/${MAP}/nodes/n-here`, 'viewer')).json()).toEqual({ ok: 'read-node' });
    // Unknown node: the handler decides, not the guard.
    expect((await hit('GET', `/api/maps/${MAP}/nodes/n-gone`, 'viewer')).json()).toEqual({ ok: 'read-node' });
  });

  it('checks the map before the node — a stranger learns nothing about node ids', async () => {
    app = await build();
    expect((await hit('GET', `/api/maps/${MAP}/nodes/n-there`, 'stranger')).statusCode).toBe(403);
  });

  it('stays inside the plugin it was installed in', async () => {
    app = await build();
    expect((await hit('GET', `/api/open/${MAP}`)).json()).toEqual({ ok: 'open' });
  });
});

describe('guardMapIdInPayload', () => {
  async function build(): Promise<FastifyInstance> {
    const a = Fastify();
    withUser(a);
    await a.register(async (plugin) => {
      guardMapIdInPayload(plugin, { editPaths: new Set(['/api/ai/apply']) });
      plugin.post('/api/ai/propose', async () => ({ ok: 'propose' }));
      plugin.post('/api/ai/apply', async () => ({ ok: 'apply' }));
      plugin.get('/api/ai/search', async () => ({ ok: 'search' }));
      plugin.get('/api/ai/config', async () => ({ ok: 'config' }));
    });
    await a.ready();
    return a;
  }

  it('reads mapId from the body and the query; view by default, edit for listed paths', async () => {
    app = await build();
    const post = (url: string, user: string | undefined, body: Record<string, unknown>) =>
      app!.inject({ method: 'POST', url, headers: user ? { 'x-user': user } : {}, payload: body });
    expect((await post('/api/ai/propose', undefined, { mapId: MAP })).statusCode).toBe(401);
    expect((await post('/api/ai/propose', 'stranger', { mapId: MAP })).statusCode).toBe(403);
    expect((await post('/api/ai/propose', 'viewer', { mapId: MAP })).json()).toEqual({ ok: 'propose' });
    expect((await post('/api/ai/apply', 'viewer', { mapId: MAP })).statusCode).toBe(403);
    expect((await post('/api/ai/apply', 'editor', { mapId: MAP })).json()).toEqual({ ok: 'apply' });

    expect((await app.inject({ method: 'GET', url: `/api/ai/search?mapId=${MAP}&q=x`, headers: { 'x-user': 'stranger' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/ai/search?mapId=${MAP}&q=x`, headers: { 'x-user': 'viewer' } })).json()).toEqual({ ok: 'search' });
  });

  it('lets a request that names no map through to the handler', async () => {
    app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/ai/config' })).json()).toEqual({ ok: 'config' });
    expect((await app.inject({ method: 'POST', url: '/api/ai/propose', payload: {} })).json()).toEqual({ ok: 'propose' });
  });

  it('ignores a mapId that is not a string', async () => {
    app = await build();
    expect((await app.inject({ method: 'POST', url: '/api/ai/propose', payload: { mapId: 42 } })).json()).toEqual({ ok: 'propose' });
  });
});
