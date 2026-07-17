import type { FastifyInstance } from 'fastify';
import { computeTree } from '@mindblown/core';
import * as acceptanceDb from '../db/acceptances.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import * as permDb from '../db/permissions.js';
import { broadcast } from '../ws.js';

/**
 * Requirement acceptance (Abnahme) routes. Acceptance is the one write
 * a view-permission user may perform: it never touches the node itself,
 * only the append-only requirement_acceptances history.
 */
export async function acceptanceRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/maps/:id/acceptances — active acceptances ─────────
  app.get<{ Params: { id: string } }>('/api/maps/:id/acceptances', async (req, reply) => {
    const userId = req.userId;
    if (userId) {
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'view')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this map' },
        });
      }
    }
    return reply.send({ acceptances: await acceptanceDb.listActiveAcceptances(req.params.id) });
  });

  // ── POST /api/maps/:id/nodes/:nodeId/acceptance — verdict ──────
  // Body (optional): { decision: 'accepted' | 'rejected', comment }.
  // Default 'accepted' keeps the #218 body-less accept working.
  // Rejections require a non-empty comment — a ✗ without reasoning
  // is not actionable for anyone.
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/acceptance',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      const body = (req.body ?? {}) as { decision?: string; comment?: string };
      const decision = body.decision ?? 'accepted';
      if (decision !== 'accepted' && decision !== 'rejected') {
        return reply.status(400).send({
          error: {
            code: 'INVALID_DECISION',
            message: "decision must be 'accepted' or 'rejected'",
          },
        });
      }
      const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      if (decision === 'rejected' && comment.length === 0) {
        return reply.status(400).send({
          error: {
            code: 'REJECTION_NEEDS_COMMENT',
            message: 'Rejecting a requirement requires a comment explaining why',
          },
        });
      }
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'view')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this map' },
        });
      }

      const node = await nodeDb.getNode(req.params.nodeId);
      if (!node || node.mapId !== req.params.id) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }
      if (node.requirementId == null) {
        return reply.status(400).send({
          error: {
            code: 'NOT_A_REQUIREMENT',
            message: 'Only requirement nodes (with a requirementId) can be accepted',
          },
        });
      }

      // Snapshot the derived progress the acceptor is signing off on —
      // rollup for parents, own percentComplete for leaves.
      const data = await mapDb.getMap(req.params.id);
      let progress = node.percentComplete ?? 0;
      if (data && node.childrenIds.length > 0) {
        const computed = computeTree(data.nodes, data.map.healthThreshold);
        progress = computed.get(node.id)?.computedProgress ?? progress;
      }

      const acceptance = await acceptanceDb.accept(
        req.params.id,
        node.id,
        userId,
        progress,
        node.revision,
        decision,
        comment.length > 0 ? comment : null,
      );
      if (!acceptance) {
        return reply.status(409).send({
          error: {
            code: 'ALREADY_ACCEPTED',
            message:
              'You already have an active verdict on this requirement — revoke it first to change it',
          },
        });
      }

      broadcast(req.params.id, { type: 'acceptance:changed', nodeId: node.id });
      return reply.status(201).send(acceptance);
    },
  );

  // ── DELETE /api/maps/:id/nodes/:nodeId/acceptance — revoke own ─
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/acceptance',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'view')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this map' },
        });
      }
      const revoked = await acceptanceDb.revoke(req.params.nodeId, userId);
      if (!revoked) {
        return reply.status(404).send({
          error: { code: 'NO_ACTIVE_ACCEPTANCE', message: 'No active acceptance to revoke' },
        });
      }
      broadcast(req.params.id, { type: 'acceptance:changed', nodeId: req.params.nodeId });
      return reply.send({ success: true });
    },
  );
}
