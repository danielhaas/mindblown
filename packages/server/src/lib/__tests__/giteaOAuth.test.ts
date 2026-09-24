/**
 * The refresh invariants of `giteaAccessTokenFor` (#369):
 *   - a fresh token is returned without touching Gitea;
 *   - an expiring token is refreshed ONCE even for concurrent callers
 *     (Gitea rotates refresh tokens — a second refresh with the old one fails);
 *   - the new pair is stored BEFORE the token is handed out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
  identityRow: null as object | null,
}));

vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<typeof import('@mindblown/integrations')>('@mindblown/integrations');
  return { ...actual, refreshGiteaAccessToken: mocks.refresh };
});
vi.mock('../../crypto.js', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('../../db/schema.js', () => ({
  userGithubIdentities: { id: 'id', userId: 'user_id', kind: 'kind', githubLogin: 'l', encryptedAccessToken: 'a', encryptedRefreshToken: 'r', tokenExpiresAt: 't' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (mocks.identityRow ? [mocks.identityRow] : []) }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.updates.push(values);
        },
      }),
    }),
  },
}));

import { giteaAccessTokenFor, type GiteaIdentityRow } from '../giteaOAuth.js';

function identity(expiresInMs: number): GiteaIdentityRow {
  return {
    id: 'ident-1',
    userId: 'u1',
    githubLogin: 'dan',
    encryptedAccessToken: 'enc(old-access)',
    encryptedRefreshToken: 'enc(old-refresh)',
    tokenExpiresAt: new Date(Date.now() + expiresInMs),
  };
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.updates.length = 0;
  process.env.GITEA_URL = 'https://git.example';
  process.env.GITEA_OAUTH_CLIENT_ID = 'cid';
  process.env.GITEA_OAUTH_CLIENT_SECRET = 'cs';
  process.env.PUBLIC_URL = 'https://mb.example';
});

describe('giteaAccessTokenFor', () => {
  it('returns the stored token while it is fresh, without refreshing', async () => {
    const row = identity(3_600_000);
    mocks.identityRow = row;
    expect(await giteaAccessTokenFor(row)).toBe('old-access');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(0);
  });

  it('refreshes inside the 60 s skew, stores the new pair BEFORE returning, and rotates the refresh token', async () => {
    const row = identity(30_000);
    mocks.identityRow = row;
    let storedAtReturn: Record<string, unknown> | undefined;
    mocks.refresh.mockImplementation(async (_app: unknown, refreshToken: string) => {
      expect(refreshToken).toBe('old-refresh');
      return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, tokenType: 'bearer', scope: null };
    });
    const token = await giteaAccessTokenFor(row);
    storedAtReturn = mocks.updates[0];
    expect(token).toBe('new-access');
    expect(storedAtReturn).toMatchObject({ encryptedAccessToken: 'enc(new-access)', encryptedRefreshToken: 'enc(new-refresh)' });
    expect((storedAtReturn!.tokenExpiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('serialises concurrent refreshes of one identity: Gitea is asked once, both callers get the new token', async () => {
    const row = identity(0);
    mocks.identityRow = row;
    let resolveRefresh!: (v: unknown) => void;
    mocks.refresh.mockImplementation(() => new Promise((res) => { resolveRefresh = res; }));
    const a = giteaAccessTokenFor(row);
    const b = giteaAccessTokenFor({ ...row });
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    resolveRefresh({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, tokenType: 'bearer', scope: null });
    expect(await Promise.all([a, b])).toEqual(['new-access', 'new-access']);
    expect(mocks.updates).toHaveLength(1);
  });

  it('skips the refresh when the row was refreshed meanwhile (re-read before refreshing)', async () => {
    const stale = identity(0);
    mocks.identityRow = { ...identity(3_600_000), encryptedAccessToken: 'enc(already-new)' };
    expect(await giteaAccessTokenFor(stale)).toBe('already-new');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('throws a sign-in-again error when expired without a refresh token', async () => {
    const row = { ...identity(0), encryptedRefreshToken: null };
    mocks.identityRow = row;
    await expect(giteaAccessTokenFor(row)).rejects.toThrow(/sign in again/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
