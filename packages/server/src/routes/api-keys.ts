/**
 * Per-user API key management.
 *
 * - POST /api/api-keys      → mint a new key (plaintext returned ONCE)
 * - GET  /api/api-keys      → list current user's keys (prefix only)
 * - DELETE /api/api-keys/:id → soft-revoke
 *
 * All routes require the caller's session JWT — you cannot mint or list
 * keys via an API key itself.
 */

import type { FastifyInstance } from 'fastify';
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../lib/apiKeys.js';

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/api-keys ─────────────────────────────────────────
  app.post('/api/api-keys', async (req, reply) => {
    const userId = req.userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    // Reject session-less callers (only JWT-authed users can mint keys
    // — you cannot bootstrap a key from another key). The auth middleware
    // sets userId only when the Bearer header carried a valid session JWT,
    // not when the request was carried by an API key on /mcp.
    const authSource = (req as { authSource?: string }).authSource;
    if (authSource === 'api-key') {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'API keys cannot mint other API keys. Sign in via the web UI to manage keys.',
        },
      });
    }

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
    const userId = req.userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    const keys = await listApiKeysForUser(userId);
    return reply.send({ keys });
  });

  // ── DELETE /api/api-keys/:id ──────────────────────────────────
  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    const ok = await revokeApiKey(userId, req.params.id);
    if (!ok) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'API key not found or already revoked' },
      });
    }
    return reply.status(204).send();
  });
}
