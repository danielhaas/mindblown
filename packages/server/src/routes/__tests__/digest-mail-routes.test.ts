/**
 * The daily mail's opt-out (#597): GET/PUT /api/me/digest-mail on the real
 * routes, db/digestMails and the fleet-user probe mocked below them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ enabled: new Map<string, boolean>(), fleetUsers: new Set<string>() }));

vi.mock('../../db/digestMails.js', () => ({
  getDigestMailEnabled: async (u: string) => state.enabled.get(u) ?? true,
  setDigestMailEnabled: vi.fn(async (u: string, on: boolean) => {
    state.enabled.set(u, on);
  }),
}));
vi.mock('../../db/fleets.js', () => ({ isFleetUser: async (u: string) => state.fleetUsers.has(u) }));

import { digestMailRoutes } from '../digestMail.js';

async function buildApp(userId: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (userId) req.userId = userId;
  });
  await app.register(digestMailRoutes);
  return app;
}

beforeEach(() => {
  state.enabled.clear();
  state.fleetUsers.clear();
});

describe('/api/me/digest-mail', () => {
  it('on by default', async () => {
    const app = await buildApp('u1');
    const res = await app.inject({ method: 'GET', url: '/api/me/digest-mail' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it('turns off and back on, per user', async () => {
    const app = await buildApp('u1');
    const off = await app.inject({ method: 'PUT', url: '/api/me/digest-mail', payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ enabled: false });
    expect((await app.inject({ method: 'GET', url: '/api/me/digest-mail' })).json()).toEqual({ enabled: false });
    expect((await (await buildApp('u2')).inject({ method: 'GET', url: '/api/me/digest-mail' })).json()).toEqual({ enabled: true });
    await app.inject({ method: 'PUT', url: '/api/me/digest-mail', payload: { enabled: true } });
    expect(state.enabled.get('u1')).toBe(true);
  });

  it('400 without a boolean', async () => {
    const app = await buildApp('u1');
    const res = await app.inject({ method: 'PUT', url: '/api/me/digest-mail', payload: { enabled: 'no' } });
    expect(res.statusCode).toBe(400);
    expect(state.enabled.size).toBe(0);
  });

  it('401 signed out, 403 for a fleet user', async () => {
    expect((await (await buildApp(null)).inject({ method: 'GET', url: '/api/me/digest-mail' })).statusCode).toBe(401);
    state.fleetUsers.add('svc');
    const app = await buildApp('svc');
    expect((await app.inject({ method: 'PUT', url: '/api/me/digest-mail', payload: { enabled: false } })).statusCode).toBe(403);
  });
});
