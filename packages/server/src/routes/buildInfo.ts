/**
 * The commit this server runs — public, for deploy probes.
 *
 *   GET /api/version → 200 { commit: "<full sha>", builtAt: "<ISO>" }
 *                    → 503 { commit: null, builtAt, error } without a git checkout
 *
 * Only the running sha: not how far behind it is (that stays signed in,
 * see services/deployDrift.ts). The sha comes from the checkout at
 * startup (services/buildInfo.ts), never from the request.
 */
import type { FastifyInstance } from 'fastify';
import { buildInfo } from '../services/buildInfo.js';

export async function buildInfoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/version', async (_req, reply) => {
    const info = await buildInfo();
    reply.header('cache-control', 'no-store');
    if (!info.commit) {
      return reply.status(503).send({ ...info, error: 'no git checkout to read the running commit from' });
    }
    return reply.send(info);
  });
}
