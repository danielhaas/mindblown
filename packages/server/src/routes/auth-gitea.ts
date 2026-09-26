/**
 * Gitea / Forgejo sign-in + repo picker (#369) — parity with the GitHub App
 * install flow for a self-hosted forge, without a PAT:
 *
 *   GET  /api/auth/gitea/authorize        → { authorizeUrl }  (browser goes there)
 *   GET  /api/auth/gitea/callback         ← Gitea redirects with ?code&state
 *   GET  /api/auth/gitea/status           → { configured, connected, identity }
 *   GET  /api/integrations/gitea/repositories → repos the signed-in user can see
 *   POST /api/integrations/gitea/bind     { workspaceId, owner, repo, webhookSecret? }
 *   POST /api/auth/gitea/disconnect
 *
 * The binding is the workspace's forge row (`integrations`, provider
 * `gitea`) with `config.oauthIdentityId` instead of a PAT; the sync layer
 * refreshes the user's token as needed (lib/giteaOAuth.ts). The instance
 * comes from `GITEA_URL` on the server — the user never types a URL, so
 * this path needs no admin gate.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import {
  exchangeGiteaAuthorizationCode,
  getGiteaUser,
  giteaAuthorizeUrl,
  giteaEndpoint,
  giteaUserForge,
  listGiteaUserRepos,
} from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { integrations, mapPermissions, maps, userGithubIdentities, workspaces } from '../db/schema.js';
import { encrypt } from '../crypto.js';
import { requireAdmin, OAUTH_STATE_TYP } from '../auth.js';
import { FORGE_PROVIDERS, type ForgeIntegrationConfig } from '../lib/forge.js';
import {
  findGiteaIdentity,
  giteaAccessTokenFor,
  giteaOAuthApp,
  isGiteaOAuthConfigured,
} from '../lib/giteaOAuth.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'mindblown-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5180';

interface StatePayload {
  userId: string;
  nonce: string;
  kind: 'gitea';
  /** Marks this as an OAuth state token, never a bearer (#397). */
  typ: typeof OAUTH_STATE_TYP;
}

function signState(userId: string): string {
  const nonce = randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce, kind: 'gitea', typ: OAUTH_STATE_TYP } satisfies StatePayload, JWT_SECRET, { expiresIn: '15m' });
}

function verifyState(token: string): StatePayload {
  const payload = jwt.verify(token, JWT_SECRET) as StatePayload;
  if (payload.typ !== OAUTH_STATE_TYP) throw new Error('not an OAuth state token');
  if (payload.kind !== 'gitea') throw new Error('state is not a gitea flow');
  return payload;
}

// The state alone would let anyone who saw it (proxy log, Gitea's request
// log, a screen) finish the flow from their own browser and bind the
// victim's MindBlown account to *their* Gitea identity. Bind the state to
// the browser that started it: the nonce also travels in an httpOnly
// cookie scoped to the callback path, and the callback demands both.
const NONCE_COOKIE = 'mb_gitea_oauth';

/**
 * May this user (re)bind the workspace's forge? Admins, the workspace
 * owner, and anyone holding `admin` permission on a map of the workspace.
 * Without this any signed-in user could point another workspace's sync at
 * their own repository. Also gates the status binding lookup, so the
 * bound repo of a foreign workspace is not readable by id.
 */
async function canManageWorkspaceForge(
  req: { userId?: string; authSource?: 'jwt' | 'api-key' },
  workspaceId: string,
): Promise<boolean> {
  const userId = req.userId;
  if (!userId) return false;
  if (await requireAdmin(req)) return true;
  const [ws] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) return false;
  if (ws.ownerId === userId) return true;
  const [perm] = await db
    .select({ mapId: mapPermissions.mapId })
    .from(mapPermissions)
    .innerJoin(maps, eq(maps.id, mapPermissions.mapId))
    .where(and(eq(maps.workspaceId, workspaceId), eq(mapPermissions.userId, userId), eq(mapPermissions.permission, 'admin')))
    .limit(1);
  return !!perm;
}

