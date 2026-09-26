/**
 * The signed-in user's own GitHub identity (kind = 'github' rows of
 * `user_github_identities`), for writes that should carry the person's
 * name rather than the App's. Sibling of giteaOAuth.ts.
 *
 * The rows come from the App install flow (routes/auth-github.ts): App
 * user-to-server tokens, 8 h access + 6-month refresh when the App has
 * "expire user authorization tokens" on. `githubAccessTokenFor` refreshes
 * and re-stores when the stored token is about to expire, mirroring
 * `giteaAccessTokenFor`.
 */

import { and, eq } from 'drizzle-orm';
import { refreshUserAccessToken } from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { userGithubIdentities } from '../db/schema.js';
import { decrypt, encrypt } from '../crypto.js';

export interface GithubIdentityRow {
  id: string;
  userId: string;
  githubLogin: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
  scopes: string | null;
}

const SELECT = {
  id: userGithubIdentities.id,
  userId: userGithubIdentities.userId,
  githubLogin: userGithubIdentities.githubLogin,
  encryptedAccessToken: userGithubIdentities.encryptedAccessToken,
  encryptedRefreshToken: userGithubIdentities.encryptedRefreshToken,
  tokenExpiresAt: userGithubIdentities.tokenExpiresAt,
  scopes: userGithubIdentities.scopes,
};

export async function findGithubIdentity(userId: string): Promise<GithubIdentityRow | null> {
  const [row] = await db
    .select(SELECT)
    .from(userGithubIdentities)
    .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'github')))
    .limit(1);
  return row ?? null;
}

async function findGithubIdentityById(id: string): Promise<GithubIdentityRow | null> {
  const [row] = await db.select(SELECT).from(userGithubIdentities).where(eq(userGithubIdentities.id, id)).limit(1);
  return row ?? null;
}

/**
 * Can this token open issues as the person, given what we know without
 * calling GitHub? A classic OAuth token carries scopes and needs `repo`
 * (private) or `public_repo`; an App user-to-server token carries NO
 * scopes — its rights are the App's installation permissions intersected
 * with the user's own repo access, which includes issues on repos the App
 * syncs. Expiry is not judged here: `githubAccessTokenFor` refreshes.
 */
export function githubTokenUsableForIssues(
  row: Pick<GithubIdentityRow, 'scopes'>,
): { ok: true } | { ok: false; reason: string } {
  const scopes = (row.scopes ?? '').trim();
  if (scopes) {
    const set = new Set(scopes.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
    if (!set.has('repo') && !set.has('public_repo')) {
      return { ok: false, reason: `the user's GitHub token has no repo scope (${scopes})` };
    }
  }
  return { ok: true };
}

/** Refresh this many ms before the recorded expiry. */
const REFRESH_SKEW_MS = 60_000;
const inflightRefresh = new Map<string, Promise<string>>();

function isFresh(expiresAt: Date | null, now: number): boolean {
  return expiresAt === null || expiresAt.getTime() - now > REFRESH_SKEW_MS;
}

/**
 * A live access token for the identity: the stored one while fresh,
 * otherwise a refreshed pair (stored before it is returned — GitHub
 * invalidates the previous refresh token). Throws when there is nothing to
 * refresh with or GitHub refuses (refresh token older than six months,
 * App authorization revoked): the user has to sign in with GitHub again.
 */
export async function githubAccessTokenFor(identity: GithubIdentityRow): Promise<string> {
  if (isFresh(identity.tokenExpiresAt, Date.now())) return decrypt(identity.encryptedAccessToken);

  // Serialise per identity: two concurrent refreshes would hand in the
  // same one-shot refresh token and the loser would get invalid_grant.
  const pending = inflightRefresh.get(identity.id);
  if (pending) return pending;
  const run = (async () => {
    const current = (await findGithubIdentityById(identity.id)) ?? identity;
    if (isFresh(current.tokenExpiresAt, Date.now())) return decrypt(current.encryptedAccessToken);
    if (!current.encryptedRefreshToken) {
      throw new Error(`GitHub token for ${current.githubLogin} expired and cannot be refreshed — sign in with GitHub again`);
    }
    const tokens = await refreshUserAccessToken(decrypt(current.encryptedRefreshToken));
    await db
      .update(userGithubIdentities)
      .set({
        encryptedAccessToken: encrypt(tokens.accessToken),
        encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
        tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(userGithubIdentities.id, current.id));
    return tokens.accessToken;
  })();
  inflightRefresh.set(identity.id, run);
  try {
    return await run;
  } finally {
    inflightRefresh.delete(identity.id);
  }
}
