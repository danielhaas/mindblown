/**
 * GET /api/version — the real auth middleware and the real route; the
 * service (git at startup) stubbed. What the route owns: no auth, the
 * shape the deploy probe parses, 503 without a checkout, no caching.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { parseProbeBody } from '@mindblown/core';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const svc = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('../../services/buildInfo.js', () => ({ buildInfo: () => svc.info() }));

import { registerAuthMiddleware } from '../../middleware/auth.js';
import { buildInfoRoutes } from '../buildInfo.js';

async function get(url = '/api/version') {
  const app = Fastify({ logger: false });
  await registerAuthMiddleware(app);
  await app.register(buildInfoRoutes);
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res;
}

beforeEach(() => {
  svc.info.mockReset();
  svc.info.mockResolvedValue({ commit: SHA, builtAt: '2026-11-19T08:00:00.000Z' });
});

describe('GET /api/version', () => {
  it('answers without a login: the running commit and when it was loaded', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ commit: SHA, builtAt: '2026-11-19T08:00:00.000Z' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is what a deploy probe reads', async () => {
    expect(parseProbeBody((await get()).body)).toBe(SHA);
  });

  it('a query string does not change it (still public)', async () => {
    expect((await get('/api/version?x=1')).statusCode).toBe(200);
  });

  it('no git checkout → 503 with commit null, never a made-up sha', async () => {
    svc.info.mockResolvedValue({ commit: null, builtAt: '2026-11-19T08:00:00.000Z' });
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ commit: null });
    expect(parseProbeBody(res.body)).toBeNull();
  });

  it('a stale or bad token does not turn it into a 401', async () => {
    const app = Fastify({ logger: false });
    await registerAuthMiddleware(app);
    await app.register(buildInfoRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/version', headers: { authorization: 'Bearer not-a-jwt' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().commit).toBe(SHA);
  });
});
