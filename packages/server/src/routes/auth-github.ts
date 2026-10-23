/**
 * GitHub App install + OAuth callback routes.
 *
 * Flow:
 * 1. GET /api/auth/github/install → redirects user to GitHub App install page
 * 2. GET /api/auth/github/install/callback → GitHub redirects back here with
 *    installation_id + code; we persist the installation + user OAuth identity
 * 3. GET /api/auth/github/status → check if the current user has a GitHub identity
 * 4. GET /api/integrations/github/repositories → list repos for the user's installation
 * 5. POST /api/integrations/github/repositories → create a repo for the user
 * 6. POST /api/auth/github/disconnect → remove GitHub identity
 */

import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { OAUTH_STATE_TYP } from '../auth.js';
import { db } from '../db/connection.js';
import { githubInstallations, userGithubIdentities } from '../db/schema.js';
import { encrypt } from '../crypto.js';
import { eq, and, notInArray } from 'drizzle-orm';
import { findGithubIdentity, githubAccessTokenFor } from '../lib/githubIdentity.js';
import { userInstallationRepos } from '../lib/githubInstallations.js';
import {
  buildInstallUrl,
  buildOAuthAuthorizeUrl,
  exchangeUserAuthorizationCode,
  getGitHubUser,
  listUserInstallations,
  createGitHubRepository,
  isGitHubAppConfigured,
} from '@mindblown/integrations';

const JWT_SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

interface StatePayload {
  userId: string;
  nonce: string;
  /** Which flow minted it — a Gitea state must not finish here (its
   *  nonce-cookie binding lives on the Gitea callback only). */
  kind: 'github';
  /** Marks this as an OAuth state token, never a bearer (#397). */
  typ: typeof OAUTH_STATE_TYP;
}

function signState(userId: string): string {
  const nonce = Math.random().toString(36).slice(2);
  return jwt.sign({ userId, nonce, kind: 'github', typ: OAUTH_STATE_TYP } satisfies StatePayload, JWT_SECRET, { expiresIn: '15m' });
}

async function upsertInstallation(
  userId: string,
  inst: { id: number; account: { login: string; type: string; id: number } },
): Promise<void> {
  const values = {
    accountLogin: inst.account.login,
    accountType: inst.account.type,
    accountId: String(inst.account.id),
  };
  const [existing] = await db.select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.userId, userId), eq(githubInstallations.installationId, String(inst.id))))
    .limit(1);
  if (existing) {
    await db.update(githubInstallations).set({ ...values, updatedAt: new Date() }).where(eq(githubInstallations.id, existing.id));
  } else {
    await db.insert(githubInstallations).values({ userId, installationId: String(inst.id), ...values });
  }
}

