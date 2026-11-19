/**
 * Wiki routes (#637) — the real plugin, the service stubbed. What the route
 * owns: access (view to read, admin to set the connection, edit to publish),
 * which service call it makes, error → status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));
const svc = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), publish: vi.fn() }));

vi.mock('../../services/wikiPublish.js', async () => {
  class WikiValidationError extends Error {}
  class WikiForbiddenError extends Error {}
  class WikiNotConfiguredError extends Error {}
  class WikiPublishError extends Error {}
  return {
    WikiValidationError,
    WikiForbiddenError,
    WikiNotConfiguredError,
    WikiPublishError,
    wikiStatus: (...a: unknown[]) => svc.status(...a),
    saveWikiSettings: (...a: unknown[]) => svc.save(...a),
    publishMapToWiki: (...a: unknown[]) => svc.publish(...a),
  };
});
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));

import { wikiRoutes } from '../wiki.js';
import * as service from '../../services/wikiPublish.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId });
  });
  await app.register(wikiRoutes);
  return app;
}

const status = { configured: true, provider: 'outline', baseUrl: 'https://wiki', collectionId: 'c', document: null };

beforeEach(() => {
  userId = 'u1';
  state.perm = { [MAP]: 'edit' };
  for (const m of Object.values(svc)) m.mockReset();
});

describe('wiki routes', () => {
  it('a viewer reads the status; 404 for an unknown map', async () => {
    state.perm = { [MAP]: 'view' };
    const app = await buildApp();
    svc.status.mockResolvedValueOnce(status).mockResolvedValueOnce(null);
    const ok = await app.inject({ method: 'GET', url: `/api/maps/${MAP}/wiki` });
    expect(ok.json()).toEqual({ wiki: status });
    expect(svc.status).toHaveBeenCalledWith(MAP);
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/wiki` })).statusCode).toBe(404);
  });

  it('setting the connection needs admin and forwards body + user; service errors map to 400/403', async () => {
    const app = await buildApp();
    const body = { baseUrl: 'https://wiki', token: 't', collectionId: 'c' };
    expect((await app.inject({ method: 'PUT', url: `/api/maps/${MAP}/wiki`, payload: body })).statusCode).toBe(403);
    expect(svc.save).not.toHaveBeenCalled();

    state.perm = { [MAP]: 'admin' };
    svc.save.mockResolvedValueOnce(status);
    const ok = await app.inject({ method: 'PUT', url: `/api/maps/${MAP}/wiki`, payload: body });
    expect(ok.json()).toEqual({ wiki: status });
    expect(svc.save).toHaveBeenCalledWith(MAP, body, 'u1');

    svc.save.mockRejectedValueOnce(new service.WikiValidationError('baseUrl is required'));
    expect((await app.inject({ method: 'PUT', url: `/api/maps/${MAP}/wiki`, payload: {} })).statusCode).toBe(400);
    svc.save.mockRejectedValueOnce(new service.WikiForbiddenError('owner only'));
    expect((await app.inject({ method: 'PUT', url: `/api/maps/${MAP}/wiki`, payload: body })).statusCode).toBe(403);
  });

  it('publishing needs edit and passes the viewer zone', async () => {
    state.perm = { [MAP]: 'view' };
    const app = await buildApp();
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/wiki/publish`, payload: {} })).statusCode).toBe(403);

    state.perm = { [MAP]: 'edit' };
    const result = { documentId: 'd1', documentUrl: 'https://wiki/doc/d1', created: true, publishedAt: '2026-11-19T08:00:00.000Z' };
    svc.publish.mockResolvedValueOnce(result);
    const ok = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/wiki/publish`, payload: { tz: 'Europe/Zurich' } });
    expect(ok.json()).toEqual(result);
    expect(svc.publish).toHaveBeenCalledWith(MAP, { userId: 'u1', timeZone: 'Europe/Zurich' });
  });

  it('maps not-configured to 409 and a wiki failure to 502', async () => {
    const app = await buildApp();
    svc.publish.mockRejectedValueOnce(new service.WikiNotConfiguredError('connect a wiki'));
    const nc = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/wiki/publish`, payload: {} });
    expect(nc.statusCode).toBe(409);
    expect(nc.json().error.code).toBe('WIKI_NOT_CONFIGURED');
    svc.publish.mockRejectedValueOnce(new service.WikiPublishError('HTTP 401'));
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/wiki/publish`, payload: {} })).statusCode).toBe(502);
  });
});
