/**
 * Behavior tests for the two password write paths:
 *
 *   POST /api/auth/change-password   — self-serve, needs the current password
 *   POST /api/system/reset-password  — admin-only, mints a temp password
 *
 * The DB is a chain-shaped stub (select→from→where→limit, update→set→where)
 * with a per-test queue of select results, so both the routes' own lookups
 * and requireAdmin's is_admin probe run against controlled rows. Hashing is
 * the real scrypt implementation — the assertions round-trip the stored hash
 * through verifyPassword.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── DB stub ───────────────────────────────────────────────────────
let selectQueue: unknown[][] = [];
let updateSetCalls: Record<string, unknown>[] = [];

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectQueue.shift() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updateSetCalls.push(values);
        },
      }),
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({ users: {}, pendingInvites: {} }));
vi.mock('../../db/permissions.js', () => ({
  resolvePendingInvites: vi.fn(async () => 0),
}));
vi.mock('../../db/settings.js', () => ({
  getRegistrationPolicy: vi.fn(async () => ({ mode: 'open', allowlist: [] })),
  setRegistrationPolicy: vi.fn(async (p: unknown) => p),
  getAiProviderSettings: vi.fn(async () => ({ preference: 'auto' })),
  setAiProviderSettings: vi.fn(async (s: unknown) => s),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), sql: vi.fn() }));

import { authRoutes, hashPassword, verifyPassword, isTokenRevoked, _resetRevocationCacheForTests } from '../../auth.js';
import { systemRoutes } from '../system.js';

const UID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** `long-lived` = a headless JWT: authSource 'jwt' but actor 'agent' (#315). */
async function buildApp(authSource: 'jwt' | 'api-key' | 'long-lived' | 'none'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    if (authSource === 'none') return;
    req.userId = UID;
    req.authSource = authSource === 'long-lived' ? 'jwt' : authSource;
    req.actor = authSource === 'jwt' ? 'person' : 'agent';
  });
  await app.register(authRoutes);
  await app.register(systemRoutes);
  return app;
}

beforeEach(() => {
  selectQueue = [];
  updateSetCalls = [];
  _resetRevocationCacheForTests();
});

// ── POST /api/auth/change-password ───────────────────────────────

describe('POST /api/auth/change-password', () => {
  it('401 when unauthenticated', async () => {
    const app = await buildApp('none');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'a', newPassword: 'bbbbbbbb' },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it('403 for api-key auth even with valid credentials', async () => {
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'a', newPassword: 'bbbbbbbb' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(updateSetCalls).toHaveLength(0);
  });

  it('400 when fields are missing', async () => {
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'a' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('400 when the new password is under 8 characters', async () => {
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'old-pass', newPassword: 'short' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(updateSetCalls).toHaveLength(0);
  });

  it('401 when the current password is wrong, and does not write', async () => {
    selectQueue = [[{ id: UID, passwordHash: await hashPassword('right-password') }]];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'wrong-password', newPassword: 'new-password-1' },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe('INVALID_CREDENTIALS');
    expect(updateSetCalls).toHaveLength(0);
  });

  it('200 on success: new hash stored, change time recorded, fresh session token returned', async () => {
    selectQueue = [[{ id: UID, email: 'me@example.com', passwordHash: await hashPassword('old-password') }]];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'old-password', newPassword: 'new-password-1' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');
    expect(updateSetCalls).toHaveLength(2);
    const stored = updateSetCalls[0].passwordHash as string;
    expect(await verifyPassword('new-password-1', stored)).toBe(true);
    expect(await verifyPassword('old-password', stored)).toBe(false);
    expect(updateSetCalls[1].passwordChangedAt).toBeInstanceOf(Date);
  });

  it('403 for a long-lived token (a JWT, but a robot) — #315', async () => {
    const app = await buildApp('long-lived');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'old-password', newPassword: 'new-password-1' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(updateSetCalls).toHaveLength(0);
  });

  it('400 instead of 500 when the body is missing', async () => {
    const app = await buildApp('jwt');
    const res = await app.inject({ method: 'POST', url: '/api/auth/change-password' });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/long-lived-token (#315)', () => {
  it('403 for a long-lived token — it cannot renew itself', async () => {
    const app = await buildApp('long-lived');
    const res = await app.inject({ method: 'POST', url: '/api/auth/long-lived-token' });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it('200 for a web session', async () => {
    selectQueue = [[{ id: UID, email: 'me@example.com' }]];
    const app = await buildApp('jwt');
    const res = await app.inject({ method: 'POST', url: '/api/auth/long-lived-token' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');
  });
});

describe('POST /api/auth/register password length', () => {
  it('400 for a password under 8 characters', async () => {
    const app = await buildApp('none');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'new@example.com', password: 'short', name: 'N' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe('isTokenRevoked (#315)', () => {
  it('a token issued before the last password change is revoked; one issued after is not', async () => {
    const changed = new Date('2026-10-10T04:00:00Z');
    selectQueue = [[{ changedAt: changed }]];
    const cut = Math.floor(changed.getTime() / 1000);
    expect(await isTokenRevoked(UID, cut - 60)).toBe(true);
    expect(await isTokenRevoked(UID, cut)).toBe(false); // cached — no second lookup
    expect(selectQueue).toHaveLength(0);
  });

  it('a user who never changed the password keeps every token', async () => {
    selectQueue = [[{ changedAt: null }]];
    expect(await isTokenRevoked(UID, 1)).toBe(false);
  });
});

// ── POST /api/system/reset-password ──────────────────────────────

describe('POST /api/system/reset-password', () => {
  it('403 for a non-admin JWT user', async () => {
    selectQueue = [[{ isAdmin: false }]]; // requireAdmin's probe
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'marcel@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(updateSetCalls).toHaveLength(0);
  });

  it('403 for api-key auth even when the user is an admin', async () => {
    // requireAdmin short-circuits on authSource before its DB probe.
    const app = await buildApp('api-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'marcel@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(selectQueue).toHaveLength(0);
  });

  it('400 when email is missing', async () => {
    selectQueue = [[{ isAdmin: true }]];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('404 when no user has that email', async () => {
    selectQueue = [[{ isAdmin: true }], []];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'nobody@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('USER_NOT_FOUND');
    expect(updateSetCalls).toHaveLength(0);
  });

  it('200 returns a temp password whose hash was stored', async () => {
    selectQueue = [
      [{ isAdmin: true }],
      [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'marcel@example.com' }],
    ];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'marcel@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { email: string; tempPassword: string };
    expect(body.email).toBe('marcel@example.com');
    expect(body.tempPassword).toMatch(/^mb-/);
    expect(body.tempPassword.length).toBeGreaterThanOrEqual(12);
    expect(updateSetCalls).toHaveLength(2);
    const stored = updateSetCalls[0].passwordHash as string;
    expect(await verifyPassword(body.tempPassword, stored)).toBe(true);
    // The user's sessions and long-lived tokens end with the reset (#315).
    expect(updateSetCalls[1].passwordChangedAt).toBeInstanceOf(Date);
  });

  it('409 when two accounts differ only in email case — never resets a random one', async () => {
    selectQueue = [
      [{ isAdmin: true }],
      [
        { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'Marcel@example.com' },
        { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'marcel@example.com' },
      ],
    ];
    const app = await buildApp('jwt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'MARCEL@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(409);
    expect(updateSetCalls).toHaveLength(0);
  });

  it('403 for an admin\'s long-lived token — admin actions need a web session (#315)', async () => {
    const app = await buildApp('long-lived');
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/reset-password',
      payload: { email: 'marcel@example.com' },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(selectQueue).toHaveLength(0);
  });
});
