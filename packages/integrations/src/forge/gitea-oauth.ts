/**
 * Gitea / Forgejo OAuth2 (#369) — the pieces the server needs to sign a
 * user in with their Gitea account and act with their token: authorize
 * URL, code exchange, refresh, profile, repo listing.
 *
 * Gitea implements the standard authorization-code flow:
 *   GET  <root>/login/oauth/authorize?client_id&redirect_uri&response_type=code&state
 *   POST <root>/login/oauth/access_token  (JSON; grant_type authorization_code | refresh_token)
 * Access tokens expire (1 h by default) and refresh tokens rotate on every
 * refresh, so the caller must persist what `refresh*` returns.
 */

import { GiteaForge, giteaEndpoint } from './gitea.js';
import { paginateGitHub } from './pagination.js';
import type { ForgeFetch } from './types.js';

export interface GiteaOAuthApp {
  /** Instance root, e.g. `https://git.example` (no `/api/v1`). */
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GiteaOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until the access token expires, when Gitea says. */
  expiresIn: number | null;
  tokenType: string;
  scope: string | null;
}

export interface GiteaUser {
  id: number;
  login: string;
  avatar_url: string | null;
  full_name?: string | null;
  email?: string | null;
}

export interface GiteaRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  html_url: string;
  description: string | null;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

function root(app: Pick<GiteaOAuthApp, 'instanceUrl'>): string {
  return giteaEndpoint(app.instanceUrl).webBaseUrl;
}

/** Where to send the browser. `state` is the server's signed nonce. */
export function giteaAuthorizeUrl(app: GiteaOAuthApp, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    state,
  });
  return `${root(app)}/login/oauth/authorize?${params.toString()}`;
}

const defaultFetch: ForgeFetch = (url, init) => fetch(url, init);

async function tokenRequest(
  app: GiteaOAuthApp,
  body: Record<string, string>,
  fetchImpl: ForgeFetch,
): Promise<GiteaOAuthTokens> {
  const res = await fetchImpl(`${root(app)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...body }),
  });
  const text = await res.text();
  if (!(res.ok ?? (res.status >= 200 && res.status < 300))) {
    throw new Error(`Gitea OAuth token request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.access_token) {
    throw new Error(`Gitea OAuth error: ${data.error ?? 'no access_token'} — ${data.error_description ?? ''}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
    tokenType: data.token_type ?? 'bearer',
    scope: data.scope ?? null,
  };
}

/** Exchange the `code` from the callback for tokens. */
export function exchangeGiteaAuthorizationCode(
  app: GiteaOAuthApp,
  code: string,
  fetchImpl: ForgeFetch = defaultFetch,
): Promise<GiteaOAuthTokens> {
  return tokenRequest(app, { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri }, fetchImpl);
}

/** Trade a refresh token for a new pair. The old refresh token is invalid afterwards. */
export function refreshGiteaAccessToken(
  app: GiteaOAuthApp,
  refreshToken: string,
  fetchImpl: ForgeFetch = defaultFetch,
): Promise<GiteaOAuthTokens> {
  return tokenRequest(app, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}

/** A client acting as the signed-in user. */
export function giteaUserForge(instanceUrl: string, accessToken: string, fetchImpl?: ForgeFetch): GiteaForge {
  return new GiteaForge({ token: accessToken, apiBaseUrl: instanceUrl, fetchImpl });
}

export function getGiteaUser(forge: GiteaForge): Promise<GiteaUser> {
  return forge.requestJson<GiteaUser>('/user');
}

/** Every repository the user can see, walked page by page (Link header). */
export async function listGiteaUserRepos(forge: GiteaForge, maxPages = 20): Promise<GiteaRepo[]> {
  const out: GiteaRepo[] = [];
  await paginateGitHub<GiteaRepo>('/user/repos?limit=50', forge, {
    maxPages,
    onPage: (batch) => {
      out.push(...batch);
    },
  });
  return out;
}
