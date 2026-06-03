import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../auth.js';
import { API_KEY_PREFIX, validateApiKey } from '../lib/apiKeys.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    /** How the request was authenticated. Routes that mutate auth state (e.g.
     * minting more API keys) consult this so a leaked key can't bootstrap
     * fresh keys. */
    authSource?: 'jwt' | 'api-key';
  }
}

/**
 * JWT (or API-key) authentication preHandler hook.
 *
 * Extracts the Bearer token from the Authorization header. If it starts with
 * the `mb_` API-key prefix, it's looked up as an API key; otherwise it's
 * treated as a session JWT. On success, attaches `userId` + `authSource` to
 * the request.
 */
async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Allow unauthenticated requests — routes check req.userId when needed
    return;
  }

  const token = authHeader.slice(7);

  if (token.startsWith(API_KEY_PREFIX)) {
    const result = await validateApiKey(token);
    if (!result) {
      return reply.status(401).send({
        error: { code: 'INVALID_API_KEY', message: 'Invalid or revoked API key' },
      });
    }
    req.userId = result.userId;
    req.authSource = 'api-key';
    return;
  }

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    req.authSource = 'jwt';
  } catch {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
  }
}

/**
 * Register the auth middleware on all protected routes.
 * Skips /api/auth/* and /api/health.
 */
export async function registerAuthMiddleware(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url;

    // Skip auth for public routes
    if (
      url.startsWith('/api/auth/register') ||
      url.startsWith('/api/auth/login') ||
      url.startsWith('/api/auth/github/install/callback') ||
      url.startsWith('/api/health') ||
      url.startsWith('/api/webhooks/') ||
      url.startsWith('/ws/') ||
      // Calendar feeds authenticate via a per-map HMAC token on the
      // query string — external calendar clients (Google, Apple,
      // Outlook) can't send Bearer headers.
      /\/api\/maps\/[^/]+\/calendar\.ics(\?|$)/.test(url)
    ) {
      return;
    }

    // /mcp does its own auth + returns JSON-RPC-shaped errors. We skip the
    // generic middleware so a 401 there isn't the {error:{code,message}}
    // shape that confuses MCP clients.
    if (url.startsWith('/mcp')) {
      return;
    }

    // Apply auth to all /api/ routes.
    if (url.startsWith('/api/')) {
      return authPreHandler(req, reply);
    }
  });
}
