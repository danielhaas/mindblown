/**
 * GET/PUT /api/me/answerer-name on the real routes, db/answerer mocked below them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { answererName } from '@mindblown/core';

const state = vi.hoisted(() => ({ own: new Map<string, string | null>() }));
const NAMES: Record<string, string> = { u1: 'Daniel Haas' };

vi.mock('../../db/answerer.js', () => ({
  getAnswerer: async (u: string) => (NAMES[u] ? { answererName: state.own.get(u) ?? null, effective: answererName(NAMES[u], state.own.get(u)) } : null),
  setAnswerer: vi.fn(async (u: string, name: string | null) => {
    if (!NAMES[u]) return null;
    state.own.set(u, name?.trim() || null);
    return { answererName: state.own.get(u) ?? null, effective: answererName(NAMES[u], state.own.get(u)) };
  }),
}));

import { answererRoutes } from '../answerer.js';

async function buildApp(userId: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (userId) req.userId = userId;
  });
  await app.register(answererRoutes);
  return app;
}

beforeEach(() => state.own.clear());

describe('/api/me/answerer-name', () => {
  it('defaults to the first name; set "Dan" files asks under Dan; null clears it', async () => {
    const app = await buildApp('u1');
    expect((await app.inject({ method: 'GET', url: '/api/me/answerer-name' })).json()).toEqual({ answererName: null, effective: 'Daniel' });
    const put = await app.inject({ method: 'PUT', url: '/api/me/answerer-name', payload: { answererName: 'Dan' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ answererName: 'Dan', effective: 'Dan' });
    expect((await app.inject({ method: 'PUT', url: '/api/me/answerer-name', payload: { answererName: null } })).json()).toEqual({ answererName: null, effective: 'Daniel' });
  });

  it('400 for a missing, non-string, multi-word or too long name', async () => {
    const app = await buildApp('u1');
    for (const payload of [{}, { answererName: 5 }, { answererName: 'Dan Haas' }, { answererName: 'x'.repeat(41) }]) {
      expect((await app.inject({ method: 'PUT', url: '/api/me/answerer-name', payload })).statusCode).toBe(400);
    }
  });

  it('401 signed out, 404 for an unknown user', async () => {
    expect((await (await buildApp(null)).inject({ method: 'GET', url: '/api/me/answerer-name' })).statusCode).toBe(401);
    expect((await (await buildApp('nobody')).inject({ method: 'GET', url: '/api/me/answerer-name' })).statusCode).toBe(404);
  });
});
