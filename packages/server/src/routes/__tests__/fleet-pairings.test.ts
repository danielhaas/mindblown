/**
 * Pairing a machine (#506). The pairing store runs in memory; fleets,
 * keys and ownership are stubbed. The assertions are the rules: the
 * machine registers without a credential, only a signed-in person
 * confirms, a code works once and for 10 minutes, wrong guesses are
 * limited, the key is handed out once, and re-pairing replaces the
 * fleet's keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const OWNER = 'owner-user';
const OTHER = 'other-user';
const FLEET_ID = '11111111-2222-4333-8444-555555555555';
const NEW_FLEET = '99999999-2222-4333-8444-555555555555';

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ rows: [] as Row[], n: 0 }));
const fleets = vi.hoisted(() => ({
  created: [] as Array<{ name: string; ownerId: string; maxActiveClaims?: number }>,
  keys: [] as Array<{ id: string; userId: string; revokedAt: Date | null }>,
  fleetUsers: new Set<string>(),
}));

vi.mock('../../db/fleetPairings.js', () => {
  const open = (r: Row, now: Date) => !r.confirmedAt && r.expiresAt > now;
  return {
    insertPairing: async (input: Row) => {
      if (store.rows.some((r) => r.codeHash === input.codeHash)) return null;
      const row = {
        ...input,
        id: `00000000-0000-4000-8000-${String(++store.n).padStart(12, '0')}`,
        confirmedAt: null,
        confirmedBy: null,
        fleetId: null,
        replaceKeys: false,
        collectedAt: null,
        createdAt: new Date(input.expiresAt.getTime() - 10 * 60 * 1000),
      };
      store.rows.push(row);
      return row;
    },
    prunePairings: async (now: Date) => {
      store.rows = store.rows.filter((r) => r.confirmedAt || r.expiresAt >= now);
    },
    countPendingPairings: async (now: Date) => store.rows.filter((r) => open(r, now)).length,
    findPairingByCode: async (h: string) => store.rows.find((r) => r.codeHash === h) ?? null,
    unmarkCollected: async (id: string) => {
      store.rows.find((r) => r.id === id)!.collectedAt = null;
    },
    getPairing: async (id: string) => store.rows.find((r) => r.id === id) ?? null,
    claimPairing: async (h: string, userId: string, fleetId: string | null, replaceKeys: boolean, now: Date) => {
      const r = store.rows.find((x) => x.codeHash === h && open(x, now));
      if (!r) return null;
      Object.assign(r, { confirmedAt: now, confirmedBy: userId, fleetId, replaceKeys });
      return r;
    },
    setPairingFleet: async (id: string, fleetId: string) => {
      store.rows.find((r) => r.id === id)!.fleetId = fleetId;
    },
    releasePairing: async (id: string) => {
      Object.assign(store.rows.find((r) => r.id === id)!, { confirmedAt: null, confirmedBy: null, fleetId: null });
    },
    getUserName: async (id: string) => (id === OWNER ? 'Owner' : null),
    markCollected: async (id: string, now: Date) => {
      const r = store.rows.find((x) => x.id === id);
      if (!r || r.collectedAt) return false;
      r.collectedAt = now;
      return true;
    },
  };
});
vi.mock('../../db/fleets.js', () => ({
  isFleetUser: async (id: string) => fleets.fleetUsers.has(id),
  createFleet: async (input: { name: string; ownerId: string; maxActiveClaims?: number }) => {
    fleets.created.push(input);
    return { id: NEW_FLEET, name: input.name, ownerId: input.ownerId, maxActiveClaims: input.maxActiveClaims ?? 0 };
  },
  getFleet: async (id: string) =>
    id === FLEET_ID ? { id, name: 'big-blower', ownerId: OWNER } : id === NEW_FLEET ? { id, name: fleets.created.at(-1)?.name, ownerId: OWNER } : null,
  getServiceUserId: async (id: string) => `svc-${id}`,
}));
vi.mock('../../services/fleets.js', () => ({
  requireFleetOwner: async (userId: string, fleetId: string) =>
    fleetId === FLEET_ID && userId === OWNER
      ? { id: FLEET_ID, name: 'big-blower', ownerId: OWNER }
      : fleetId === FLEET_ID
        ? { status: 403, code: 'FORBIDDEN', message: "Only the fleet's owner can change it" }
        : { status: 404, code: 'FLEET_NOT_FOUND', message: 'Fleet not found' },
}));
const failNextKey = vi.hoisted(() => ({ on: false }));
vi.mock('../../lib/apiKeys.js', () => ({
  createApiKey: async (userId: string) => {
    if (failNextKey.on) {
      failNextKey.on = false;
      throw new Error('db down');
    }
    const id = `key-${fleets.keys.length + 1}`;
    fleets.keys.push({ id, userId, revokedAt: null });
    return { id, name: 'k', key: `mb_secret_${id}`, prefix: `mb_${id}`, createdAt: new Date(), expiresAt: null };
  },
  listApiKeysForUser: async (userId: string) => fleets.keys.filter((k) => k.userId === userId),
  revokeApiKey: async (userId: string, id: string) => {
    const k = fleets.keys.find((x) => x.id === id && x.userId === userId && !x.revokedAt);
    if (!k) return false;
    k.revokedAt = new Date();
    return true;
  },
}));

import { fleetPairingRoutes } from '../fleetPairings.js';
import { _resetPairingLimitsForTests, normalizeCode } from '../../services/fleetPairing.js';

let app: FastifyInstance;
async function call(userId: string | null, url: string, payload?: unknown, authSource: 'jwt' | 'api-key' = 'jwt') {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: (payload ?? {}) as object,
    headers: userId ? { 'x-test-user': userId, 'x-test-auth': authSource } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function register(hostname = 'big-blower', extra: Record<string, unknown> = {}) {
  const r = await call(null, '/api/fleet-pairings', { hostname, agent: 'qwen-code', slots: 2, ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string; secret: string };
}

beforeEach(async () => {
  store.rows = [];
  store.n = 0;
  fleets.created = [];
  fleets.keys = [];
  fleets.fleetUsers = new Set();
  _resetPairingLimitsForTests();
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const u = req.headers['x-test-user'];
    if (typeof u === 'string') {
      (req as any).userId = u;
      (req as any).authSource = req.headers['x-test-auth'];
    }
  });
  await app.register(fleetPairingRoutes);
});

describe('fleet pairing (#506)', () => {
  it('a machine registers without a credential and gets a readable code', async () => {
    const r = await register();
    expect(r.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(r.secret.length).toBeGreaterThan(30);
    // Only hashes are stored.
    expect(JSON.stringify(store.rows)).not.toContain(r.secret);
    expect(JSON.stringify(store.rows)).not.toContain(normalizeCode(r.code));
  });

  it('rejects a bad hostname or slot count', async () => {
    expect((await call(null, '/api/fleet-pairings', { hostname: 'rm -rf /' })).status).toBe(400);
    expect((await call(null, '/api/fleet-pairings', { hostname: 'ok', slots: 0 })).status).toBe(400);
    expect((await call(null, '/api/fleet-pairings', {})).status).toBe(400);
  });

  it('pending until confirmed; then a new fleet named after the host, cap = slots, key handed out once', async () => {
    const m = await register();
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(202);

    const look = await call(OWNER, '/api/fleet-pairings/lookup', { code: m.code.toLowerCase().replace('-', ' ') });
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ hostname: 'big-blower', agent: 'qwen-code', slots: 2 });

    const ok = await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ fleetId: NEW_FLEET, fleetName: 'big-blower', created: true });
    expect(fleets.created).toEqual([{ name: 'big-blower', ownerId: OWNER, maxActiveClaims: 2 }]);

    const got = await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'paired', fleetId: NEW_FLEET, fleetName: 'big-blower', ownerName: 'Owner' });
    expect(got.body.key).toMatch(/^mb_/);

    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(410);
    expect(fleets.keys).toHaveLength(1);
  });

  it('a wrong secret or unknown id reads like an expired pairing', async () => {
    const m = await register();
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: 'nope' })).status).toBe(404);
    expect((await call(null, `/api/fleet-pairings/not-a-uuid/collect`, { secret: m.secret })).status).toBe(404);
  });

  it('only a signed-in person confirms — not an API key, not anonymous', async () => {
    const m = await register();
    expect((await call(null, '/api/fleet-pairings/confirm', { code: m.code })).status).toBe(401);
    expect((await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code }, 'api-key')).status).toBe(403);
    expect((await call(OWNER, '/api/fleet-pairings/lookup', { code: m.code }, 'api-key')).status).toBe(403);
  });

  it('a code works once — and a second person is told it was taken, not "wrong code"', async () => {
    const m = await register();
    expect((await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code })).status).toBe(200);
    const again = await call(OTHER, '/api/fleet-pairings/confirm', { code: m.code });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAIRING_ALREADY_CONFIRMED');
  });

  it('a failed key handout leaves the pairing collectable', async () => {
    const m = await register();
    await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code });
    failNextKey.on = true;
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(500);
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(200);
  });

  it('an expired code is refused', async () => {
    const m = await register();
    store.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect((await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code })).status).toBe(404);
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(404);
  });

  it('wrong guesses are limited per user', async () => {
    const m = await register();
    for (let i = 0; i < 10; i++) {
      expect((await call(OTHER, '/api/fleet-pairings/lookup', { code: 'AAAA-AAAA' })).status).toBe(404);
    }
    // Even the right code is refused now — for this user only.
    expect((await call(OTHER, '/api/fleet-pairings/lookup', { code: m.code })).status).toBe(429);
    expect((await call(OWNER, '/api/fleet-pairings/lookup', { code: m.code })).status).toBe(200);
  });

  it('pairing into a fleet you own adds a key by default', async () => {
    fleets.keys.push({ id: 'old-key', userId: `svc-${FLEET_ID}`, revokedAt: null });
    const m = await register();
    expect((await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code, fleetId: FLEET_ID })).status).toBe(200);
    expect((await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret })).status).toBe(200);
    expect(fleets.keys.filter((k) => !k.revokedAt)).toHaveLength(2);
  });

  it('re-pair with replaceKeys: the old keys go when the machine collects', async () => {
    fleets.keys.push({ id: 'old-key', userId: `svc-${FLEET_ID}`, revokedAt: null });
    const m = await register();
    const ok = await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code, fleetId: FLEET_ID, replaceKeys: true });
    expect(ok.body).toMatchObject({ fleetId: FLEET_ID, created: false });
    expect(fleets.created).toHaveLength(0);
    expect(fleets.keys[0].revokedAt).toBeNull();
    const got = await call(null, `/api/fleet-pairings/${m.id}/collect`, { secret: m.secret });
    expect(got.body).toMatchObject({ status: 'paired', fleetId: FLEET_ID });
    expect(fleets.keys.find((k) => k.id === 'old-key')!.revokedAt).not.toBeNull();
    expect(fleets.keys.filter((k) => !k.revokedAt)).toHaveLength(1);
  });

  it("can't pair into someone else's fleet, and the code stays open", async () => {
    const m = await register();
    expect((await call(OTHER, '/api/fleet-pairings/confirm', { code: m.code, fleetId: FLEET_ID })).status).toBe(403);
    expect((await call(OWNER, '/api/fleet-pairings/confirm', { code: m.code })).status).toBe(200);
  });

  it('caps open registrations', async () => {
    for (let i = 0; i < 20; i++) await register(`host-${i}`);
    expect((await call(null, '/api/fleet-pairings', { hostname: 'one-more' })).status).toBe(429);
  });
});
