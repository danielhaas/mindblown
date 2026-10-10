/**
 * GET /api/maps/:mapId/triage-pipeline (#320): N pending decisions failing
 * with one error fold into one state; a recovered pipeline is "stale", not
 * "broken". Readable with an API key (no model reasoning in the answer);
 * still behind the map-route guard. The route issues three selects in
 * order: newest error rows, newest non-error row, totals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

let errorRows: Array<{ reason: string; decidedAt: Date; decision: string }> = [];
let okRows: Array<{ reason: string; decidedAt: Date; decision: string }> = [];
let totals = { pending: 0, firstError: null as Date | null };
let rowCall = 0;
vi.mock('../../db/connection.js', () => ({
  db: {
    // Dispatch on the selected fields — other hooks in the plugin (the
    // forge-endpoint lookup) select too. Row selects come in order: newest
    // errors, then the newest non-error row.
    select: (fields?: Record<string, unknown>) => {
      const result =
        fields && 'pending' in fields ? [totals] : fields && 'reason' in fields ? (rowCall++ % 2 === 0 ? errorRows : okRows) : [];
      const chain = { orderBy: () => ({ limit: async () => result }), limit: async () => result };
      return { from: () => ({ where: () => Object.assign(Promise.resolve(result), chain) }) };
    },
  },
}));
const getPermission = vi.fn(async (): Promise<string | null> => 'view');
vi.mock('../../db/permissions.js', () => ({
  getPermission: () => getPermission(),
  hasPermission: (actual: string | null) => actual != null,
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { triageRoutes } from '../triage.js';

async function get(opts: { authSource?: 'jwt' | 'api-key'; anonymous?: boolean } = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (!opts.anonymous) req.userId = 'u';
    req.authSource = opts.authSource ?? 'api-key';
  });
  await app.register(triageRoutes);
  const res = await app.inject({ method: 'GET', url: '/api/maps/m1/triage-pipeline' });
  await app.close();
  return res;
}

const creditError = (day: number) => ({
  reason: 'triage_error: 400 {"type":"error","error":{"message":"Your credit balance is too low"}}',
  decidedAt: new Date(Date.UTC(2026, 7, day)),
  decision: 'uncertain',
});

beforeEach(() => {
  rowCall = 0;
  getPermission.mockClear();
  errorRows = Array.from({ length: 6 }, (_, i) => creditError(26 - i));
  okRows = [];
  totals = { pending: 300, firstError: new Date(Date.UTC(2026, 7, 2)) };
});

describe('GET /triage-pipeline (#320)', () => {
  it('broken: one state, cause from the provider error, first date from the totals — with an API key', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ broken: true, stale: false, count: 6, pending: 300, since: '2026-08-02T00:00:00.000Z' });
    expect(res.json().cause).toContain('Your credit balance is too low');
  });

  it('recovered: a successful decision newer than the newest error → stale', async () => {
    okRows = [{ reason: 'Fits under Parser', decidedAt: new Date(Date.UTC(2026, 7, 27)), decision: 'place' }];
    expect((await get()).json()).toMatchObject({ broken: false, stale: true, count: 6 });
  });

  it('a healthy queue is neither', async () => {
    errorRows = [];
    okRows = [{ reason: 'Looks like a bug in the parser', decidedAt: new Date(), decision: 'place' }];
    expect((await get()).json()).toMatchObject({ broken: false, stale: false });
  });

  it('still behind the map guard: anonymous 401, no access 403', async () => {
    expect((await get({ anonymous: true })).statusCode).toBe(401);
    getPermission.mockResolvedValueOnce(null);
    expect((await get()).statusCode).toBe(403);
  });
});
