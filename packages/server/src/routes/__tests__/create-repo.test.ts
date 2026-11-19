/**
 * Creating a repository for a new project: POST
 * /api/integrations/github/repositories creates it with the user's own
 * GitHub token in the account of one of their App installations (their own
 * account or an org), and reports whether the installation can see it;
 * POST /api/integrations/gitea/repositories creates it in the user's Gitea
 * account. Connecting it to a map is the existing bind path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../db/schema.js', () => ({
  githubInstallations: {}, userGithubIdentities: {}, integrations: {}, mapPermissions: {}, maps: {}, workspaces: {},
}));
vi.mock('../../crypto.js', () => ({ encrypt: vi.fn() }));
vi.mock('../../auth.js', () => ({ OAUTH_STATE_TYP: 'oauth-state', requireAdmin: vi.fn() }));
vi.mock('../../lib/forge.js', () => ({ FORGE_PROVIDERS: ['github', 'gitea'] }));

vi.hoisted(() => { process.env.GITHUB_REACHABLE_RETRY_MS = '0'; });

const state = vi.hoisted(() => ({
  githubIdentity: { id: 'ident-1', githubLogin: 'Alice' } as { id: string; githubLogin: string } | null,
  giteaIdentity: { id: 'gt-1', githubLogin: 'alice' } as { id: string; githubLogin: string } | null,
  installations: [] as Array<{ id: number; account: { login: string; type: string; id: number } }>,
  installationsFail: null as null | number,
  reachable: [] as string[],
  createGitHub: vi.fn(),
  createGitea: vi.fn(),
}));

vi.mock('../../lib/githubIdentity.js', () => ({
  findGithubIdentity: async () => state.githubIdentity,
  githubAccessTokenFor: async () => 'user-token',
}));
vi.mock('../../lib/githubInstallations.js', () => ({
  userInstallationRepos: async () => ({ repos: state.reachable.map((full_name) => ({ full_name })) }),
}));
vi.mock('../../lib/giteaOAuth.js', () => ({
  findGiteaIdentity: async () => state.giteaIdentity,
  giteaAccessTokenFor: async () => 'gitea-token',
  giteaOAuthApp: () => ({ instanceUrl: 'https://git.test', clientId: 'c', clientSecret: 's', redirectUri: 'https://mb.test/cb' }),
  isGiteaOAuthConfigured: () => true,
}));
vi.mock('@mindblown/integrations', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mindblown/integrations');
  return {
    ...actual,
    isGitHubAppConfigured: () => true,
    listUserInstallations: async () => {
      if (state.installationsFail) throw Object.assign(new Error('GitHub'), { status: state.installationsFail });
      return state.installations;
    },
    createGitHubRepository: (...a: unknown[]) => state.createGitHub(...a),
    createGiteaUserRepo: (...a: unknown[]) => state.createGitea(...a),
  };
});

import { githubAuthRoutes } from '../auth-github.js';
import { giteaAuthRoutes } from '../auth-gitea.js';

const OWN = { id: 111, account: { login: 'alice', type: 'User', id: 1 } };
const ORG = { id: 222, account: { login: 'acme', type: 'Organization', id: 2 } };
const OTHER_USER = { id: 333, account: { login: 'bob', type: 'User', id: 3 } };
const ghRepo = (owner: string, name: string) => ({
  full_name: `${owner}/${name}`, name, owner: { login: owner }, private: true, html_url: `https://github.com/${owner}/${name}`,
});
const apiError = (status: number, body = '') => Object.assign(new Error(`API ${status}`), { status, body });

async function post(url: string, payload: Record<string, unknown>) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { (req as { userId?: string }).userId = 'u1'; });
  await app.register(githubAuthRoutes);
  await app.register(giteaAuthRoutes);
  const res = await app.inject({ method: 'POST', url, payload });
  await app.close();
  return res;
}
const createGitHub = (payload: Record<string, unknown>) => post('/api/integrations/github/repositories', payload);

beforeEach(() => {
  state.githubIdentity = { id: 'ident-1', githubLogin: 'Alice' };
  state.giteaIdentity = { id: 'gt-1', githubLogin: 'alice' };
  state.installations = [OWN, ORG, OTHER_USER];
  state.reachable = [];
  state.installationsFail = null;
  state.createGitHub.mockReset();
  state.createGitea.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/integrations/github/repositories', () => {
  it("creates in the user's own account, private by default, and reports it reachable", async () => {
    state.createGitHub.mockResolvedValue(ghRepo('alice', 'dumb2'));
    state.reachable = ['alice/dumb2'];
    const res = await createGitHub({ installationId: '111', name: 'dumb2', description: 'Test' });
    expect(res.statusCode).toBe(201);
    expect(state.createGitHub).toHaveBeenCalledWith('user-token', { name: 'dumb2', private: true, description: 'Test' });
    expect(res.json()).toMatchObject({ fullName: 'alice/dumb2', installationId: '111', reachable: true });
    expect(res.json().addAccessUrl).toBeUndefined();
  });

  it("creates in an organization's account", async () => {
    state.createGitHub.mockResolvedValue(ghRepo('acme', 'shop'));
    state.reachable = ['acme/shop'];
    const res = await createGitHub({ installationId: '222', name: 'shop', private: false });
    expect(res.statusCode).toBe(201);
    expect(state.createGitHub).toHaveBeenCalledWith('user-token', { name: 'shop', private: false, description: undefined, org: 'acme' });
  });

  it('says where to add access when the installation does not see the new repo', async () => {
    state.createGitHub.mockResolvedValue(ghRepo('acme', 'shop'));
    const res = await createGitHub({ installationId: '222', name: 'shop' });
    expect(res.json()).toMatchObject({
      reachable: false,
      addAccessUrl: 'https://github.com/organizations/acme/settings/installations/222',
    });
  });

  it("refuses an installation the user's token does not list, and another user's account", async () => {
    expect((await createGitHub({ installationId: '999', name: 'x' })).statusCode).toBe(403);
    expect((await createGitHub({ installationId: '333', name: 'x' })).statusCode).toBe(403);
    expect(state.createGitHub).not.toHaveBeenCalled();
  });

  it('refuses without a GitHub identity, and a name GitHub would not take', async () => {
    expect((await createGitHub({ installationId: '111', name: 'no spaces' })).statusCode).toBe(400);
    state.githubIdentity = null;
    expect((await createGitHub({ installationId: '111', name: 'ok' })).json().error.code).toBe('GITHUB_NOT_CONNECTED');
    expect(state.createGitHub).not.toHaveBeenCalled();
  });

  it('ignores a non-boolean private and a non-string description', async () => {
    state.createGitHub.mockResolvedValue(ghRepo('alice', 'x'));
    await createGitHub({ installationId: '111', name: 'x', private: 'false', description: 42 });
    expect(state.createGitHub).toHaveBeenCalledWith('user-token', { name: 'x', private: true, description: undefined });
  });

  it('sends a multi-line description as one line (GitHub refuses control characters)', async () => {
    state.createGitHub.mockResolvedValue(ghRepo('alice', 'x'));
    state.reachable = ['alice/x'];
    await createGitHub({ installationId: '111', name: 'x', description: 'A shop.\nDone = first order.' });
    expect(state.createGitHub).toHaveBeenCalledWith('user-token', { name: 'x', private: true, description: 'A shop. Done = first order.' });
  });

  it('answers 502 / reconnect when GitHub fails to list the installations', async () => {
    state.installationsFail = 500;
    expect((await createGitHub({ installationId: '111', name: 'x' })).statusCode).toBe(502);
    state.installationsFail = 401;
    expect((await createGitHub({ installationId: '111', name: 'x' })).json().error.code).toBe('GITHUB_NOT_CONNECTED');
  });

  it('passes a 422 that is not about the name through with GitHub\'s words', async () => {
    state.createGitHub.mockRejectedValueOnce(apiError(422, JSON.stringify({
      message: 'Repository creation failed.',
      errors: [{ message: 'Visibility can\'t be private. Please upgrade your plan.' }],
    })));
    const res = await createGitHub({ installationId: '222', name: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/Visibility can't be private/);
  });

  it("maps GitHub's answers: 422 name taken → 409, 403 → App permission, other → 502", async () => {
    state.createGitHub.mockRejectedValueOnce(apiError(422, JSON.stringify({
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', field: 'name', message: 'name already exists on this account' }],
    })));
    const taken = await createGitHub({ installationId: '111', name: 'dup' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe('alice/dup already exists');

    state.createGitHub.mockRejectedValueOnce(apiError(403));
    const refused = await createGitHub({ installationId: '111', name: 'x' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/Administration permission/);

    state.createGitHub.mockRejectedValueOnce(apiError(500));
    expect((await createGitHub({ installationId: '111', name: 'x' })).statusCode).toBe(502);
  });
});

describe('POST /api/integrations/gitea/repositories', () => {
  it("creates in the user's Gitea account", async () => {
    state.createGitea.mockResolvedValue({ full_name: 'alice/dumb2', name: 'dumb2', owner: { login: 'alice' }, private: true, html_url: 'https://git.test/alice/dumb2' });
    const res = await post('/api/integrations/gitea/repositories', { name: 'dumb2' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fullName: 'alice/dumb2', owner: 'alice', name: 'dumb2' });
    expect(state.createGitea.mock.calls[0][1]).toEqual({ name: 'dumb2', private: true, description: undefined });
  });

  it('sends a multi-line description to Gitea as one line', async () => {
    state.createGitea.mockResolvedValue({ full_name: 'alice/x', name: 'x', owner: { login: 'alice' }, private: true, html_url: 'u' });
    await post('/api/integrations/gitea/repositories', { name: 'x', description: 'A shop.\r\nDone.' });
    expect(state.createGitea.mock.calls[0][1]).toEqual({ name: 'x', private: true, description: 'A shop. Done.' });
  });

  it('answers 409 for a taken name and 404 without a Gitea sign-in', async () => {
    state.createGitea.mockRejectedValueOnce(apiError(409));
    expect((await post('/api/integrations/gitea/repositories', { name: 'dup' })).statusCode).toBe(409);
    state.giteaIdentity = null;
    expect((await post('/api/integrations/gitea/repositories', { name: 'x' })).statusCode).toBe(404);
  });
});
