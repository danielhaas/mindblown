/**
 * Gitea OAuth2 on the server side (#369): the app registration from env,
 * and "give me a live access token for this identity" with refresh +
 * persistence. Tokens are stored encrypted in `user_github_identities`
 * rows with `kind = 'gitea'` (same table as the GitHub identities).
 *
 * Env:
 *   GITEA_URL                 instance root, e.g. https://git.example
 *   GITEA_OAUTH_CLIENT_ID     OAuth2 application (confidential) client id
 *   GITEA_OAUTH_CLIENT_SECRET its secret
 *   PUBLIC_URL                this server's public origin (callback = <PUBLIC_URL>/api/auth/gitea/callback)
 */

import { and, eq } from 'drizzle-orm';
import {
  giteaEndpoint,
  refreshGiteaAccessToken,
  type GiteaOAuthApp,
  type GiteaOAuthTokens,
} from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { userGithubIdentities } from '../db/schema.js';
import { decrypt, encrypt } from '../crypto.js';

export const GITEA_CALLBACK_PATH = '/api/auth/gitea/callback';

export function giteaOAuthApp(): GiteaOAuthApp | null {
  const instanceUrl = process.env.GITEA_URL?.trim();
  const clientId = process.env.GITEA_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITEA_OAUTH_CLIENT_SECRET?.trim();
  const publicUrl = (process.env.PUBLIC_URL ?? process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
  if (!instanceUrl || !clientId || !clientSecret || !publicUrl) return null;
  return {
    instanceUrl: giteaEndpoint(instanceUrl).webBaseUrl,
    clientId,
    clientSecret,
    redirectUri: `${publicUrl}${GITEA_CALLBACK_PATH}`,
  };
}

export function isGiteaOAuthConfigured(): boolean {
  return giteaOAuthApp() !== null;
}

/** Refresh this many seconds before the recorded expiry. */
const REFRESH_SKEW_MS = 60_000;

export interface GiteaIdentityRow {
  id: string;
  userId: string;
  githubLogin: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
}

export async function findGiteaIdentity(userId: string): Promise<GiteaIdentityRow | null> {
  const [row] = await db
    .select({
      id: userGithubIdentities.id,
      userId: userGithubIdentities.userId,
      githubLogin: userGithubIdentities.githubLogin,
      encryptedAccessToken: userGithubIdentities.encryptedAccessToken,
      encryptedRefreshToken: userGithubIdentities.encryptedRefreshToken,
      tokenExpiresAt: userGithubIdentities.tokenExpiresAt,
    })
    .from(userGithubIdentities)
    .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'gitea')))
    .limit(1);
  return row ?? null;
}

export async function findGiteaIdentityById(identityId: string): Promise<GiteaIdentityRow | null> {
  const [row] = await db
    .select({
      id: userGithubIdentities.id,
      userId: userGithubIdentities.userId,
      githubLogin: userGithubIdentities.githubLogin,
      encryptedAccessToken: userGithubIdentities.encryptedAccessToken,
      encryptedRefreshToken: userGithubIdentities.encryptedRefreshToken,
      tokenExpiresAt: userGithubIdentities.tokenExpiresAt,
    })
    .from(userGithubIdentities)
    .where(and(eq(userGithubIdentities.id, identityId), eq(userGithubIdentities.kind, 'gitea')))
    .limit(1);
  return row ?? null;
}

/** Persist a fresh token pair on an identity row. */
export async function storeGiteaTokens(identityId: string, tokens: GiteaOAuthTokens): Promise<void> {
  await db
    .update(userGithubIdentities)
    .set({
      encryptedAccessToken: encrypt(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
      updatedAt: new Date(),
    })
    .where(eq(userGithubIdentities.id, identityId));
}

/**
 * A live access token for the identity: the stored one while it is fresh,
 * otherwise a refreshed pair (stored before it is returned, since Gitea
 * invalidates the previous refresh token). Throws when the identity has
 * no refresh token and the access token is expired — the user has to sign
 * in again.
 */
export async function giteaAccessTokenFor(identity: GiteaIdentityRow): Promise<string> {
  const expiresAt = identity.tokenExpiresAt?.getTime() ?? null;
  const fresh = expiresAt === null || expiresAt - Date.now() > REFRESH_SKEW_MS;
  if (fresh) return decrypt(identity.encryptedAccessToken);

  const app = giteaOAuthApp();
  if (!app) throw new Error('Gitea OAuth is not configured on this server');
  if (!identity.encryptedRefreshToken) {
    throw new Error(`Gitea token for ${identity.githubLogin} expired and cannot be refreshed — sign in again`);
  }
  const tokens = await refreshGiteaAccessToken(app, decrypt(identity.encryptedRefreshToken));
  await storeGiteaTokens(identity.id, tokens);
  return tokens.accessToken;
}
