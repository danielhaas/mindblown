/**
 * Fleet journal read.
 *
 *   GET /api/maps/:id/fleet-journal?from=<ISO>&to=<ISO>
 *
 * What the Leidang fleet did in a window — ticks, claims, delivered nodes
 * with PR and actual effort, follow-ups created, blocked, knob writes.
 * Defaults to the trailing 24 h. Same auth model as the other fleet reads
 * (map-scoped, no per-route check). Assembly is core `buildFleetJournal`;
 * the loader is `services/fleetJournal.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { loadFleetJournal, parseJournalWindow } from '../services/fleetJournal.js';

export async function fleetJournalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/maps/:id/fleet-journal', async (req, reply) => {
    const w = parseJournalWindow(req.query);
    if ('error' in w) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: w.error } });
    }
    const journal = await loadFleetJournal(req.params.id, w.from, w.to);
    return reply.send({ journal, now: new Date().toISOString() });
  });
}
