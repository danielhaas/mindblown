/**
 * GitHub App install + OAuth callback routes.
 *
 * Flow:
 * 1. GET /api/auth/github/install → redirects user to GitHub App install page
 * 2. GET /api/auth/github/install/callback → GitHub redirects back here with
 *    installation_id + code; we persist the installation + user OAuth identity
 * 3. GET /api/auth/github/status → check if the current user has a GitHub identity
 * 4. GET /api/integrations/github/repositories → list repos for the user's installation
 * 5. POST /api/auth/github/disconnect → remove GitHub identity
 */

import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { OAUTH_STATE_TYP } from '../auth.js';
import { db } from '../db/connection.js';
import { githubInstallations, userGithubIdentities } from '../db/schema.js';
import { encrypt } from '../crypto.js';
import { eq, and, notInArray } from 'drizzle-orm';
import { findGithubIdentity, githubAccessTokenFor } from '../lib/githubIdentity.js';
import { userHasGithubInstallation } from '../lib/githubInstallations.js';
import {
  buildInstallUrl,
  buildOAuthAuthorizeUrl,
  exchangeUserAuthorizationCode,
  getGitHubUser,
  listInstallationRepositories,
  listUserInstallations,
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
        return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=installation_unverified`);
      }

      const reachable = await listUserInstallations(userToken);
      if (query.installation_id) {
        const inst = reachable.find((i) => String(i.id) === query.installation_id);
        if (!inst) {
          return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=installation_not_yours`);
        }
        await upsertInstallation(userId, inst);
      } else {
        // OAuth-only flow: sync the full list, and drop rows the user can
        // no longer reach (uninstalled, or access removed on GitHub).
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

    if (installationId && !(await userHasGithubInstallation(userId, installationId))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'That GitHub App installation is not connected to your account' },
      });
    }

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

    try {
      const repos = await listInstallationRepositories(installationId);
      return reply.send({
        installationId,
        repositories: repos.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          htmlUrl: r.html_url,
          description: r.description,
        })),
      });
    } catch (err) {
      console.error('[github] List repos failed:', err);
      return reply.status(502).send({
        error: { code: 'GITHUB_ERROR', message: 'Failed to list repositories from GitHub' },
      });
    }
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
