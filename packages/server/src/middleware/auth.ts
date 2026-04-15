import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * JWT authentication preHandler hook.
 * Extracts the Bearer token from Authorization header, verifies it,
 * and attaches userId to the request.
 */
async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Allow unauthenticated requests — routes check req.userId when needed
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
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

    // Apply auth to all other /api/ routes
    if (url.startsWith('/api/')) {
      return authPreHandler(req, reply);
    }
  });
}
