/**
 * Trust policy (#491) through the map routes: GET /trust-policy and the
 * `trustPolicy` field on PUT /api/maps/:id are admin-only, the policy is
 * validated before anything is written, and the saved policy is echoed to
 * the caller but never broadcast.
 *
 * Mock pattern: maps-holidays.test.ts. The admin gate and the validation
 * (checkTrustPolicyInput / parseTrustPolicy) are real; the service's DB
 * reads and writes are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { defaultTrustPolicy, type TrustPolicy } from '@mindblown/core';

const updateMapMock = vi.fn();
const broadcastMock = vi.fn();
const getTrustPolicyMock = vi.fn();
const setTrustPolicyMock = vi.fn();
let permission: 'view' | 'edit' | 'admin' = 'admin';

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: vi.fn(),
  listMapsForUser: async () => [],
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
vi.mock('../../db/permissions.js', () => {
  const rank = { view: 1, edit: 2, admin: 3 } as const;
  return {
    getPermission: async () => permission,
    hasPermission: (actual: keyof typeof rank | null, required: keyof typeof rank) =>
      actual !== null && rank[actual] >= rank[required],
  };
});
vi.mock('../../services/trustPolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/trustPolicy.js')>();
  return {
    ...actual,
    getTrustPolicy: (...args: unknown[]) => getTrustPolicyMock(...args),
    setTrustPolicy: (...args: unknown[]) => setTrustPolicyMock(...args),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: (...args: unknown[]) => broadcastMock(...args) }));
vi.mock('../../db/versions.js', () => ({}));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../lib/releaseForecast.js', () => ({ computeReleaseForecast: vi.fn() }));
vi.mock('../../lib/releaseSnapshots.js', () => ({ snapshotReleaseForecastForMap: vi.fn() }));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));

import { mapRoutes } from '../maps.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const POLICY: TrustPolicy = {
  trustedUserIds: ['uuuu'],
  trustedForgeLogins: ['octocat'],
  levels: { known: { dispatch: 'auto', merge: 'pr-only' }, external: { dispatch: 'approval', merge: 'pr-only' } },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'uuuu';
    req.authSource = 'jwt';
  });
  await app.register(mapRoutes);
  return app;
}

beforeEach(() => {
  permission = 'admin';
  updateMapMock.mockReset();
  broadcastMock.mockReset();
  getTrustPolicyMock.mockReset();
  setTrustPolicyMock.mockReset();
  updateMapMock.mockResolvedValue({ id: MAP_ID, name: 'M' });
});

describe('GET /api/maps/:id/trust-policy', () => {
  it('returns the policy in force to an admin', async () => {
    const result = { policy: defaultTrustPolicy('uuuu', ['octocat']), isDefault: true };
    getTrustPolicyMock.mockResolvedValueOnce(result);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/trust-policy` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
    expect(getTrustPolicyMock).toHaveBeenCalledWith(MAP_ID);
  });

  it('is refused below admin', async () => {
    permission = 'edit';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/maps/${MAP_ID}/trust-policy` });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(getTrustPolicyMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/maps/:id — trustPolicy', () => {
  it('saves it for an admin and echoes it, without broadcasting it', async () => {
    setTrustPolicyMock.mockResolvedValueOnce({ policy: POLICY, isDefault: false });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { trustPolicy: { ...POLICY, trustedForgeLogins: [' octocat ', 'octocat'] } },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(setTrustPolicyMock).toHaveBeenCalledWith(MAP_ID, POLICY, 'uuuu');
    expect(res.json().trustPolicy).toEqual(POLICY);
    expect(broadcastMock.mock.calls[0][1].map).not.toHaveProperty('trustPolicy');
  });

  it('null goes back to the defaults', async () => {
    setTrustPolicyMock.mockResolvedValueOnce({ policy: defaultTrustPolicy('uuuu'), isDefault: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { trustPolicy: null } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(setTrustPolicyMock).toHaveBeenCalledWith(MAP_ID, null, 'uuuu');
  });

  it('an editor may not change it — and nothing else in the request is written', async () => {
    permission = 'edit';
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { name: 'renamed', trustPolicy: POLICY },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
    expect(setTrustPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed policy with 400', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/maps/${MAP_ID}`,
      payload: { trustPolicy: { ...POLICY, levels: { ...POLICY.levels, external: { dispatch: 'auto', merge: 'deploy' } } } },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/external\.merge/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('a map update without the field leaves the policy alone', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload: { name: 'renamed' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('trustPolicy');
    expect(setTrustPolicyMock).not.toHaveBeenCalled();
  });
});
