import { describe, expect, it } from 'vitest';
import {
  exchangeGiteaAuthorizationCode,
  getGiteaUser,
  giteaAuthorizeUrl,
  giteaUserForge,
  listGiteaUserRepos,
  refreshGiteaAccessToken,
} from '../gitea-oauth.js';
import { fakeTransport } from './forge-contract.js';

const APP = {
  instanceUrl: 'https://git.example/',
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://mb.example/api/auth/gitea/callback',
};

describe('Gitea OAuth2 helpers (#369)', () => {
  it('builds the authorize URL on the instance root', () => {
    const url = new URL(giteaAuthorizeUrl(APP, 'st4te'));
    expect(url.origin + url.pathname).toBe('https://git.example/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: APP.redirectUri,
      response_type: 'code',
      state: 'st4te',
    });
  });

  it('exchanges a code with grant_type authorization_code and the redirect_uri', async () => {
    const t = fakeTransport();
    t.respond({ status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer' } });
    const tokens = await exchangeGiteaAuthorizationCode(APP, 'c0de', t.fetchImpl);
    expect(t.calls[0].url).toBe('https://git.example/login/oauth/access_token');
    expect(t.calls[0].method).toBe('POST');
    expect(JSON.parse(t.calls[0].body ?? '{}')).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      grant_type: 'authorization_code',
      code: 'c0de',
      redirect_uri: APP.redirectUri,
    });
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, tokenType: 'bearer', scope: null });
  });

  it('refreshes with grant_type refresh_token and surfaces OAuth errors', async () => {
    const t = fakeTransport();
    t.respond(
      { status: 200, body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 } },
      { status: 400, body: { error: 'invalid_grant', error_description: 'refresh token revoked' } },
    );
    const tokens = await refreshGiteaAccessToken(APP, 'rt', t.fetchImpl);
    expect(JSON.parse(t.calls[0].body ?? '{}')).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt' });
    expect(tokens.accessToken).toBe('at2');
    await expect(refreshGiteaAccessToken(APP, 'rt2', t.fetchImpl)).rejects.toThrow(/400/);
  });

  it('acts as the user: /user and the paged /user/repos', async () => {
    const t = fakeTransport();
    const forge = giteaUserForge('https://git.example', 'at', t.fetchImpl);
    const page2 = 'https://git.example/api/v1/user/repos?limit=50&page=2';
    t.respond(
      { status: 200, body: { id: 7, login: 'dan', avatar_url: null } },
      { status: 200, body: [{ id: 1, full_name: 'dan/a', name: 'a', owner: { login: 'dan' }, private: false, html_url: 'u', description: null }], headers: { link: `<${page2}>; rel="next"` } },
      { status: 200, body: [{ id: 2, full_name: 'dan/b', name: 'b', owner: { login: 'dan' }, private: true, html_url: 'u', description: null }] },
    );
    expect(await getGiteaUser(forge)).toMatchObject({ id: 7, login: 'dan' });
    expect(t.calls[0].headers.Authorization).toBe('token at');
    const repos = await listGiteaUserRepos(forge);
    expect(repos.map((r) => r.full_name)).toEqual(['dan/a', 'dan/b']);
    expect(t.calls[1].url).toBe('https://git.example/api/v1/user/repos?limit=50');
    expect(t.calls[2].url).toBe(page2);
  });
});
