import type { FastifyInstance } from 'fastify';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps/:id/nodes — Create a node ─────────────────
  app.post<{ Params: { id: string } }>('/api/maps/:id/nodes', async (req, reply) => {
    const body = req.body as {
      parentId: string;
      text: string;
      createdBy: string;
      position?: number;
      effortEstimate?: number;
      percentComplete?: number;
      status?: string;
      priority?: 'P0' | 'P1' | 'P2' | 'P3';
      startDate?: string;
      dueDate?: string;
      isMilestone?: boolean;
    };

    if (!body.parentId || !body.text || !body.createdBy) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'parentId, text, and createdBy are required' },
      });
    }

    const node = await nodeDb.createNode({
      ...body,
      mapId: req.params.id,
    });

    // Broadcast to connected clients
    broadcast(req.params.id, { type: 'node:created', node });

    return reply.status(201).send(node);
  });

  // ── PUT /api/maps/:id/nodes/reorder — Reorder children ───────
  // NOTE: Must be registered BEFORE the parametric /:nodeId routes
  // so that "reorder" is matched as a static segment, not a param.
  app.put<{ Params: { id: string } }>(
    '/api/maps/:id/nodes/reorder',
    async (req, reply) => {
      const body = req.body as { parentId: string; childrenIds: string[] };

      if (!body.parentId || !Array.isArray(body.childrenIds)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'parentId and childrenIds are required' },
        });
      }

      const success = await nodeDb.reorderChildren(body.parentId, body.childrenIds);
      if (!success) {
        return reply.status(400).send({
          error: { code: 'REORDER_FAILED', message: 'Invalid parent or children IDs' },
        });
      }

      broadcast(req.params.id, {
        type: 'node:reordered',
        parentId: body.parentId,
        childrenIds: body.childrenIds,
      });

      return reply.send({ success: true });
    },
  );

  // ── PUT /api/maps/:id/nodes/:nodeId — Update a node ──────────
  app.put<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId',
    async (req, reply) => {
      const body = req.body as nodeDb.UpdateNodeInput;

      const updated = await nodeDb.updateNode(req.params.nodeId, body);
      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      // Broadcast the change
      broadcast(req.params.id, {
        type: 'node:updated',
        nodeId: req.params.nodeId,
        fields: Object.keys(body),
        node: updated,
      });

      return reply.send(updated);
    },
  );

  // ── DELETE /api/maps/:id/nodes/:nodeId — Delete a node ────────
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId',
    async (req, reply) => {
      const deletedIds = await nodeDb.deleteNode(req.params.nodeId);
      if (deletedIds.length === 0) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      broadcast(req.params.id, {
        type: 'node:deleted',
        nodeId: req.params.nodeId,
        deletedIds,
      });

      return reply.status(204).send();
    },
  );

  // ── PUT /api/maps/:id/nodes/:nodeId/move — Move a node ───────
  app.put<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/move',
    async (req, reply) => {
      const body = req.body as { newParentId: string; position?: number };

      if (!body.newParentId) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'newParentId is required' },
        });
      }

      const moved = await nodeDb.moveNode(
        req.params.nodeId,
        body.newParentId,
        body.position,
      );

      if (!moved) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      broadcast(req.params.id, {
        type: 'node:moved',
        nodeId: req.params.nodeId,
        newParentId: body.newParentId,
        position: body.position,
      });

      return reply.send(moved);
    },
  );
}
