/**
 * Unit tests for `requireAdmin` (closes #69).
 *
 * The helper gates every admin-only HTTP route in the server (registration
 * policy writes, AI-provider writes, drift-audit sweep). Three invariants:
 *
 *   1. If `req.userId` is missing                         → false
 *   2. If `req.authSource === 'api-key'`                  → false (even for
 *      a user whose `is_admin = true`; closes #69)
 *   3. Otherwise return whatever the DB says about `is_admin`
 *
 * The DB layer is mocked so this test runs without Postgres — `requireAdmin`
 * is a single select-by-id on the users table, so the surface is small enough
 * to mock at the drizzle layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle BEFORE importing the module under test. Vitest hoists vi.mock,
// but we keep the conventional ordering for readability.
const isAdminByUserId = new Map<string, boolean>();

vi.mock('../db/connection.js', () => {
  // Minimal chainable mock matching `db.select({...}).from(users).where(eq(...)).limit(1)`.
  // The where-clause is captured by intercepting `eq(users.id, X)` below.
  let pendingUserId: string | null = null;
  return {
    db: {
      select() {
        return {
          from() {
            return {
              where(predicate: { __userId: string }) {
                pendingUserId = predicate.__userId;
                return {
                  async limit(_n: number) {
                    const uid = pendingUserId;
                    pendingUserId = null;
                    if (uid == null) return [];
                    if (!isAdminByUserId.has(uid)) return [];
                    return [{ isAdmin: isAdminByUserId.get(uid)! }];
                  },
                };
              },
            };
          },
        };
      },
    },
  };
});

vi.mock('../db/schema.js', () => ({
  users: { id: '__user_id_col' },
  pendingInvites: {},
}));

vi.mock('drizzle-orm', () => ({
  // Capture the user id from `eq(users.id, X)` so the mock connection can
  // route the lookup.
  eq: (_col: unknown, value: string) => ({ __userId: value }),
}));

vi.mock('../db/permissions.js', () => ({
  resolvePendingInvites: vi.fn(),
}));

vi.mock('../db/settings.js', () => ({
  getRegistrationPolicy: vi.fn(),
}));

import { requireAdmin } from '../auth.js';

beforeEach(() => {
  isAdminByUserId.clear();
});

describe('requireAdmin', () => {
  it('returns false when userId is missing', async () => {
    expect(await requireAdmin({})).toBe(false);
    expect(await requireAdmin({ authSource: 'jwt' })).toBe(false);
    expect(await requireAdmin({ userId: undefined, authSource: 'jwt' })).toBe(false);
  });

  it('returns false when authSource is api-key, even if user is admin', async () => {
    // Closes #69: an admin's API key must not be able to reach admin endpoints.
    isAdminByUserId.set('admin-uid', true);
    expect(
      await requireAdmin({ userId: 'admin-uid', authSource: 'api-key' }),
    ).toBe(false);
  });

  it('returns false when authSource is api-key for a non-admin user too', async () => {
    isAdminByUserId.set('user-uid', false);
    expect(
      await requireAdmin({ userId: 'user-uid', authSource: 'api-key' }),
    ).toBe(false);
  });

  it('returns true when authSource is jwt and user is admin', async () => {
    isAdminByUserId.set('admin-uid', true);
    expect(
      await requireAdmin({ userId: 'admin-uid', authSource: 'jwt' }),
    ).toBe(true);
  });

  it('returns false when authSource is jwt but user is not admin', async () => {
    isAdminByUserId.set('user-uid', false);
    expect(
      await requireAdmin({ userId: 'user-uid', authSource: 'jwt' }),
    ).toBe(false);
  });

  it('returns false when authSource is jwt but user is unknown to the DB', async () => {
    // No entry in isAdminByUserId → mock returns [] → row is undefined.
    expect(
      await requireAdmin({ userId: 'ghost-uid', authSource: 'jwt' }),
    ).toBe(false);
  });

  it('treats a missing authSource the same as jwt (legacy: still hits the DB)', async () => {
    // Some callers / tests may not set authSource. Behaviour: only api-key is
    // a hard block; absent/jwt both proceed to the is_admin DB check.
    isAdminByUserId.set('admin-uid', true);
    expect(await requireAdmin({ userId: 'admin-uid' })).toBe(true);
  });
});
