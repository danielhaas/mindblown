/**
 * GET /api/fleet/worker-release (claude-fleet #120) — the real auth
 * middleware, the real route and the real service; below them the
 * API-key lookup, the fleet-user check, the map lookup and the forge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

const TIP = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);

const m = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  fleetUsers: new Set<string>(),
  mapForRepo: vi.fn(async (_owner: string, _repo: string): Promise<string | null> => 'map-fleet'),
  commits: [] as Array<{ sha: string }>,
  checks: new Map<string, Array<{ name: string; state: string; url: null }>>(),
  requestJson: vi.fn(),
  listCommitChecks: vi.fn(),
  forgeContext: vi.fn(),
}));

vi.mock('../../lib/apiKeys.js', () => ({
  API_KEY_PREFIX: 'mb_',
  validateApiKey: async (token: string) => (m.keys.has(token) ? { userId: m.keys.get(token)! } : null),
}));
vi.mock('../../db/fleets.js', () => ({ isFleetUser: async (id: string) => m.fleetUsers.has(id) }));
vi.mock('../../db/maps.js', () => ({ findAppBoundMapIdForRepo: m.mapForRepo }));
vi.mock('../../lib/githubContext.js', () => ({ getForgeContextForMap: m.forgeContext }));

import { registerAuthMiddleware } from '../../middleware/auth.js';
import { fleetWorkerReleaseRoutes } from '../fleetWorkerRelease.js';
import { _resetWorkerReleaseCacheForTests } from '../../services/fleetWorkerRelease.js';

const FLEET_KEY = 'mb_fleet';
const PERSON_KEY = 'mb_person';

async function get(auth?: string) {
  const app = Fastify({ logger: false });
  await registerAuthMiddleware(app);
  await app.register(fleetWorkerReleaseRoutes);
  const res = await app.inject({ method: 'GET', url: '/api/fleet/worker-release', headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  await app.close();
  return res;
}

const ok = (name = 'test') => ({ name, state: 'success', url: null });
const bad = (name = 'test') => ({ name, state: 'failure', url: null });

beforeEach(() => {
  _resetWorkerReleaseCacheForTests();
  delete process.env.FLEET_WORKER_REPO;
  m.keys = new Map([[FLEET_KEY, 'fleet-user'], [PERSON_KEY, 'person']]);
  m.fleetUsers = new Set(['fleet-user']);
  m.commits = [{ sha: TIP }, { sha: PARENT }, { sha: OLDER }];
  m.checks = new Map();
  m.mapForRepo.mockClear();
  m.requestJson.mockReset().mockImplementation(async () => m.commits);
  m.listCommitChecks.mockReset().mockImplementation(async (_o: string, _r: string, sha: string) => m.checks.get(sha) ?? []);
  m.forgeContext.mockReset().mockImplementation(async () => ({
    owner: 'danielhaas',
    repo: 'claude-fleet',
    token: 't',
    forge: { requestJson: m.requestJson, listCommitChecks: m.listCommitChecks },
  }));
});
afterEach(() => {
  delete process.env.FLEET_WORKER_REPO;
});

describe('GET /api/fleet/worker-release', () => {
  it('green tip → the tip sha', async () => {
    m.checks.set(TIP, [ok('build'), ok('test')]);
    const res = await get(FLEET_KEY);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ sha: TIP, green: true });
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(m.mapForRepo).toHaveBeenCalledWith('danielhaas', 'claude-fleet');
    expect(m.forgeContext).toHaveBeenCalledWith('map-fleet');
    expect(m.requestJson.mock.calls[0][0]).toMatch(/^\/repos\/danielhaas\/claude-fleet\/commits\?sha=main&per_page=20/);
  });

  it('red tip + green parent → the parent', async () => {
    m.checks.set(TIP, [ok('build'), bad('test')]);
    m.checks.set(PARENT, [ok('build'), ok('test')]);
    const res = await get(FLEET_KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json().sha).toBe(PARENT);
  });

  it('pending or check-less commits are not green; skipped next to a success is', async () => {
    m.checks.set(TIP, [ok(), { name: 'slow', state: 'pending', url: null }]);
    // PARENT has no checks at all
    m.checks.set(OLDER, [ok(), { name: 'deploy', state: 'neutral', url: null }]);
    const res = await get(FLEET_KEY);
    expect(res.json().sha).toBe(OLDER);
  });

  it('none green → 503 with the reason', async () => {
    m.checks.set(TIP, [bad()]);
    const res = await get(FLEET_KEY);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/None of the last 20 commits/);
  });

  it('forge unreachable → 503', async () => {
    m.requestJson.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await get(FLEET_KEY);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/ECONNREFUSED/);
  });

  it('no map bound to the repo → 503', async () => {
    m.mapForRepo.mockResolvedValueOnce(null);
    const res = await get(FLEET_KEY);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/No map is bound/);
  });

  it('FLEET_WORKER_REPO picks the repo', async () => {
    process.env.FLEET_WORKER_REPO = 'acme/worker';
    m.checks.set(TIP, [ok()]);
    await get(FLEET_KEY);
    expect(m.mapForRepo).toHaveBeenCalledWith('acme', 'worker');
  });

  it('caches the answer: a second worker does not hit the forge again', async () => {
    m.checks.set(TIP, [ok()]);
    await get(FLEET_KEY);
    const res = await get(FLEET_KEY);
    expect(res.json().sha).toBe(TIP);
    expect(m.requestJson).toHaveBeenCalledTimes(1);
  });

  it('no key → 401', async () => {
    expect((await get()).statusCode).toBe(401);
    expect(m.requestJson).not.toHaveBeenCalled();
  });

  it('invalid key → 401', async () => {
    expect((await get('mb_nope')).statusCode).toBe(401);
    expect(m.requestJson).not.toHaveBeenCalled();
  });

  it("a person's key → 403", async () => {
    expect((await get(PERSON_KEY)).statusCode).toBe(403);
  });
});
