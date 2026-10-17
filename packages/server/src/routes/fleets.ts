/**
 * Fleets (#477) — the entity several maps share.
 *
 *   GET    /api/fleets      — fleets the caller owns or whose maps they can view
 *   POST   /api/fleets      — create one; the caller becomes its owner
 *   GET    /api/fleets/:id  — one fleet (owner, or view on a connected map)
 *   PATCH  /api/fleets/:id  — rename / set the fleet cap (owner)
 *   DELETE /api/fleets/:id  — delete (owner); connected maps are disconnected (audited, broadcast)
 *
 * A map connects through PUT /api/maps/:id { fleetId } — see routes/maps.ts.
 * Fleet telemetry (rollups, ticks) still lives under /api/maps/:id until #479.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as fleetDb from '../db/fleets.js';
import * as fleetService from '../services/fleets.js';
import { broadcast } from '../ws.js';

const unauthorized = (reply: FastifyReply) =>
  reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });

const sendAccessError = (reply: FastifyReply, e: fleetService.FleetAccessError) =>
  reply.status(e.status).send({ error: { code: e.code, message: e.message } });

const isAccessError = (v: object): v is fleetService.FleetAccessError => 'status' in v && 'code' in v;

export async function fleetEntityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fleets', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    return reply.send(await fleetService.listFleetsForUser(req.userId));
  });

  app.post('/api/fleets', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const body = (req.body ?? {}) as { name?: unknown; maxActiveClaims?: unknown };
    const invalid = fleetService.validateFleetFields(body, true);
    if (invalid) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    const fleet = await fleetDb.createFleet({
      name: (body.name as string).trim(),
      ownerId: req.userId,
      maxActiveClaims: body.maxActiveClaims as number | undefined,
    });
    return reply.status(201).send({ ...fleet, maps: [], hiddenMapCount: 0, isOwner: true });
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const view = await fleetService.getFleetForUser(req.userId, req.params.id);
    return isAccessError(view) ? sendAccessError(reply, view) : reply.send(view);
  });

  app.patch<{ Params: { id: string } }>('/api/fleets/:id', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const owned = await fleetService.requireFleetOwner(req.userId, req.params.id);
    if (isAccessError(owned)) return sendAccessError(reply, owned);
    const body = (req.body ?? {}) as { name?: unknown; maxActiveClaims?: unknown };
    const invalid = fleetService.validateFleetFields(body, false);
    if (invalid) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    await fleetDb.updateFleet(req.params.id, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      maxActiveClaims: body.maxActiveClaims as number | undefined,
    });
    const view = await fleetService.getFleetForUser(req.userId, req.params.id);
    return isAccessError(view) ? sendAccessError(reply, view) : reply.send(view);
  });

  app.delete<{ Params: { id: string } }>('/api/fleets/:id', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const result = await fleetService.deleteFleetForUser(req.userId, req.params.id);
    if (!Array.isArray(result)) return sendAccessError(reply, result);
    // Open cockpits of the disconnected maps follow without a reload.
    for (const map of result) broadcast(map.id, { type: 'map:updated', map });
    return reply.status(204).send();
  });
}
