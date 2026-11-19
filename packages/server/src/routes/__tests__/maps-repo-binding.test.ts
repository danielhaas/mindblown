/**
 * PUT /api/maps/:id { githubInstallationId, githubRepoOwner, githubRepoName }
 * — the binding decides whose repo the map syncs and imports with the App's
 * token. Changing it needs map admin and a repo the caller's own GitHub
 * token reaches in that installation; resending the current binding (a
 * settings form) is not a change.
 *
 * Harness mirrors maps-fleet-connect.test.ts; the db stub answers the
 * service's read of the map's current binding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const updateMapMock = vi.fn();
const state = vi.hoisted(() => ({
  current: { githubInstallationId: null, githubRepoOwner: null, githubRepoName: null, fleetCanEditCi: false } as Record<string, string | boolean | null>,
  /** installationId → repos the caller's token reaches there. */
  reach: new Map<string, string[]>(),
}));

vi.mock('../../db/maps.js', () => ({
  updateMap: (...args: unknown[]) => updateMapMock(...args),
  getMap: vi.fn(),
  listMapsForUser: async () => [],
  createBaseline: vi.fn(),
  deleteMap: vi.fn(),
  createMap: vi.fn(),
}));
const fleetUser = vi.hoisted(() => ({ is: false }));
vi.mock('../../db/fleets.js', () => ({ getFleet: vi.fn(), getMapFleetId: async () => null, listFleetMaps: async () => [], isFleetUser: async () => fleetUser.is }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

const perm = vi.hoisted(() => ({ level: 'admin' as 'view' | 'edit' | 'admin' | null }));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => perm.level,
  hasPermission: (actual: string | null, required: string) => {
    if (actual == null) return false;
    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    return (rank[actual] ?? 0) >= (rank[required] ?? 0);
  },
}));
vi.mock('../../lib/githubInstallations.js', () => ({
  userInstallationRepos: async (_u: string, id: string) => {
    const repos = state.reach.get(id);
    return repos
      ? { repos: repos.map((full_name) => ({ full_name })) }
      : { status: 403, code: 'FORBIDDEN', message: 'That GitHub App installation is not connected to your account' };
  },
}));

vi.mock('../../db/versions.js', () => ({}));
vi.mock('../../db/cycles.js', () => ({}));
vi.mock('../../db/connection.js', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => [state.current] };
  return { db: { select: () => chain } };
});
vi.mock('../../db/schema.js', () => ({ workspaces: {}, users: {}, releaseSnapshots: {}, maps: {} }));
vi.mock('../../lib/releaseForecast.js', () => ({ computeReleaseForecast: vi.fn() }));
vi.mock('../../lib/releaseSnapshots.js', () => ({ snapshotReleaseForecastForMap: vi.fn() }));
vi.mock('../../lib/calendarIcs.js', () => ({
  buildCalendarIcs: vi.fn(),
  calendarTokenFor: vi.fn(),
  verifyCalendarToken: vi.fn(),
  CALENDAR_VIEWS: [],
}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), lte: vi.fn(), desc: vi.fn() }));

import { mapRoutes } from '../maps.js';

const MAP_ID = 'mmmm-mmmm-mmmm-mmmm';
const BIND = { githubInstallationId: '111', githubRepoOwner: 'alice-org', githubRepoName: 'shop' };

async function put(payload: Record<string, unknown>) {
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'u1';
  });
  await app.register(mapRoutes);
  const res = await app.inject({ method: 'PUT', url: `/api/maps/${MAP_ID}`, payload });
  await app.close();
  return res;
}

beforeEach(() => {
  perm.level = 'admin';
  fleetUser.is = false;
  state.current = { githubInstallationId: null, githubRepoOwner: null, githubRepoName: null, fleetCanEditCi: false, createdBy: 'u1' };
  state.reach = new Map([['111', ['Alice-Org/shop']]]);
  updateMapMock.mockReset();
  updateMapMock.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({ id: MAP_ID, name: 'M', ...input }));
});

describe('PUT /api/maps/:id — GitHub repo binding', () => {
  it("binds when the caller is map admin and the installation is theirs", async () => {
    const res = await put(BIND);
    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, BIND, 'u1');
  });

  it('refuses an edit-level member', async () => {
    perm.level = 'edit';
    const res = await put(BIND);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/admin/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it("refuses a map admin binding someone else's installation", async () => {
    state.reach = new Map();
    const res = await put(BIND);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/not connected to your account/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('refuses a repo of the installation that the caller cannot reach', async () => {
    const res = await put({ ...BIND, githubRepoName: 'secret' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/no access to alice-org\/secret/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('refuses a repo with no installation (that path is /connect with a token)', async () => {
    const res = await put({ githubInstallationId: null, githubRepoOwner: 'alice-org', githubRepoName: 'shop' });
    expect(res.statusCode).toBe(400);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it("refuses re-pointing the repo under the current, foreign installation", async () => {
    state.current = { ...BIND };
    state.reach = new Map();
    const res = await put({ githubRepoOwner: 'alice-org', githubRepoName: 'secret' });
    expect(res.statusCode).toBe(403);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('lets an editor resend the binding the map already has', async () => {
    perm.level = 'edit';
    state.current = { ...BIND };
    state.reach = new Map();
    const res = await put({ ...BIND, name: 'Renamed' });
    expect(res.statusCode).toBe(200);
  });

  it('binds a new repo with CI access in one call (the wizard)', async () => {
    const res = await put({ ...BIND, fleetCanEditCi: true });
    expect(res.statusCode).toBe(200);
    expect(updateMapMock).toHaveBeenCalledWith(MAP_ID, { ...BIND, fleetCanEditCi: true }, 'u1');
  });

  it("refuses a co-admin who isn't the map's creator turning CI access on", async () => {
    state.current.createdBy = 'someone-else';
    const res = await put({ fleetCanEditCi: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/creator/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('lets any map admin turn CI access off, but not an editor', async () => {
    state.current = { ...BIND, fleetCanEditCi: true, createdBy: 'someone-else' };
    expect((await put({ fleetCanEditCi: false })).statusCode).toBe(200);
    perm.level = 'edit';
    expect((await put({ fleetCanEditCi: false })).statusCode).toBe(403);
  });

  it('lets an editor resend "off", but checks "on" every time', async () => {
    perm.level = 'edit';
    expect((await put({ fleetCanEditCi: false, name: 'Renamed' })).statusCode).toBe(200);
    state.current = { ...BIND, fleetCanEditCi: true, createdBy: 'someone-else' };
    expect((await put({ fleetCanEditCi: true })).statusCode).toBe(403);
  });

  it('refuses a fleet key, even with admin on the map', async () => {
    fleetUser.is = true;
    const res = await put({ fleetCanEditCi: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/fleet key/);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('refuses a non-boolean CI setting', async () => {
    const res = await put({ fleetCanEditCi: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(updateMapMock).not.toHaveBeenCalled();
  });

  it('lets a map admin disconnect the repo', async () => {
    state.current = { ...BIND };
    state.reach = new Map();
    const res = await put({ githubInstallationId: null, githubRepoOwner: null, githubRepoName: null });
    expect(res.statusCode).toBe(200);
  });
});
