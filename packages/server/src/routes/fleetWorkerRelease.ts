/**
 * GET /api/fleet/worker-release — the claude-fleet commit a worker without
 * a GitHub token may self-update to (claude-fleet #120, worker/README.md
 * "No token: MindBlown says which commit is green").
 *
 *   200 → { sha, green: true, checkedAt }
 *   503 → { error, checkedAt } — nothing green / forge unreachable; the worker stays put
 *
 * Auth: a fleet key (a fleet's service user). Rules in services/fleetWorkerRelease.ts.
 */
import type { FastifyInstance } from 'fastify';
import { isFleetUser } from '../db/fleets.js';
import { latestGreenWorkerCommit } from '../services/fleetWorkerRelease.js';

export async function fleetWorkerReleaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fleet/worker-release', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    if (!(await isFleetUser(req.userId))) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only a fleet key asks for the worker release' } });
    }
    const answer = await latestGreenWorkerCommit();
    return 'sha' in answer ? reply.send(answer) : reply.status(503).send(answer);
  });
}
