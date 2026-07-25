/**
 * Orchestration substrate routes (#111).
 *
 * Thin HTTP adapter over the orchestration service module. The 4 endpoints
 * delegate to packages/server/src/services/orchestration.ts and translate
 * its thrown errors to HTTP status codes.
 *
 *   GET  /api/maps/:id/nodes/ready          — ready_nodes
 *   POST /api/maps/:id/nodes/:nodeId/claim  — claim_node
 *   POST /api/maps/:id/nodes/:nodeId/release — release_node
 *   GET  /api/maps/:id/nodes/:nodeId/conflict-scan — conflict_scan
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  readyNodes,
  claimNode,
  releaseNode,
  conflictScan,
  getNextTicket,
  ClaimOwnershipError,
  OrchestrationNotFoundError,
} from '../services/orchestration.js';

/**
 * Translate a service-layer exception to the appropriate HTTP response.
 * Re-throws anything not produced by the orchestration service so the
 * Fastify error handler sees it.
 */
function handleOrchestrationError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof OrchestrationNotFoundError) {
    return reply.status(404).send({
      error: {
        code: err.message.startsWith('Map ') ? 'MAP_NOT_FOUND' : 'NODE_NOT_FOUND',
        message: err.message,
      },
    });
  }
  if (err instanceof ClaimOwnershipError) {
    return reply.status(403).send({
      error: { code: 'CLAIM_OWNERSHIP_ERROR', message: err.message },
    });
  }
  throw err;
}

export async function orchestrationRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/maps/:id/nodes/ready — ready_nodes ─────────────
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; scope?: string };
  }>('/api/maps/:id/nodes/ready', async (req, reply) => {
    const mapId = req.params.id;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const scopeFilter = req.query.scope
      ? req.query.scope.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    try {
      const result = await readyNodes(mapId, { limit, scopeFilter });
      return reply.send(result);
    } catch (err) {
      return handleOrchestrationError(err, reply);
    }
  });

  // ── POST /api/maps/:id/nodes/:nodeId/claim — claim_node ──────
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/claim',
    async (req, reply) => {
      const { id: mapId, nodeId } = req.params;
      const body = req.body as { sessionId?: string };

      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' },
        });
      }

      try {
        const result = await claimNode(mapId, nodeId, body.sessionId);
        return reply.status(200).send(result);
      } catch (err) {
        return handleOrchestrationError(err, reply);
      }
    },
  );

  // ── POST /api/maps/:id/nodes/:nodeId/release — release_node ──
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/release',
    async (req, reply) => {
      const { id: mapId, nodeId } = req.params;
      const body = req.body as { sessionId?: string };

      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' },
        });
      }

      try {
        const result = await releaseNode(mapId, nodeId, body.sessionId);
        return reply.status(200).send(result);
      } catch (err) {
        return handleOrchestrationError(err, reply);
      }
    },
  );

  // ── POST /api/maps/:id/pull-next — get_next_ticket ────────────
  // Atomic pull for the Leidang fleet: cap gate → dispatch gate →
  // profile eligibility → policy sort → empty-brief guard → claim,
  // all serialized per map.
  app.post<{ Params: { id: string } }>(
    '/api/maps/:id/pull-next',
    async (req, reply) => {
      const mapId = req.params.id;
      const body = req.body as { sessionId?: string; profile?: string };

      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' },
        });
      }

      try {
        const result = await getNextTicket(mapId, body.sessionId, body.profile);
        return reply.status(200).send(result);
      } catch (err) {
        return handleOrchestrationError(err, reply);
      }
    },
  );

  // ── GET /api/maps/:id/conflict-scan — map-wide duplicate sweep ──
  // conflict_scan without a candidate: reports every GitHub link that
  // is attached to more than one node (the duplicate-node pattern).
  app.get<{ Params: { id: string } }>(
    '/api/maps/:id/conflict-scan',
    async (req, reply) => {
      try {
        return reply.send(await conflictScan(req.params.id));
      } catch (err) {
        return handleOrchestrationError(err, reply);
      }
    },
  );

  // ── GET /api/maps/:id/nodes/:nodeId/conflict-scan — conflict_scan ──
  app.get<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/conflict-scan',
    async (req, reply) => {
      const { id: mapId, nodeId } = req.params;

      try {
        const result = await conflictScan(mapId, nodeId);
        return reply.send(result);
      } catch (err) {
        return handleOrchestrationError(err, reply);
      }
    },
  );
}
