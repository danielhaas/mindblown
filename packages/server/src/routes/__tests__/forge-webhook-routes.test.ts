/**
 * GET/POST /api/integrations/forge/webhook (#386): gated like binding the
 * repo, 404 without a forge, the secret never in a response, and a missing
 * PUBLIC_URL explained instead of a guessed payload URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

const canManage = vi.fn();
vi.mock('../auth-gitea.js', () => ({ canManageWorkspaceForge: (...a: unknown[]) => canManage(...a) }));

const getRow = vi.fn();
vi.mock('../../lib/githubContext.js', () => ({ getForgeIntegration: (...a: unknown[]) => getRow(...a) }));

const readHook = vi.fn();
const setUp = vi.fn();
vi.mock('../../lib/forgeWebhook.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/forgeWebhook.js');
  return { ...actual, readForgeWebhook: (...a: unknown[]) => readHook(...a), setUpWebhookAfterBind: (...a: unknown[]) => setUp(...a) };
});

import { forgeWebhookRoutes } from '../forgeWebhook.js';

const ROW = { id: 'i1', provider: 'gitea', config: { owner: 'dan', repo: 'r', token: 'tok', webhookSecret: 'SUPERSECRET' } };

async function build() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = 'u1';
  });
  await app.register(forgeWebhookRoutes);
  await app.ready();
  return app;
}

const savedUrl = process.env.PUBLIC_URL;
beforeEach(() => {
  vi.clearAllMocks();
  canManage.mockResolvedValue(true);
  getRow.mockResolvedValue(ROW);
  process.env.PUBLIC_URL = 'https://mb.test';
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = savedUrl;
});

describe('forge webhook routes', () => {
  it('403 for someone who may not manage the workspace forge; 404 without a forge', async () => {
    const app = await build();
    canManage.mockResolvedValueOnce(false);
    expect((await app.inject({ method: 'GET', url: '/api/integrations/forge/webhook?workspaceId=w1' })).statusCode).toBe(403);
    getRow.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/forge/webhook', payload: { workspaceId: 'w1' } })).statusCode).toBe(404);
    expect(setUp).not.toHaveBeenCalled();
  });

  it('GET reports the state and never the secret', async () => {
    readHook.mockResolvedValue({ url: 'https://mb.test/api/webhooks/github', events: ['issues'], secretStored: true, hook: null, missingEvents: ['issues'] });
    const res = await (await build()).inject({ method: 'GET', url: '/api/integrations/forge/webhook?workspaceId=w1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repo: 'dan/r', url: 'https://mb.test/api/webhooks/github', secretStored: true });
    expect(res.body).not.toContain('SUPERSECRET');
    expect(res.body).not.toContain('tok');
  });

  it('GET without PUBLIC_URL explains it and asks the forge nothing', async () => {
    delete process.env.PUBLIC_URL;
    const savedFront = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    const res = await (await build()).inject({ method: 'GET', url: '/api/integrations/forge/webhook?workspaceId=w1' });
    if (savedFront !== undefined) process.env.FRONTEND_URL = savedFront;
    expect(res.json()).toMatchObject({ url: null, readError: expect.stringMatching(/PUBLIC_URL/) });
    expect(readHook).not.toHaveBeenCalled();
  });

  it('POST relays the set-up result, a refusal included, as 200', async () => {
    setUp.mockResolvedValue({ status: 'failed', reason: 'gitea answered 403', hint: 'admin' });
    const res = await (await build()).inject({ method: 'POST', url: '/api/integrations/forge/webhook', payload: { workspaceId: 'w1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'failed', reason: 'gitea answered 403', hint: 'admin' });
    expect(setUp).toHaveBeenCalledWith(ROW);
  });
});
