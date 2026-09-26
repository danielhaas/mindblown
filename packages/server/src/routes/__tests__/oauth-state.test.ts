/**
 * OAuth state tokens are their own kind of token (#397).
 *
 * Both callbacks must refuse a state that is not theirs: a bearer session
 * token used as `state` (the pre-fix hole in reverse — no `typ`), the
 * other forge's state (a Gitea state carries the nonce-cookie binding the
 * GitHub callback does not have, so it must not finish there), and a
 * typ-less state minted by a pre-deploy server. A freshly minted state of
 * the right flow passes verifyState — proven by the callback getting PAST
 * the state check to its next error (missing code / missing cookie).
 *
 * Everything the callbacks would touch after the state check is stubbed;
 * these tests end before any of it runs.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({
  githubInstallations: {}, userGithubIdentities: {}, integrations: {}, mapPermissions: {}, maps: {}, workspaces: {},
}));
vi.mock('../../crypto.js', () => ({ encrypt: vi.fn() }));
vi.mock('../../auth.js', () => ({ OAUTH_STATE_TYP: 'oauth-state', requireAdmin: vi.fn() }));
vi.mock('../../lib/forge.js', () => ({ FORGE_PROVIDERS: ['github', 'gitea'] }));
vi.mock('../../lib/giteaOAuth.js', () => ({
  findGiteaIdentity: vi.fn(),
  giteaAccessTokenFor: vi.fn(),
  giteaOAuthApp: () => ({ instanceUrl: 'https://git.test', clientId: 'c', clientSecret: 's', redirectUri: 'https://mb.test/cb' }),
  isGiteaOAuthConfigured: () => true,
}));
vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mindblown/integrations');
  return { ...actual, isGitHubAppConfigured: () => true };
});

import { githubAuthRoutes } from '../auth-github.js';
import { giteaAuthRoutes } from '../auth-gitea.js';

const SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const sign = (payload: object) => jwt.sign(payload, SECRET, { expiresIn: '15m' });

const sessionToken = sign({ userId: 'u1', email: 'dan@example.com' });
const githubState = sign({ userId: 'u1', nonce: 'n1', kind: 'github', typ: 'oauth-state' });
const giteaState = sign({ userId: 'u1', nonce: 'n1', kind: 'gitea', typ: 'oauth-state' });
const legacyTyplessState = sign({ userId: 'u1', nonce: 'n1' });

async function build() {
  const app = Fastify();
  await app.register(githubAuthRoutes);
  await app.register(giteaAuthRoutes);
  await app.ready();
  return app;
}

function reason(location: string | undefined): string {
  return new URL(location ?? 'http://x/').searchParams.get('reason') ?? '';
}

describe('GitHub install callback state', () => {
  it('refuses a bearer session token, a Gitea state and a typ-less legacy state', async () => {
    const app = await build();
    for (const state of [sessionToken, giteaState, legacyTyplessState]) {
      const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${state}` });
      expect(res.statusCode).toBe(302);
      expect(reason(res.headers.location as string)).toBe('invalid_state');
    }
  });

  it('accepts its own freshly minted state (gets past the state check)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/github/install/callback?state=${githubState}` });
    expect(res.statusCode).toBe(302);
    expect(reason(res.headers.location as string)).not.toBe('invalid_state');
  });
});

describe('Gitea callback state', () => {
  it('refuses a bearer session token, a GitHub state and a typ-less legacy state', async () => {
    const app = await build();
    for (const state of [sessionToken, githubState, legacyTyplessState]) {
      const res = await app.inject({ method: 'GET', url: `/api/auth/gitea/callback?state=${state}&code=x` });
      expect(res.statusCode).toBe(302);
      expect(reason(res.headers.location as string)).toBe('invalid_state');
    }
  });

  it('accepts its own state and then insists on the nonce cookie', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/auth/gitea/callback?state=${giteaState}&code=x` });
    expect(res.statusCode).toBe(302);
    expect(reason(res.headers.location as string)).toBe('state_not_from_this_browser');
  });
});
