/**
 * GET /api/maps/:mapId/triage-pipeline (#320): N pending decisions failing
 * with one error fold into one state; healthy maps say so. The row routes'
 * session-only gate does not apply — the response carries no reasoning.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

let rows: Array<{ reason: string; decidedAt: Date; decision: string }> = [];
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }),
  },
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: vi.fn(async () => 'view'),
  hasPermission: (actual: string | null) => actual != null,
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { triageRoutes } from '../triage.js';

async function get(authSource: 'jwt' | 'api-key' = 'api-key') {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'u';
    req.authSource = authSource;
  });
  await app.register(triageRoutes);
  const res = await app.inject({ method: 'GET', url: '/api/maps/m1/triage-pipeline' });
  await app.close();
  return res;
}

describe('GET /triage-pipeline (#320)', () => {
  it('folds identical triage errors into one broken state — readable with an API key', async () => {
    rows = Array.from({ length: 6 }, (_, i) => ({
      reason: 'triage_error: 400 {"type":"error","error":{"message":"Your credit balance is too low"}}',
      decidedAt: new Date(Date.UTC(2026, 7, 21 + i)),
      decision: 'uncertain',
    }));
    const res = await get('api-key');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      broken: true,
      count: 6,
      pending: 6,
      since: '2026-08-21T00:00:00.000Z',
    });
    expect(res.json().cause).toContain('Your credit balance is too low');
  });

  it('a healthy queue is not broken', async () => {
    rows = [{ reason: 'Looks like a bug in the parser', decidedAt: new Date(), decision: 'place' }];
    expect((await get()).json()).toMatchObject({ broken: false, pending: 1 });
  });
});
