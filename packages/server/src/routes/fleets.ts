/**
 * Fleets (#477) — the entity several maps share.
 *
 *   GET    /api/fleets      — fleets the caller owns or whose maps they can view
 *   POST   /api/fleets      — create one; the caller becomes its owner
 *   GET    /api/fleets/:id  — one fleet (owner, or view on a connected map)
 *   PATCH  /api/fleets/:id  — rename / set the fleet cap (owner)
 *   DELETE /api/fleets/:id  — delete (owner); connected maps are disconnected (audited, broadcast)
 *   POST   /api/fleets/:id/pull-next — next ticket from any connected map the caller may edit (#478)
 *   POST   /api/fleets/:id/credentials        — issue an API key for the fleet's service user (owner, web session)
 *   GET    /api/fleets/:id/credentials        — the fleet's keys (prefix only)
 *   DELETE /api/fleets/:id/credentials/:keyId — revoke one
 *   POST   /api/fleets/:id/repo-credentials   — a connected project's repo + token (the fleet's own key, #507)
 *   GET    /api/fleets/:id/repo-handouts      — which projects' credentials it fetched, last 7 days (owner)
 *
 * A map connects through PUT /api/maps/:id { fleetId } — see routes/maps.ts;
 * connecting grants the fleet's service user edit there (#481).
 * Fleet telemetry routes: routes/fleet.ts (#479).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fleetDb from '../db/fleets.js';
import * as fleetService from '../services/fleets.js';
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../lib/apiKeys.js';
import { isAgentRequest } from '../auth.js';
import { broadcast } from '../ws.js';
import { pullFleetTicket, OrchestrationNotFoundError } from '../services/orchestration.js';
import { issueRepoCredentials } from '../services/fleetRepoAccess.js';
import { summarizeHandouts } from '../db/fleetRepoHandouts.js';

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
    // A fleet's key must not own fleets of its own (#481).
    if (await fleetDb.isFleetUser(req.userId)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'A fleet key cannot create fleets' } });
    }
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
    if (isAccessError(view)) return sendAccessError(reply, view);
    // Claims across every connected map — capacity, not which projects; the
    // Fleet tab sets it against the fleet cap (#480). Counted on this read
    // only, not in every internal fleet lookup.
    return reply.send({ ...view, activeClaims: await fleetDb.countActiveClaims(view.id) });
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

  // Fleet-wide pull (#478): the next ticket from any connected map the
  // caller may work on, narrowed to the maps the worker declares.
  app.post<{ Params: { id: string } }>('/api/fleets/:id/pull-next', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const body = (req.body ?? {}) as { sessionId?: unknown; profile?: unknown; mapIds?: unknown };
    if (typeof body.sessionId !== 'string' || body.sessionId === '') {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' } });
    }
    if (body.profile !== undefined && typeof body.profile !== 'string') {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'profile must be a string' } });
    }
    if (
      body.mapIds !== undefined &&
      (!Array.isArray(body.mapIds) || body.mapIds.length === 0 || !body.mapIds.every((id) => typeof id === 'string'))
    ) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'mapIds must be a non-empty array of map ids' } });
    }
    const scope = await fleetService.fleetPullScope(req.userId, req.params.id);
    if ('status' in scope) return sendAccessError(reply, scope);
    try {
      return reply.send(
        await pullFleetTicket(req.params.id, body.sessionId, {
          profile: body.profile as string | undefined,
          mapIds: body.mapIds as string[] | undefined,
          allowedMapIds: scope.allowedMapIds,
        }),
      );
    } catch (err) {
      if (err instanceof OrchestrationNotFoundError) {
        return reply.status(404).send({ error: { code: 'FLEET_NOT_FOUND', message: err.message } });
      }
      throw err;
    }
  });

  // ── Repo credentials (#507) ───────────────────────────────────
  // The fleet's own key fetches a connected project's repo and token, per
  // ticket. POST so nothing caches it; the token is in the body only —
  // never logged, never in status or the journal.
  app.post<{ Params: { id: string }; Body: { mapId?: unknown } }>('/api/fleets/:id/repo-credentials', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const result = await issueRepoCredentials(req.userId, req.params.id, req.body?.mapId);
    if ('status' in result) return reply.status(result.status).send({ error: { code: result.code, message: result.message } });
    return reply.header('Cache-Control', 'no-store').send(result);
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id/repo-handouts', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const owned = await fleetService.requireFleetOwner(req.userId, req.params.id);
    if (isAccessError(owned)) return sendAccessError(reply, owned);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return reply.send({ since: since.toISOString(), handouts: await summarizeHandouts(req.params.id, since) });
  });

  app.delete<{ Params: { id: string } }>('/api/fleets/:id', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const result = await fleetService.deleteFleetForUser(req.userId, req.params.id);
    if (!Array.isArray(result)) return sendAccessError(reply, result);
    // Open cockpits of the disconnected maps follow without a reload.
    for (const map of result) broadcast(map.id, { type: 'map:updated', map });
    return reply.status(204).send();
  });

  // ── Fleet credentials (#481) ──────────────────────────────────
  // API keys for the fleet's service user. Owner only, and — like
  // /api/api-keys — a signed-in session only: an API key must never mint,
  // list or revoke keys, or a leaked one becomes a lasting foothold.
  // Rotate = issue a new key, switch the clients, revoke the old one.

  app.post<{ Params: { id: string }; Body: { name?: unknown } }>('/api/fleets/:id/credentials', async (req, reply) => {
    const scope = await credentialScope(req, reply);
    if (!scope) return reply;
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : `fleet key ${new Date().toISOString().slice(0, 10)}`;
    const created = await createApiKey(scope.serviceUserId, name);
    // The plaintext key leaves the server once, here.
    return reply.status(201).send({ id: created.id, name: created.name, key: created.key, prefix: created.prefix, createdAt: created.createdAt });
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id/credentials', async (req, reply) => {
    const scope = await credentialScope(req, reply);
    if (!scope) return reply;
    return reply.send({ credentials: await listApiKeysForUser(scope.serviceUserId) });
  });

  app.delete<{ Params: { id: string; keyId: string } }>('/api/fleets/:id/credentials/:keyId', async (req, reply) => {
    const scope = await credentialScope(req, reply);
    if (!scope) return reply;
    const revoked = await revokeApiKey(scope.serviceUserId, req.params.keyId);
    if (!revoked) return reply.status(404).send({ error: { code: 'CREDENTIAL_NOT_FOUND', message: 'No active key with this id on this fleet' } });
    return reply.status(204).send();
  });
}

/** Owner of the fleet, on a web session; the fleet's service user to act for. Null = the error was sent. */
async function credentialScope(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<{ serviceUserId: string } | null> {
  if (!req.userId) {
    unauthorized(reply);
    return null;
  }
  if (isAgentRequest(req)) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'API keys and long-lived tokens cannot manage fleet keys. Sign in via the web UI to manage keys.' },
    });
    return null;
  }
  const owned = await fleetService.requireFleetOwner(req.userId, req.params.id);
  if (isAccessError(owned)) {
    sendAccessError(reply, owned);
    return null;
  }
  const serviceUserId = await fleetDb.getServiceUserId(req.params.id);
  if (!serviceUserId) {
    reply.status(409).send({ error: { code: 'NO_SERVICE_USER', message: 'This fleet has no service user' } });
    return null;
  }
  return { serviceUserId };
}
