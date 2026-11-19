/**
 * Webhook routes — the real plugin, the service stubbed. What the route
 * owns: admin on the map (#403 guard), which service call each route makes,
 * a webhook not visible through this map is a 404, error → status, 201 with
 * the secret on create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAP = 'mmmm-mmmm';
const state = vi.hoisted(() => ({ perm: {} as Record<string, string | null> }));
const svc = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('../../services/webhooks.js', async () => {
  class WebhookValidationError extends Error {}
  class WebhookForbiddenError extends Error {}
  return {
    WebhookValidationError,
    WebhookForbiddenError,
    listWebhooks: (...a: unknown[]) => svc.list(...a),
    createWebhook: (...a: unknown[]) => svc.create(...a),
    getWebhookForMap: (...a: unknown[]) => svc.get(...a),
    updateWebhook: (...a: unknown[]) => svc.update(...a),
    deleteWebhook: (...a: unknown[]) => svc.del(...a),
    pingWebhook: (...a: unknown[]) => svc.ping(...a),
  };
});
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => state.perm[mapId] ?? null,
  hasPermission: (actual: string | null, required: string) => {
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return actual != null && rank[actual] >= rank[required];
  },
}));

import { webhookRoutes } from '../webhooks.js';
import * as service from '../../services/webhooks.js';

let userId: string | undefined = 'u1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    Object.assign(req, { userId });
  });
  await app.register(webhookRoutes);
  return app;
}

const sub = { id: 'w1', workspaceId: 'ws', mapId: MAP, url: 'https://hub.example', events: [], active: true };

beforeEach(() => {
  userId = 'u1';
  state.perm = { [MAP]: 'admin' };
  for (const m of Object.values(svc)) m.mockReset();
  svc.get.mockResolvedValue(sub);
});

describe('webhook routes', () => {
  it('needs admin on the map — edit is not enough, no user is a 401', async () => {
    const app = await buildApp();
    state.perm = { [MAP]: 'edit' };
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/webhooks` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/webhooks`, payload: { url: 'https://x' } })).statusCode).toBe(403);
    userId = undefined;
    expect((await app.inject({ method: 'GET', url: `/api/maps/${MAP}/webhooks` })).statusCode).toBe(401);
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('lists and creates (201, body and user forwarded)', async () => {
    const app = await buildApp();
    svc.list.mockResolvedValue([sub]);
    const list = await app.inject({ method: 'GET', url: `/api/maps/${MAP}/webhooks` });
    expect(list.json()).toEqual({ webhooks: [sub] });
    expect(svc.list).toHaveBeenCalledWith(MAP);

    svc.create.mockResolvedValue({ ...sub, secret: 's3cret' });
    const body = { url: 'https://hub.example', events: ['node.done'], scope: 'workspace' };
    const res = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/webhooks`, payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json().webhook.secret).toBe('s3cret');
    expect(svc.create).toHaveBeenCalledWith(MAP, body, 'u1');
  });

  it('maps validation → 400, forbidden → 403', async () => {
    const app = await buildApp();
    svc.create.mockRejectedValueOnce(new service.WebhookValidationError('url must be http(s)'));
    const bad = await app.inject({ method: 'POST', url: `/api/maps/${MAP}/webhooks`, payload: { url: 'ftp://x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toEqual({ code: 'VALIDATION_ERROR', message: 'url must be http(s)' });
    svc.update.mockRejectedValueOnce(new service.WebhookForbiddenError('owner only'));
    expect((await app.inject({ method: 'PATCH', url: `/api/maps/${MAP}/webhooks/w1`, payload: { active: false } })).statusCode).toBe(403);
  });

  it('patch, delete and ping act on the webhook as seen through the map; another map\'s is a 404', async () => {
    const app = await buildApp();
    svc.update.mockResolvedValue({ ...sub, active: false });
    const p = await app.inject({ method: 'PATCH', url: `/api/maps/${MAP}/webhooks/w1`, payload: { active: false } });
    expect(p.json().webhook.active).toBe(false);
    expect(svc.get).toHaveBeenCalledWith(MAP, 'w1');
    expect(svc.update).toHaveBeenCalledWith(sub, { active: false }, 'u1');

    svc.del.mockResolvedValue(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/maps/${MAP}/webhooks/w1` })).json()).toEqual({ deleted: true, id: 'w1' });
    expect(svc.del).toHaveBeenCalledWith(sub, 'u1');

    svc.ping.mockResolvedValue({ ok: false, retry: true, status: 502, error: 'HTTP 502' });
    expect((await app.inject({ method: 'POST', url: `/api/maps/${MAP}/webhooks/w1/ping` })).json()).toEqual({ delivered: false, status: 502, error: 'HTTP 502' });
    expect(svc.ping).toHaveBeenCalledWith('w1', MAP);

    svc.get.mockResolvedValue(null);
    for (const [method, url] of [['PATCH', 'w9'], ['DELETE', 'w9'], ['POST', 'w9/ping']] as const) {
      const r = await app.inject({ method, url: `/api/maps/${MAP}/webhooks/${url}`, payload: method === 'PATCH' ? { active: true } : undefined });
      expect(r.statusCode).toBe(404);
    }
  });
});
