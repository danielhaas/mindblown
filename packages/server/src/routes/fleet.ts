/**
 * Leidang fleet telemetry routes.
 *
 *   PUT  /api/maps/:id/fleet-status/:host  — satellite rollup (rollup.sh, every ~2 min)
 *   POST /api/maps/:id/fleet-ticks         — orchestrator decision (every ~30 min)
 *   GET  /api/maps/:id/fleet               — what the cockpit's Fleet card renders
 *
 * Auth model mirrors the orchestration routes the same callers already
 * use (pull-next, claim, release): map-scoped, no per-route permission
 * check — satellites push without a token today. Payloads are stored
 * verbatim after a minimal shape check; the reading (staleness, dead
 * workers, silent satellites) is core `fleet.ts`, shared with the card.
 */
import type { FastifyInstance } from 'fastify';
import { parseRollup, parseTick } from '@mindblown/core';
import * as fleetDb from '../db/fleet.js';
import { broadcast } from '../ws.js';

const TICK_LIST_LIMIT = 20;

export async function fleetRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { id: string; host: string } }>('/api/maps/:id/fleet-status/:host', async (req, reply) => {
    const rollup = parseRollup(req.body);
    if (!rollup) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Body must be a rollup v1 document: host, generated_at (ISO), workers[]' },
      });
    }
    if (rollup.host !== req.params.host) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `URL host "${req.params.host}" does not match body host "${rollup.host}"` },
      });
    }
    if (rollup.map_id && rollup.map_id !== req.params.id) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Rollup is for map ${rollup.map_id}, not ${req.params.id}` },
      });
    }
    let row;
    try {
      row = await fleetDb.upsertRollup(req.params.id, rollup);
    } catch (err) {
      // FK violation = unknown map. Anything else is a real error.
      if ((err as { code?: string }).code === '23503') {
        return reply.status(404).send({ error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` } });
      }
      throw err;
    }
    broadcast(req.params.id, { type: 'fleet:updated', kind: 'rollup', host: row.host, receivedAt: row.receivedAt });
    return reply.send({ host: row.host, generatedAt: row.generatedAt, receivedAt: row.receivedAt, workers: rollup.workers.length });
  });

  app.post<{ Params: { id: string } }>('/api/maps/:id/fleet-ticks', async (req, reply) => {
    const payload = parseTick(req.body);
    if (!payload) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Body must be a decision object' } });
    }
    const at = typeof (req.body as { tickAt?: unknown }).tickAt === 'string' ? new Date((req.body as { tickAt: string }).tickAt) : new Date();
    const tickAt = Number.isNaN(at.getTime()) ? new Date() : at;
    let row;
    try {
      row = await fleetDb.insertTick(req.params.id, payload, tickAt);
    } catch (err) {
      if ((err as { code?: string }).code === '23503') {
        return reply.status(404).send({ error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` } });
      }
      throw err;
    }
    broadcast(req.params.id, { type: 'fleet:updated', kind: 'tick', tickAt: row.tickAt });
    return reply.status(201).send({ id: row.id, tickAt: row.tickAt, receivedAt: row.receivedAt });
  });

  app.get<{ Params: { id: string } }>('/api/maps/:id/fleet', async (req, reply) => {
    const [hosts, ticks] = await Promise.all([fleetDb.listRollups(req.params.id), fleetDb.listTicks(req.params.id, TICK_LIST_LIMIT)]);
    return reply.send({ hosts, ticks, now: new Date().toISOString() });
  });
}
