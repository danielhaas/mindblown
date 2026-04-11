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
import { db } from '../db/connection.js';
import { githubInstallations, userGithubIdentities } from '../db/schema.js';
import { encrypt } from '../crypto.js';
import { eq, and } from 'drizzle-orm';
import {
  buildInstallUrl,
  exchangeUserAuthorizationCode,
  getGitHubUser,
  getInstallationDetails,
  listInstallationRepositories,
  isGitHubAppConfigured,
} from '@mindblown/integrations';

const JWT_SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

interface StatePayload {
  userId: string;
  nonce: string;
}

function signState(userId: string): string {
  const nonce = Math.random().toString(36).slice(2);
  return jwt.sign({ userId, nonce } satisfies StatePayload, JWT_SECRET, { expiresIn: '15m' });
}

function verifyState(token: string): StatePayload {
  return jwt.verify(token, JWT_SECRET) as StatePayload;
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

    if (!query.installation_id) {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&reason=missing_installation`);
    }

    try {
      // Fetch installation details from GitHub
      const installation = await getInstallationDetails(query.installation_id);

      // Upsert the installation record
      const existing = await db.select({ id: githubInstallations.id })
        .from(githubInstallations)
        .where(and(
          eq(githubInstallations.userId, userId),
          eq(githubInstallations.installationId, query.installation_id),
        ))
        .limit(1);

      if (existing.length > 0) {
        await db.update(githubInstallations)
          .set({
            accountLogin: installation.account.login,
            accountType: installation.account.type,
            accountId: String(installation.account.id),
            updatedAt: new Date(),
          })
          .where(eq(githubInstallations.id, existing[0].id));
      } else {
        await db.insert(githubInstallations).values({
          userId,
          installationId: query.installation_id,
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          accountId: String(installation.account.id),
        });
      }

      // If we got an OAuth code, exchange it for user tokens
      if (query.code) {
        const tokens = await exchangeUserAuthorizationCode(query.code);
        const ghUser = await getGitHubUser(tokens.accessToken);

        // Upsert user GitHub identity
        const existingIdentity = await db.select({ id: userGithubIdentities.id })
          .from(userGithubIdentities)
          .where(eq(userGithubIdentities.userId, userId))
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
      .where(eq(userGithubIdentities.userId, userId))
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

    await db.delete(userGithubIdentities).where(eq(userGithubIdentities.userId, userId));
    await db.delete(githubInstallations).where(eq(githubInstallations.userId, userId));

    return reply.send({ disconnected: true });
  });
}
