/**
 * Personal leave (#664): GET/POST/DELETE /api/me/leave on the real routes,
 * db/leave and the fleet-user probe mocked below them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

type Row = { id: string; userId: string; startDate: string; endDate: string; note: string | null; createdAt: string };
const state = vi.hoisted(() => ({ rows: [] as Row[], fleetUsers: new Set<string>() }));
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../db/leave.js', () => ({
  listLeave: async (u: string) => state.rows.filter((r) => r.userId === u),
  addLeave: vi.fn(async (u: string, input: { startDate: string; endDate: string; note: string | null }) => {
    const r = { id: ID, userId: u, ...input, createdAt: '2026-11-19T00:00:00Z' };
    state.rows.push(r);
    return r;
  }),
  removeLeave: async (u: string, id: string) => {
    const i = state.rows.findIndex((r) => r.id === id && r.userId === u);
    if (i < 0) return false;
    state.rows.splice(i, 1);
    return true;
  },
}));
vi.mock('../../db/fleets.js', () => ({ isFleetUser: async (u: string) => state.fleetUsers.has(u) }));

import { leaveRoutes } from '../leave.js';

async function buildApp(userId: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (userId) req.userId = userId;
  });
  await app.register(leaveRoutes);
  return app;
}

beforeEach(() => {
  state.rows.length = 0;
  state.fleetUsers.clear();
});

describe('/api/me/leave', () => {
  it('adds, lists and removes your own leave', async () => {
    const app = await buildApp('u1');
    const add = await app.inject({ method: 'POST', url: '/api/me/leave', payload: { startDate: '2026-12-21', endDate: '2027-01-04', note: 'Christmas' } });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ id: ID, startDate: '2026-12-21', endDate: '2027-01-04', note: 'Christmas' });
    expect((await app.inject({ method: 'GET', url: '/api/me/leave' })).json().leave).toHaveLength(1);
    // Someone else cannot remove it.
    expect((await (await buildApp('u2')).inject({ method: 'DELETE', url: `/api/me/leave/${ID}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/me/leave/${ID}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me/leave' })).json().leave).toEqual([]);
  });

  it('400 for bad dates or an end before the start', async () => {
    const app = await buildApp('u1');
    for (const payload of [{ startDate: '21.12.2026', endDate: '2027-01-04' }, { startDate: '2027-01-04', endDate: '2026-12-21' }, {}]) {
      expect((await app.inject({ method: 'POST', url: '/api/me/leave', payload })).statusCode).toBe(400);
    }
    expect(state.rows).toEqual([]);
  });

  it('401 signed out, 403 for a fleet user', async () => {
    expect((await (await buildApp(null)).inject({ method: 'GET', url: '/api/me/leave' })).statusCode).toBe(401);
    state.fleetUsers.add('fleet');
    const res = await (await buildApp('fleet')).inject({ method: 'POST', url: '/api/me/leave', payload: { startDate: '2026-12-21', endDate: '2026-12-22' } });
    expect(res.statusCode).toBe(403);
  });
});
