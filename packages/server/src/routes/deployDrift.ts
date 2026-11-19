/**
 * Merged, not deployed — for the Fleet tab (services/deployDrift.ts).
 *
 *   GET /api/maps/:id/deploy-drift → { drift: { sha, undeployed, undeployedSince, checkedAt, commits } | null }
 *
 * Null for every map not bound to the repo this server runs from.
 */
import type { FastifyInstance } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { deployDriftForMap } from '../services/deployDrift.js';

export async function deployDriftRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app);

  app.get<{ Params: { id: string } }>('/api/maps/:id/deploy-drift', async (req, reply) => {
    return reply.send({ drift: await deployDriftForMap(req.params.id) });
  });
}
