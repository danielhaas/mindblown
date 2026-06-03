/**
 * Per-user API key management.
 *
 * - POST   /api/api-keys      → mint a new key (plaintext returned ONCE)
 * - GET    /api/api-keys      → list current user's keys (prefix only)
 * - DELETE /api/api-keys/:id  → soft-revoke
 *
 * All routes require the caller's session JWT — you cannot mint, list,
 * OR revoke keys via an API key itself. The guard is centralised in
 * `requireSessionAuth` below; a leaked `mb_…` key would otherwise be
 * able to enumerate (GET) or revoke-all (DELETE) the legit user's other
 * keys, even though it can't mint new ones.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../lib/apiKeys.js';

/**
 * Require an interactive session for any /api/api-keys mutation OR read.
 * Returns true if the request may proceed; otherwise writes the 401/403
 * response onto `reply` and returns false.
 *
 * The security invariant: API keys can NEVER read, mint, or revoke other
 * API keys. An attacker with a leaked `mb_…` key must not be able to
 * enumerate the user's other keys (GET) or lock them out (DELETE) — only
 * web-session-auth (the JWT login flow) reaches these routes.
 */
function requireSessionAuth(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.userId;
  if (!userId) {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return null;
  }
  if (req.authSource === 'api-key') {
    reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'API keys cannot manage other API keys. Sign in via the web UI to manage keys.',
      },
    });
    return null;
  }
  return userId;
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/api-keys ─────────────────────────────────────────
  app.post('/api/api-keys', async (req, reply) => {
    const userId = requireSessionAuth(req, reply);
    if (!userId) return reply;

    const body = req.body as { name?: string; expiresInDays?: number };
    const name = (body.name ?? '').trim();
    if (!name) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name is required' },
      });
    }
    if (name.length > 100) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name must be ≤ 100 characters' },
      });
    }
    const expiresInDays = body.expiresInDays;
    if (
      expiresInDays !== undefined &&
      (typeof expiresInDays !== 'number' || expiresInDays <= 0 || expiresInDays > 3650)
    ) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'expiresInDays must be a positive number ≤ 3650',
        },
      });
    }

    const created = await createApiKey(userId, name, expiresInDays);
    return reply.status(201).send({
      id: created.id,
      name: created.name,
      key: created.key, // ONLY time we return plaintext
      prefix: created.prefix,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    });
  });

  // ── GET /api/api-keys ─────────────────────────────────────────
  app.get('/api/api-keys', async (req, reply) => {
    const userId = requireSessionAuth(req, reply);
    if (!userId) return reply;
    const keys = await listApiKeysForUser(userId);
    return reply.send({ keys });
  });

  // ── DELETE /api/api-keys/:id ──────────────────────────────────
  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', async (req, reply) => {
    const userId = requireSessionAuth(req, reply);
    if (!userId) return reply;
    const ok = await revokeApiKey(userId, req.params.id);
    if (!ok) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'API key not found or already revoked' },
      });
    }
    return reply.status(204).send();
  });
}