/** GitHub's repository-name alphabet. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function verifyState(token: string): StatePayload {
  const payload = jwt.verify(token, JWT_SECRET) as StatePayload;
  if (payload.typ !== OAUTH_STATE_TYP) throw new Error('not an OAuth state token');
  if (payload.kind !== 'github') throw new Error('state is not a github flow');
  return payload;
}

export async function githubAuthRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/auth/github/install ─────────────────────────────────
  // Authenticated user starts the GitHub App install flow.
  // Returns the install URL (frontend opens it in a new window).
  app.get('/api/auth/github/install', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Must be logged in to connect GitHub' },
      });
    }

    if (!isGitHubAppConfigured()) {
      return reply.status(503).send({
        error: { code: 'GITHUB_NOT_CONFIGURED', message: 'GitHub App is not configured on this server' },
      });
    }

    const state = signState(userId);

    // Check if user already has an installation but no identity (failed callback recovery)
    const [existingIdentity] = await db.select({ id: userGithubIdentities.id })
      .from(userGithubIdentities)
      .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'github')))
      .limit(1);

    if (existingIdentity) {
      // Already fully connected — shouldn't be here, but return install URL anyway
      const installUrl = buildInstallUrl(state);
      return reply.send({ installUrl });
    }

    // Check if app is installed but identity is missing (failed callback scenario)
    const [existingInstall] = await db.select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.userId, userId))
      .limit(1);

    if (existingInstall) {
      // App installed but OAuth failed — use OAuth-only flow
      const installUrl = buildOAuthAuthorizeUrl(state);
      return reply.send({ installUrl });
    }

    // Fresh install
    const installUrl = buildInstallUrl(state);
    return reply.send({ installUrl });
  });

  // ── GET /api/auth/github/install/callback ────────────────────────
  // GitHub redirects here after the user installs the App.
  // Query params: installation_id, setup_action, code, state
  app.get('/api/auth/github/install/callback', async (req, reply) => {
    const query = req.query as {
      installation_id?: string;
      setup_action?: string;
      code?: string;
      state?: string;
    };

    // Validate state
    if (!query.state) {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=missing_state`);
    }

    let statePayload: StatePayload;
    try {
      statePayload = verifyState(query.state);
    } catch {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=invalid_state`);
    }

    const { userId } = statePayload;

    if (!query.installation_id && !query.code) {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=missing_params`);
    }

    try {
      // The user's own GitHub token decides which installations are theirs.
      // installation_id arrives in the redirect URL and can be anyone's, so
      // it is never stored on its word alone.
      let userToken: string | null = null;
      if (query.code) {
        const tokens = await exchangeUserAuthorizationCode(query.code);
        const ghUser = await getGitHubUser(tokens.accessToken);

        // Upsert user GitHub identity
        const existingIdentity = await db.select({ id: userGithubIdentities.id })
          .from(userGithubIdentities)
          .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'github')))
          .limit(1);

        const identityValues = {
          githubUserId: String(ghUser.id),
          githubLogin: ghUser.login,
          avatarUrl: ghUser.avatar_url,
          encryptedAccessToken: encrypt(tokens.accessToken),
          encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresIn
            ? new Date(Date.now() + tokens.expiresIn * 1000)
            : null,
          scopes: tokens.scope || null,
          updatedAt: new Date(),
        };

        if (existingIdentity.length > 0) {
          await db.update(userGithubIdentities)
            .set(identityValues)
            .where(eq(userGithubIdentities.id, existingIdentity[0].id));
        } else {
          await db.insert(userGithubIdentities).values({
            userId,
            ...identityValues,
          });
        }
        userToken = tokens.accessToken;
      } else {
        // An install without the OAuth step: fall back to the token we hold.
        const identity = await findGithubIdentity(userId);
        if (identity) userToken = await githubAccessTokenFor(identity).catch(() => null);
      }
      if (!userToken) {
        // Installed without the OAuth step and no identity yet: sign in
        // with GitHub; that callback (code, no installation_id) syncs the
        // user's installations, this one included.
        return reply.redirect(buildOAuthAuthorizeUrl(signState(userId)));
      }

      if (query.installation_id) {
        const reachable = await listUserInstallations(userToken);
        const inst = reachable.find((i) => String(i.id) === query.installation_id);
        if (!inst) {
          return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=installation_not_yours`);
        }
        await upsertInstallation(userId, inst);
      } else {
        // OAuth-only flow: sync the full list, and drop rows the user can
        // no longer reach (uninstalled, or access removed on GitHub). The
        // identity is saved already; a failed listing keeps the old rows.
        let reachable: Awaited<ReturnType<typeof listUserInstallations>>;
        try {
          reachable = await listUserInstallations(userToken);
        } catch (syncErr) {
          console.warn('[github] Failed to sync installations:', syncErr);
          return reply.redirect(`${FRONTEND_URL}/?gh=connected`);
        }
        for (const inst of reachable) await upsertInstallation(userId, inst);
        const keep = reachable.map((i) => String(i.id));
        await db.delete(githubInstallations).where(and(
          eq(githubInstallations.userId, userId),
          keep.length ? notInArray(githubInstallations.installationId, keep) : undefined,
        ));
      }

      return reply.redirect(`${FRONTEND_URL}/?gh=connected`);
    } catch (err) {
      console.error('[github] Install callback failed:', err);
      return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=callback_failed`);
    }
  });

  // ── GET /api/auth/github/status ─────────────────────────────────
  // Returns the current user's GitHub connection status.
  app.get('/api/auth/github/status', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const [identity] = await db.select({
      githubLogin: userGithubIdentities.githubLogin,
      avatarUrl: userGithubIdentities.avatarUrl,
      githubUserId: userGithubIdentities.githubUserId,
    })
      .from(userGithubIdentities)
      .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'github')))
      .limit(1);

    const installations = await db.select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
    })
      .from(githubInstallations)
      .where(eq(githubInstallations.userId, userId));

    return reply.send({
      connected: !!identity,
      identity: identity ?? null,
      installations,
      appConfigured: isGitHubAppConfigured(),
    });
  });

  // ── GET /api/integrations/github/repositories ────────────────────
  // List repos accessible to the user's GitHub App installation.
  app.get('/api/integrations/github/repositories', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const query = req.query as { installationId?: string };

    // If installationId provided, use it directly; otherwise use the user's first installation
    let installationId = query.installationId;

    if (!installationId) {
      const [inst] = await db.select({ installationId: githubInstallations.installationId })
        .from(githubInstallations)
        .where(eq(githubInstallations.userId, userId))
        .limit(1);

      if (!inst) {
        return reply.status(404).send({
          error: { code: 'NO_INSTALLATION', message: 'No GitHub App installation found. Connect GitHub first.' },
        });
      }
      installationId = inst.installationId;
    }

    // Listed with the user's own token: only installations and repos they
    // can reach on GitHub, whatever the request names.
    const access = await userInstallationRepos(userId, installationId);
    if ('status' in access) {
      return reply.status(access.status).send({ error: { code: access.code, message: access.message } });
    }
    return reply.send({
        installationId,
        repositories: access.repos.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          htmlUrl: r.html_url,
          description: r.description,
        })),
      });
  });

  // ── POST /api/integrations/github/repositories ───────────────────
  // Create a repository with the user's own GitHub token, in the account
  // of one of their App installations (their own account or an org). The
  // caller connects it to a map afterwards like any picked repo.
  app.post('/api/integrations/github/repositories', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
    const body = (req.body ?? {}) as { installationId?: string; name?: string; private?: boolean; description?: string };
    const name = (body.name ?? '').trim();
    if (!body.installationId || !REPO_NAME.test(name)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'installationId and a repository name (letters, digits, ".", "-", "_") are required' },
      });
    }
    const identity = await findGithubIdentity(userId);
    const token = identity ? await githubAccessTokenFor(identity).catch(() => null) : null;
    if (!identity || !token) {
      return reply.status(403).send({ error: { code: 'GITHUB_NOT_CONNECTED', message: 'Connect your GitHub account first' } });
    }

    const inst = (await listUserInstallations(token)).find((i) => String(i.id) === body.installationId);
    if (!inst) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'That GitHub App installation is not connected to your account' } });
    }
    const isOrg = inst.account.type === 'Organization';
    if (!isOrg && inst.account.login.toLowerCase() !== identity.githubLogin.toLowerCase()) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'A repository can be created in your own account or an organization' } });
    }

    let repo;
    try {
      repo = await createGitHubRepository(token, {
        name,
        private: body.private ?? true,
        description: body.description,
        ...(isOrg ? { org: inst.account.login } : {}),
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 422) {
        return reply.status(409).send({ error: { code: 'REPO_EXISTS', message: `${inst.account.login}/${name} already exists` } });
      }
      if (status === 403 || status === 404) {
        return reply.status(403).send({
          error: {
            code: 'CANNOT_CREATE',
            message: isOrg
              ? `GitHub refused to create a repository in ${inst.account.login}: you need the right to create repositories there, and the MindBlown App needs its Administration permission accepted for that installation.`
              : 'GitHub refused: the MindBlown App needs its Administration permission accepted for your installation (GitHub → Settings → Applications).',
          },
        });
      }
      console.error('[github] Create repo failed:', err);
      return reply.status(502).send({ error: { code: 'GITHUB_ERROR', message: 'Creating the repository on GitHub failed' } });
    }

    // An installation limited to selected repositories may not see the
    // new one; then the user adds it there before it can be connected.
    const access = await userInstallationRepos(userId, body.installationId);
    const reachable = !('status' in access) && access.repos.some((r) => r.full_name === repo.full_name);
    const addAccessUrl = isOrg
      ? `https://github.com/organizations/${inst.account.login}/settings/installations/${inst.id}`
      : `https://github.com/settings/installations/${inst.id}`;
    return reply.status(201).send({
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      htmlUrl: repo.html_url,
      installationId: body.installationId,
      reachable,
      ...(reachable ? {} : { addAccessUrl }),
    });
  });

  // ── POST /api/auth/github/disconnect ─────────────────────────────
  // Remove the current user's GitHub identity and installations.
  app.post('/api/auth/github/disconnect', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    await db.delete(userGithubIdentities).where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'github')));
    await db.delete(githubInstallations).where(eq(githubInstallations.userId, userId));

    return reply.send({ disconnected: true });
  });
}
