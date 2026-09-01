/**
 * GitHub App helpers for MindBlown.
 *
 * Handles App JWT minting, installation token exchange, user OAuth,
 * and repo listing — all via native fetch + jsonwebtoken. No @octokit deps.
 */

import {
  GitHubApiError,
  githubFetchPage,
  assertSamePaginationOrigin,
  type GitHubPage,
} from './github.js';

// ── Types ─────────────────────────────────────────────────────────

export interface GitHubAppConfig {
  appId: string;
  privateKey: string; // PEM-encoded RSA private key
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  appName: string; // URL slug, e.g. "mindblown-by-project-li"
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface UserOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  refreshTokenExpiresIn: number | null;
  tokenType: string;
  scope: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  html_url: string;
  description: string | null;
}

export interface GitHubInstallationAccount {
  id: number;
  login: string;
  type: string; // 'User' | 'Organization'
  avatar_url: string;
}

// ── Config ────────────────────────────────────────────────────────

let _config: GitHubAppConfig | null = null;

export function getGitHubAppConfig(): GitHubAppConfig {
  if (_config) return _config;

  const appId = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  const appName = process.env.GITHUB_APP_NAME;

  if (!appId || !privateKeyRaw || !clientId || !clientSecret || !webhookSecret || !appName) {
    throw new Error(
      'Missing GitHub App env vars. Required: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ' +
      'GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_NAME'
    );
  }

  // Private key may be base64-encoded (single line) or raw PEM
  let privateKey: string;
  if (privateKeyRaw.startsWith('-----BEGIN')) {
    privateKey = privateKeyRaw;
  } else {
    privateKey = Buffer.from(privateKeyRaw, 'base64').toString('utf8');
  }

  _config = { appId, privateKey, clientId, clientSecret, webhookSecret, appName };
  return _config;
}

/**
 * Check if GitHub App is configured (all env vars present).
 * Returns false instead of throwing.
 */
export function isGitHubAppConfigured(): boolean {
  try {
    getGitHubAppConfig();
    return true;
  } catch {
    return false;
  }
}

// ── App JWT ───────────────────────────────────────────────────────

/**
 * Mint a short-lived JWT signed with the App's private key (RS256).
 * Valid for 10 minutes per GitHub's requirements.
 */
export async function mintAppJwt(): Promise<string> {
  const config = getGitHubAppConfig();

  // Dynamic import to keep this file usable in non-Node contexts
  const { default: jwt } = await import('jsonwebtoken');

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60, // clock skew tolerance
      exp: now + 600, // 10 minutes
      iss: config.appId,
    },
    config.privateKey,
    { algorithm: 'RS256' },
  );
}

// ── Installation Tokens ──────────────────────────────────────────

const _tokenCache = new Map<string, InstallationToken>();

/**
 * Get an installation access token (cached, ~50 min TTL).
 * These are short-lived tokens that let us act as the installed App
 * on specific repos.
 *
 * On a 401 or 404 we throw `GitHubApiError` so the catchup loop's
 * consecutive-auth-failure escalation (githubCatchup.ts) can branch on
 * `err instanceof GitHubApiError && err.status === 401` for both the
 * fetch-401 path AND the mint-401 path (App suspended / installation
 * revoked). Other statuses still throw a plain `Error` — those are
 * transient (5xx / 502) and shouldn't pin the auth-failure counter.
 *
 * The error message format is preserved verbatim for log/backcompat
 * reasons; only the throw class changes.
 */