function nonceCookie(nonce: string, clear = false): string {
  // Same origin rule as giteaOAuthApp(): PUBLIC_URL, else FRONTEND_URL.
  const secure = (giteaOAuthApp()?.redirectUri ?? '').startsWith('https://') ? '; Secure' : '';
  const maxAge = clear ? 0 : 15 * 60;
  return `${NONCE_COOKIE}=${clear ? '' : nonce}; Path=/api/auth/gitea; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readNonceCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === NONCE_COOKIE) return v.join('=') || null;
  }
  return null;
}

export async function giteaAuthRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/auth/gitea/authorize ────────────────────────────────
  app.get('/api/auth/gitea/authorize', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Must be logged in to connect Gitea' } });
    }
    const oauth = giteaOAuthApp();
    if (!oauth) {
      return reply.status(503).send({
        error: { code: 'GITEA_NOT_CONFIGURED', message: 'Gitea OAuth is not configured on this server (GITEA_URL, GITEA_OAUTH_CLIENT_ID, GITEA_OAUTH_CLIENT_SECRET, PUBLIC_URL)' },
      });
    }
    const state = signState(userId);
    const { nonce } = jwt.decode(state) as StatePayload;
    reply.header('Set-Cookie', nonceCookie(nonce));
    return reply.send({ authorizeUrl: giteaAuthorizeUrl(oauth, state), instanceUrl: oauth.instanceUrl });
  });

  // ── GET /api/auth/gitea/callback ─────────────────────────────────
  app.get('/api/auth/gitea/callback', async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (!query.state) return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=missing_state`);
    let state: StatePayload;
    try {
      state = verifyState(query.state);
    } catch {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=invalid_state`);
    }
    if (readNonceCookie(req.headers.cookie) !== state.nonce) {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=state_not_from_this_browser`);
    }
    reply.header('Set-Cookie', nonceCookie('', true));
    if (query.error || !query.code) {
      return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=${encodeURIComponent(query.error ?? 'missing_code')}`);
    }
    const oauth = giteaOAuthApp();
    if (!oauth) return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=not_configured`);

    try {
      const tokens = await exchangeGiteaAuthorizationCode(oauth, query.code);
      const me = await getGiteaUser(giteaUserForge(oauth.instanceUrl, tokens.accessToken));
      const values = {
        githubUserId: String(me.id),
        githubLogin: me.login,
        avatarUrl: me.avatar_url ?? null,
        encryptedAccessToken: encrypt(tokens.accessToken),
        encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
        tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        scopes: tokens.scope,
        updatedAt: new Date(),
      };
      const existing = await findGiteaIdentity(state.userId);
      if (existing) {
        await db.update(userGithubIdentities).set(values).where(eq(userGithubIdentities.id, existing.id));
      } else {
        await db.insert(userGithubIdentities).values({ userId: state.userId, kind: 'gitea', ...values });
      }
      return reply.redirect(`${FRONTEND_URL}/?gh=connected&forge=gitea`);
    } catch (err) {
      console.error('[gitea-oauth] callback failed:', err instanceof Error ? err.message : err);
      return reply.redirect(`${FRONTEND_URL}/?gh=error&forge=gitea&reason=callback_failed`);
    }
  });

  // ── GET /api/auth/gitea/status ───────────────────────────────────
  // `?workspaceId=` adds the workspace's current OAuth-bound repository (if
  // any) so the panel can show "syncs with owner/repo" on reopen.
  app.get('/api/auth/gitea/status', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const oauth = giteaOAuthApp();
    const identity = oauth ? await findGiteaIdentity(userId) : null;
    const { workspaceId } = req.query as { workspaceId?: string };
    let binding: { repo: string; viaThisIdentity: boolean } | null = null;
    if (workspaceId && oauth && (await canManageWorkspaceForge(req as { userId?: string }, workspaceId))) {
      const [row] = await db
        .select({ config: integrations.config, enabled: integrations.enabled })
        .from(integrations)
        .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'gitea')))
        .limit(1);
      const cfg = row?.config as ForgeIntegrationConfig | undefined;
      if (row?.enabled && cfg?.oauthIdentityId) {
        binding = { repo: `${cfg.owner}/${cfg.repo}`, viaThisIdentity: !!identity && cfg.oauthIdentityId === identity.id };
      }
    }
    return reply.send({
      configured: !!oauth,
      instanceUrl: oauth?.instanceUrl ?? null,
      connected: !!identity,
      identity: identity ? { login: identity.githubLogin } : null,
      binding,
    });
  });

  // ── GET /api/integrations/gitea/repositories ─────────────────────
  app.get('/api/integrations/gitea/repositories', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const oauth = giteaOAuthApp();
    if (!oauth) return reply.status(503).send({ error: { code: 'GITEA_NOT_CONFIGURED', message: 'Gitea OAuth is not configured' } });
    const identity = await findGiteaIdentity(userId);
    if (!identity) {
      return reply.status(404).send({ error: { code: 'NO_IDENTITY', message: 'Sign in with Gitea first.' } });
    }
    try {
      const token = await giteaAccessTokenFor(identity);
      const repos = await listGiteaUserRepos(giteaUserForge(oauth.instanceUrl, token));
      return reply.send({
        instanceUrl: oauth.instanceUrl,
        login: identity.githubLogin,
        repositories: repos.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          htmlUrl: r.html_url,
          description: r.description,
          canPush: r.permissions?.push ?? null,
        })),
      });
    } catch (err) {
      console.error('[gitea-oauth] list repos failed:', err instanceof Error ? err.message : err);
      return reply.status(502).send({ error: { code: 'GITEA_ERROR', message: err instanceof Error ? err.message : 'Failed to list repositories' } });
    }
  });

  // ── POST /api/integrations/gitea/bind ────────────────────────────
  // Bind a workspace to one of the signed-in user's repositories. Upserts
  // the workspace's forge row (one forge per workspace, like `connect`).
  app.post('/api/integrations/gitea/bind', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const body = req.body as { workspaceId?: string; owner?: string; repo?: string; webhookSecret?: string };
    if (!body.workspaceId || !body.owner || !body.repo) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'workspaceId, owner and repo are required' } });
    }
    const oauth = giteaOAuthApp();
    if (!oauth) return reply.status(503).send({ error: { code: 'GITEA_NOT_CONFIGURED', message: 'Gitea OAuth is not configured' } });
    if (!(await canManageWorkspaceForge(req as { userId?: string; authSource?: 'jwt' | 'api-key' }, body.workspaceId))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Only the workspace owner, a map admin of this workspace, or a MindBlown admin may bind its repository' },
      });
    }
    const identity = await findGiteaIdentity(userId);
    if (!identity) return reply.status(404).send({ error: { code: 'NO_IDENTITY', message: 'Sign in with Gitea first.' } });

    // The repo must be one the user can actually reach.
    try {
      const token = await giteaAccessTokenFor(identity);
      await giteaUserForge(oauth.instanceUrl, token).requestJson(`/repos/${body.owner}/${body.repo}`);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'REPO_UNREACHABLE', message: `${body.owner}/${body.repo}: ${err instanceof Error ? err.message : String(err)}` },
      });
    }

    const endpoint = giteaEndpoint(oauth.instanceUrl);
    const config: ForgeIntegrationConfig = {
      owner: body.owner,
      repo: body.repo,
      token: '',
      oauthIdentityId: identity.id,
      apiBaseUrl: endpoint.apiBaseUrl,
      webBaseUrl: endpoint.webBaseUrl,
      ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
    };
    const [existing] = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, body.workspaceId), inArray(integrations.provider, FORGE_PROVIDERS)))
      .limit(1);
    if (existing) {
      await db
        .update(integrations)
        .set({ provider: 'gitea', config, enabled: true, updatedAt: new Date() })
        .where(eq(integrations.id, existing.id));
      return reply.send({ id: existing.id, provider: 'gitea', enabled: true, repo: `${body.owner}/${body.repo}` });
    }
    const [row] = await db
      .insert(integrations)
      .values({ workspaceId: body.workspaceId, provider: 'gitea', config, enabled: true })
      .returning();
    return reply.status(201).send({ id: row.id, provider: 'gitea', enabled: true, repo: `${body.owner}/${body.repo}` });
  });

  // ── POST /api/auth/gitea/disconnect ──────────────────────────────
  // Removes the identity. Bindings that relied on it stop resolving a
  // token (logged and skipped by the sync) until someone signs in again
  // or connects with a PAT.
  app.post('/api/auth/gitea/disconnect', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    await db
      .delete(userGithubIdentities)
      .where(and(eq(userGithubIdentities.userId, userId), eq(userGithubIdentities.kind, 'gitea')));
    return reply.send({ disconnected: true });
  });
}
