/**
 * Fleet journal read.
 *
 *   GET /api/maps/:id/fleet-journal?from=<ISO>&to=<ISO>
 *   GET /api/fleets/:id/fleet-journal?from=<ISO>&to=<ISO>   (#479)
 *
 * What the Leidang fleet did in a window — ticks, claims, delivered nodes
 * with PR and actual effort, follow-ups created, blocked, knob writes.
 * Defaults to the trailing 24 h. The map route reads that map and its
 * fleet's ticks (view on the map). The fleet route reads every connected
 * map the reader can view, each entry naming its map, plus the fleet's
 * ticks (the fleet read rule, services/fleets.ts). Assembly is core
 * `buildFleetJournal`; the loader is `services/fleetJournal.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import * as fleetEntityDb from '../db/fleets.js';
import { getFleetForUser } from '../services/fleets.js';
import { loadFleetJournal, parseJournalWindow } from '../services/fleetJournal.js';

export async function fleetJournalRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app); // view on the map (#403)
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/maps/:id/fleet-journal', async (req, reply) => {
    const w = parseJournalWindow(req.query);
    if ('error' in w) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: w.error } });
    }
    const fleetId = await fleetEntityDb.getMapFleetId(req.params.id);
    const journal = await loadFleetJournal({ mapIds: [req.params.id], fleetId }, w.from, w.to);
    return reply.send({ journal, now: new Date().toISOString() });
  });
}

export async function fleetJournalByFleetRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/fleets/:id/fleet-journal', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const view = await getFleetForUser(req.userId, req.params.id);
    if ('status' in view) return reply.status(view.status).send({ error: { code: view.code, message: view.message } });
    const w = parseJournalWindow(req.query);
    if ('error' in w) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: w.error } });
    }
    const maps = view.maps.map((m) => ({ id: m.id, name: m.name }));
    const journal = await loadFleetJournal({ mapIds: maps.map((m) => m.id), fleetId: view.id, tagMaps: true }, w.from, w.to);
    return reply.send({ journal, maps, now: new Date().toISOString() });
  });
}
