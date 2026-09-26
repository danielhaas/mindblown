/**
 * Who files the issue. The rule under test: the acting person's own forge
 * identity when it exists on the map's forge and can write, otherwise the
 * repo binding — and a refused personal token falls back to the binding
 * rather than losing the issue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getContextMock = vi.fn();
const getEndpointMock = vi.fn();
const findGiteaMock = vi.fn();
const giteaTokenMock = vi.fn();
const giteaAppMock = vi.fn();
const findGithubMock = vi.fn();
const createIssueMock = vi.fn();
const createClientMock = vi.fn();
const githubForgeMock = vi.fn();
const updateNodeMock = vi.fn();

vi.mock('../../lib/githubContext.js', () => ({
  getGitHubContextForMap: (...a: unknown[]) => getContextMock(...a),
  getForgeEndpointForMap: (...a: unknown[]) => getEndpointMock(...a),
}));
vi.mock('../../lib/giteaOAuth.js', () => ({
  findGiteaIdentity: (...a: unknown[]) => findGiteaMock(...a),
  giteaAccessTokenFor: (...a: unknown[]) => giteaTokenMock(...a),
  giteaOAuthApp: () => giteaAppMock(),
}));
vi.mock('../../lib/githubIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/githubIdentity.js')>();
  return {
    ...actual,
    findGithubIdentity: (...a: unknown[]) => findGithubMock(...a),
    githubAccessTokenFor: async (row: { encryptedAccessToken: string; tokenExpiresAt: Date | null; encryptedRefreshToken: string | null }) => {
      if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= Date.now()) {
        if (!row.encryptedRefreshToken) throw new Error('expired and cannot be refreshed — sign in with GitHub again');
        return 'refreshed-token';
      }
      return `plain:${row.encryptedAccessToken}`;
    },
  };
});
vi.mock('@mindblown/integrations', () => ({
  createGitHubIssue: (...a: unknown[]) => createIssueMock(...a),
  createForgeClient: (...a: unknown[]) => createClientMock(...a),
  githubForge: (...a: unknown[]) => githubForgeMock(...a),
}));
vi.mock('../../db/nodes.js', () => ({ updateNode: (...a: unknown[]) => updateNodeMock(...a) }));
vi.mock('../../lib/descriptionMirror.js', () => ({ stampMirrorHash: (l: unknown) => l }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { createForgeIssueForNode, userForgeForMap, NoForgeIntegrationError } from '../forgeIssue.js';

const BINDING = { name: 'binding-forge' };
const node = { id: 'n1', text: 'T', externalLinks: [], tags: [], priority: null, description: null } as never;

beforeEach(() => {
  vi.clearAllMocks();
  getContextMock.mockResolvedValue({ owner: 'o', repo: 'r', token: 't', forge: BINDING });
  updateNodeMock.mockImplementation(async (id: string, f: Record<string, unknown>) => ({ id, text: 'T', ...f }));
  createIssueMock.mockResolvedValue({
    issue: { number: 7, html_url: 'https://x/7', title: 'T' },
    externalLink: { provider: 'github', externalId: 'o/r#7', url: 'https://x/7' },
  });
});

describe('userForgeForMap', () => {
  it('Gitea: uses the signed-in user token when the repo is on the same instance', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'gitea', apiBaseUrl: 'https://git.x/api/v1', webBaseUrl: 'https://git.x' });
    findGiteaMock.mockResolvedValue({ id: 'i1', githubLogin: 'dan' });
    giteaAppMock.mockReturnValue({ instanceUrl: 'https://git.x/' });
    giteaTokenMock.mockResolvedValue('live-token');
    createClientMock.mockReturnValue({ name: 'user-forge' });

    const r = await userForgeForMap('m1', 'u1');
    expect(r).toEqual({ forge: { name: 'user-forge' }, login: 'dan' });
    expect(createClientMock).toHaveBeenCalledWith({
      kind: 'gitea',
      apiBaseUrl: 'https://git.x/api/v1',
      webBaseUrl: 'https://git.x',
      token: 'live-token',
    });
  });

  it('Gitea: refuses a sign-in on another instance, and no sign-in at all', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'gitea', apiBaseUrl: 'https://git.x/api/v1', webBaseUrl: 'https://git.x' });
    findGiteaMock.mockResolvedValueOnce({ id: 'i1', githubLogin: 'dan' });
    giteaAppMock.mockReturnValue({ instanceUrl: 'https://other.example' });
    const other = await userForgeForMap('m1', 'u1');
    expect(other.forge).toBeNull();
    expect((other as { reason: string }).reason).toContain('other.example');

    findGiteaMock.mockResolvedValueOnce(null);
    const none = await userForgeForMap('m1', 'u1');
    expect((none as { reason: string }).reason).toContain('no Gitea sign-in');
  });

  it('GitHub: App user token (no scopes) and repo-scoped OAuth token are used; scoped-without-repo and expired are not', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'github', apiBaseUrl: 'https://api.github.com', webBaseUrl: 'https://github.com' });
    githubForgeMock.mockReturnValue({ name: 'gh-user-forge' });

    // GitHub App user-to-server token: no scopes, not expired.
    findGithubMock.mockResolvedValueOnce({ githubLogin: 'dan', encryptedAccessToken: 'enc', scopes: null, tokenExpiresAt: null });
    expect(await userForgeForMap('m1', 'u1')).toEqual({ forge: { name: 'gh-user-forge' }, login: 'dan' });
    expect(githubForgeMock).toHaveBeenCalledWith('plain:enc');

    findGithubMock.mockResolvedValueOnce({ githubLogin: 'dan', encryptedAccessToken: 'enc', scopes: 'read:user,public_repo', tokenExpiresAt: null });
    expect((await userForgeForMap('m1', 'u1')).forge).not.toBeNull();

    findGithubMock.mockResolvedValueOnce({ githubLogin: 'dan', encryptedAccessToken: 'enc', scopes: 'read:user', tokenExpiresAt: null });
    const noScope = await userForgeForMap('m1', 'u1');
    expect(noScope.forge).toBeNull();
    expect((noScope as { reason: string }).reason).toContain('no repo scope');

    // Expired App token with a refresh token: refreshed and used.
    findGithubMock.mockResolvedValueOnce({ githubLogin: 'dan', encryptedAccessToken: 'enc', scopes: null, tokenExpiresAt: new Date(Date.now() - 1000), encryptedRefreshToken: 'r' });
    expect((await userForgeForMap('m1', 'u1')).forge).not.toBeNull();
    expect(githubForgeMock).toHaveBeenLastCalledWith('refreshed-token');

    // Expired without a refresh token: the error propagates (the caller falls back).
    findGithubMock.mockResolvedValueOnce({ githubLogin: 'dan', encryptedAccessToken: 'enc', scopes: null, tokenExpiresAt: new Date(Date.now() - 1000), encryptedRefreshToken: null });
    await expect(userForgeForMap('m1', 'u1')).rejects.toThrow(/sign in with GitHub again/);
  });
});

describe('createForgeIssueForNode', () => {
  it('files as the binding when no actor is given', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'github', apiBaseUrl: '', webBaseUrl: '' });
    const r = await createForgeIssueForNode('m1', node);
    expect(createIssueMock).toHaveBeenCalledWith(node, 'o', 'r', BINDING);
    expect(r.author).toEqual({ as: 'binding', login: null });
    expect(r.issue).toEqual({ number: 7, html_url: 'https://x/7', title: 'T' });
    expect(updateNodeMock).toHaveBeenCalledWith('n1', {
      externalLinks: [{ provider: 'github', externalId: 'o/r#7', url: 'https://x/7' }],
    });
  });

  it('files as the person when they have a usable identity', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'gitea', apiBaseUrl: 'https://git.x/api/v1', webBaseUrl: 'https://git.x' });
    findGiteaMock.mockResolvedValue({ id: 'i1', githubLogin: 'dan' });
    giteaAppMock.mockReturnValue({ instanceUrl: 'https://git.x' });
    giteaTokenMock.mockResolvedValue('live');
    const USER = { name: 'user-forge' };
    createClientMock.mockReturnValue(USER);

    const r = await createForgeIssueForNode('m1', node, { actorUserId: 'u1' });
    expect(createIssueMock).toHaveBeenCalledWith(node, 'o', 'r', USER);
    expect(r.author).toEqual({ as: 'user', login: 'dan' });
  });

  it('falls back to the binding when the personal token is refused, and says why', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'gitea', apiBaseUrl: 'https://git.x/api/v1', webBaseUrl: 'https://git.x' });
    findGiteaMock.mockResolvedValue({ id: 'i1', githubLogin: 'dan' });
    giteaAppMock.mockReturnValue({ instanceUrl: 'https://git.x' });
    giteaTokenMock.mockResolvedValue('live');
    createClientMock.mockReturnValue({ name: 'user-forge' });
    createIssueMock.mockRejectedValueOnce(new Error('403 no write access'));

    const r = await createForgeIssueForNode('m1', node, { actorUserId: 'u1' });
    expect(createIssueMock).toHaveBeenCalledTimes(2);
    expect(createIssueMock.mock.calls[1][3]).toBe(BINDING);
    expect(r.author).toEqual({ as: 'binding', login: null, fallbackReason: '403 no write access' });
  });

  it('reports why the person was not used when their token cannot be refreshed', async () => {
    getEndpointMock.mockResolvedValue({ kind: 'gitea', apiBaseUrl: 'https://git.x/api/v1', webBaseUrl: 'https://git.x' });
    findGiteaMock.mockResolvedValue({ id: 'i1', githubLogin: 'dan' });
    giteaAppMock.mockReturnValue({ instanceUrl: 'https://git.x' });
    giteaTokenMock.mockRejectedValue(new Error('expired — sign in again'));

    const r = await createForgeIssueForNode('m1', node, { actorUserId: 'u1' });
    expect(createIssueMock).toHaveBeenCalledWith(node, 'o', 'r', BINDING);
    expect(r.author).toMatchObject({ as: 'binding', fallbackReason: 'expired — sign in again' });
  });

  it('throws NoForgeIntegrationError without a binding', async () => {
    getContextMock.mockResolvedValueOnce(null);
    await expect(createForgeIssueForNode('m1', node, { actorUserId: 'u1' })).rejects.toBeInstanceOf(NoForgeIntegrationError);
  });
});
