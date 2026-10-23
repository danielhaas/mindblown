/**
 * A GitHub App installation is the caller's only when their own GitHub
 * token lists it. The install callback stores nothing on the word of the
 * installation_id in the redirect URL, the OAuth-only flow syncs the user's
 * list (never every installation of the App), and the repository listing
 * refuses an installation id that is not recorded for the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const calls = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  deletes: [] as Array<{ table: string; where: unknown }>,
}));
const tables = vi.hoisted(() => ({
  githubInstallations: { _: 'githubInstallations', installationId: 'installation_id', userId: 'user_id', id: 'id' },
  userGithubIdentities: { _: 'userGithubIdentities', userId: 'user_id', kind: 'kind', id: 'id' },
}));

vi.mock('../../db/connection.js', () => {
  const selectChain = () => {
    const chain = { from: () => chain, where: () => chain, limit: async () => [] };
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      insert: (table: { _: string }) => ({
        values: async (values: Record<string, unknown>) => { calls.inserts.push({ table: table._, values }); },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      delete: (table: { _: string }) => ({
        where: async (where: unknown) => { calls.deletes.push({ table: table._, where }); },
      }),
    },
  };
});
vi.mock('../../db/schema.js', () => tables);
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ['and', ...a],
  eq: (c: unknown, v: unknown) => ['eq', c, v],
  notInArray: (c: unknown, v: unknown) => ['notIn', c, v],
}));
vi.mock('../../crypto.js', () => ({ encrypt: (s: string) => `enc(${s})` }));
vi.mock('../../auth.js', () => ({ OAUTH_STATE_TYP: 'oauth-state' }));

const identity = vi.hoisted(() => ({
  row: null as null | { id: string },
  owned: new Set<string>(),
}));
vi.mock('../../lib/githubIdentity.js', () => ({
  findGithubIdentity: async () => identity.row,
  githubAccessTokenFor: async () => 'stored-token',
}));
vi.mock('../../lib/githubInstallations.js', () => ({
  userHasGithubInstallation: async (_u: string, id: string) => identity.owned.has(id),
}));

const gh = vi.hoisted(() => ({
  userInstallations: [] as Array<{ id: number; account: { login: string; type: string; id: number } }>,
  tokenSeen: [] as string[],
  listRepos: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@mindblown/integrations', () => ({
  isGitHubAppConfigured: () => true,
  buildInstallUrl: () => 'https://github.test/install',
  buildOAuthAuthorizeUrl: () => 'https://github.test/oauth',
  exchangeUserAuthorizationCode: async () => ({ accessToken: 'fresh-token', refreshToken: null, expiresIn: null, scope: '' }),
  getGitHubUser: async () => ({ id: 7, login: 'alice', avatar_url: '' }),
  listUserInstallations: async (token: string) => { gh.tokenSeen.push(token); return gh.userInstallations; },
  listInstallationRepositories: (...a: unknown[]) => gh.listRepos(...(a as [])),
}));

import { githubAuthRoutes } from '../auth-github.js';

const SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const state = jwt.sign({ userId: 'u1', nonce: 'n', kind: 'github', typ: 'oauth-state' }, SECRET, { expiresIn: '15m' });
const ALICE_ORG = { id: 111, account: { login: 'alice-org', type: 'Organization', id: 5 } };

async function build() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { (req as { userId?: string }).userId = 'u1'; });
  await app.register(githubAuthRoutes);
  await app.ready();
  return app;
}

function reason(location: unknown): string {
  return new URL(String(location)).searchParams.get('reason') ?? '';
}

const installationInserts = () => calls.inserts.filter((c) => c.table === 'githubInstallations');

beforeEach(() => {
  calls.inserts = [];
  calls.deletes = [];
  identity.row = null;
  identity.owned = new Set();
  gh.userInstallations = [ALICE_ORG];
  gh.tokenSeen = [];
  gh.listRepos.mockClear();
});

describe('GitHub install callback — installation ownership', () => {
  it("stores an installation the user's own token lists", async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}&code=c&installation_id=111` });
    expect(res.headers.location).toMatch(/gh=connected/);
    expect(gh.tokenSeen).toEqual(['fresh-token']);
    expect(installationInserts()).toEqual([
      { table: 'githubInstallations', values: expect.objectContaining({ userId: 'u1', installationId: '111', accountLogin: 'alice-org' }) },
    ]);
  });

  it("refuses an installation_id the user's token does not list", async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}&code=c&installation_id=999` });
    expect(reason(res.headers.location)).toBe('installation_not_yours');
    expect(installationInserts()).toEqual([]);
  });

  it('without a code, checks against the stored identity token', async () => {
    identity.row = { id: 'ident-1' };
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}&installation_id=111` });
    expect(res.headers.location).toMatch(/gh=connected/);
    expect(gh.tokenSeen).toEqual(['stored-token']);
    expect(installationInserts()).toHaveLength(1);
  });

  it('without a code or a stored identity, stores nothing', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}&installation_id=111` });
    expect(reason(res.headers.location)).toBe('installation_unverified');
    expect(installationInserts()).toEqual([]);
  });

  it("OAuth-only flow syncs the user's list and drops rows they can no longer reach", async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}&code=c` });
    expect(res.headers.location).toMatch(/gh=connected/);
    expect(installationInserts().map((c) => c.values.installationId)).toEqual(['111']);
    expect(calls.deletes).toEqual([
      {
        table: 'githubInstallations',
        where: ['and', ['eq', 'user_id', 'u1'], ['notIn', 'installation_id', ['111']]],
      },
    ]);
  });
});

describe('GET /api/integrations/github/repositories — installation ownership', () => {
  it('refuses an installation that is not recorded for the caller', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/integrations/github/repositories?installationId=999' });
    expect(res.statusCode).toBe(403);
    expect(gh.listRepos).not.toHaveBeenCalled();
  });

  it("lists the caller's own installation", async () => {
    identity.owned = new Set(['111']);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/integrations/github/repositories?installationId=111' });
    expect(res.statusCode).toBe(200);
    expect(gh.listRepos).toHaveBeenCalledWith('111');
  });
});