export async function mintInstallationToken(installationId: string): Promise<string> {
  const cached = _tokenCache.get(installationId);
  if (cached && cached.expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  const appJwt = await mintAppJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 404) {
      // `GitHubApiError`'s constructor formats the message as
      // `GitHub API <status>: <body>`, which slots into the catchup
      // token-resolution catch the same way a fetch-401 from `github.ts`
      // does — both flow through the same `err.message` path in logs.
      // Other statuses (5xx, etc.) stay as plain Error: those are
      // transient, the auth-failure counter shouldn't tick on them.
      throw new GitHubApiError(res.status, body);
    }
    throw new Error(`Failed to mint installation token: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };

  const installationToken: InstallationToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };

  _tokenCache.set(installationId, installationToken);
  return installationToken.token;
}

// ── Repository Listing ───────────────────────────────────────────

/**
 * List repositories accessible to a given installation.
 */
export async function listInstallationRepositories(installationId: string): Promise<GitHubRepo[]> {
  const token = await mintInstallationToken(installationId);
  const repos: GitHubRepo[] = [];

  // Follows `Link: rel="next"` like every other list walk, rather than
  // counting `page` up. This endpoint returns an ENVELOPE
  // (`{ total_count, repositories }`) rather than a bare array, so it
  // cannot use `paginateGitHub` — but it can share the same fetch
  // primitive, which is where the header parsing and the
  // pagination-limit error mapping live.
  //
  // The 422 depth limit realistically cannot bite here (an installation
  // grants access to dozens of repos, not tens of thousands). It is
  // converted anyway so this file stops being the one place that still
  // builds `?page=` by hand.
  // `paginateGitHub` carries the page ceiling for the other four walks;
  // this one has to state its own. Without it the only brake is the
  // server eventually not sending a `Link` — and a self-referential or
  // cycling header keeps sending one. The old loop at least stopped on a
  // short page; the first cut of this conversion dropped that and put
  // nothing in its place.
  const MAX_PAGES = 100; // 100 × 100 repos — far past any real installation.
  const FIRST_URL = 'https://api.github.com/installation/repositories?per_page=100';

  let url: string | null = FIRST_URL;
  let pages = 0;
  while (url) {
    const page: GitHubPage<{ total_count: number; repositories: GitHubRepo[] }> =
      await githubFetchPage(url, token);
    repos.push(...(page.data.repositories ?? []));
    pages += 1;

    // `total_count` is the endpoint's own answer to "am I done" — keep it
    // as the primary stop, but never as the ONLY one: a missing field is
    // `undefined`, and every comparison against that is false.
    if (repos.length >= page.data.total_count) break;
    if (!page.nextUrl) break;
    if (pages >= MAX_PAGES) {
      console.warn(
        `[github-app] installation ${installationId}: stopped listing repositories at ` +
          `${MAX_PAGES} pages — result is TRUNCATED`,
      );
      break;
    }
    // Same guard as `paginateGitHub`: the next URL comes from a response
    // header and the next request carries the installation token.
    assertSamePaginationOrigin(FIRST_URL, page.nextUrl);
    url = page.nextUrl;
  }

  return repos;
}

// ── User OAuth ───────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for user tokens.
 * Called during the install callback flow.
 */
export async function exchangeUserAuthorizationCode(code: string): Promise<UserOAuthTokens> {
  const config = getGitHubAppConfig();

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`OAuth error: ${data.error} — ${data.error_description}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
    refreshTokenExpiresIn: data.refresh_token_expires_in ?? null,
    tokenType: data.token_type,
    scope: data.scope,
  };
}

/**
 * Refresh an expired user OAuth access token.
 */
export async function refreshUserAccessToken(refreshToken: string): Promise<UserOAuthTokens> {
  const config = getGitHubAppConfig();

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token refresh failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`OAuth refresh error: ${data.error} — ${data.error_description}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
    refreshTokenExpiresIn: data.refresh_token_expires_in ?? null,
    tokenType: data.token_type,
    scope: data.scope,
  };
}

// ── GitHub User Info ─────────────────────────────────────────────

/**
 * Fetch the authenticated user's GitHub profile.
 */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch GitHub user: ${res.status} ${body}`);
  }

  return (await res.json()) as GitHubUser;
}

/**
 * Fetch installation details (account login, type, etc.)
 */
export async function getInstallationDetails(installationId: string): Promise<{
  id: number;
  account: GitHubInstallationAccount;
}> {
  const appJwt = await mintAppJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch installation: ${res.status} ${body}`);
  }

  return (await res.json()) as { id: number; account: GitHubInstallationAccount };
}

// ── Install URL ──────────────────────────────────────────────────

/**
 * Build the GitHub App installation URL with a state parameter.
 */
export function buildInstallUrl(state: string): string {
  const config = getGitHubAppConfig();
  return `https://github.com/apps/${config.appName}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Build the OAuth authorize URL for when the App is already installed
 * but the user needs to re-authorize (e.g. after a failed callback).
 */
export function buildOAuthAuthorizeUrl(state: string): string {
  const config = getGitHubAppConfig();
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.clientId)}&state=${encodeURIComponent(state)}`;
}

/**
 * List all installations of the GitHub App that a user has access to.
 * Uses the App JWT (not a user token).
 */
export async function listAppInstallations(): Promise<Array<{
  id: number;
  account: GitHubInstallationAccount;
}>> {
  const appJwt = await mintAppJwt();

  const res = await fetch('https://api.github.com/app/installations', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list installations: ${res.status} ${body}`);
  }

  return (await res.json()) as Array<{ id: number; account: GitHubInstallationAccount }>;
}
