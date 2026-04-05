import type { FastifyInstance } from 'fastify';
import * as commentDb from '../db/comments.js';
import { broadcast } from '../ws.js';

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps/:mapId/nodes/:nodeId/comments — Add comment ──
  app.post<{ Params: { mapId: string; nodeId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/comments',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const body = req.body as { text?: string };
      if (!body.text) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'text is required' },
        });
      }

      const comment = await commentDb.createComment({
        nodeId: req.params.nodeId,
        userId,
        text: body.text,
      });

      // Broadcast to connected clients
      broadcast(req.params.mapId, {
        type: 'comment:created',
        nodeId: req.params.nodeId,
        comment,
      });

      return reply.status(201).send(comment);
    },
  );

  // ── GET /api/maps/:mapId/nodes/:nodeId/comments — List comments ─
  app.get<{ Params: { mapId: string; nodeId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/comments',
    async (req, reply) => {
      const allComments = await commentDb.listComments(req.params.nodeId);
      return reply.send(allComments);
    },
  );

  // ── PUT /api/comments/:id — Edit comment (author only) ──────────
  app.put<{ Params: { id: string } }>(
    '/api/comments/:id',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const body = req.body as { text?: string };
      if (!body.text) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'text is required' },
        });
      }

      const existing = await commentDb.getComment(req.params.id);
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'COMMENT_NOT_FOUND', message: `Comment ${req.params.id} not found` },
        });
      }

      if (existing.userId !== userId) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You can only edit your own comments' },
        });
      }

      const updated = await commentDb.updateComment(req.params.id, body.text);
      return reply.send(updated);
    },
  );

  // ── DELETE /api/comments/:id — Delete comment (author only) ─────
  app.delete<{ Params: { id: string } }>(
    '/api/comments/:id',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const existing = await commentDb.getComment(req.params.id);
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'COMMENT_NOT_FOUND', message: `Comment ${req.params.id} not found` },
        });
      }

      if (existing.userId !== userId) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You can only delete your own comments' },
        });
      }

      await commentDb.deleteComment(req.params.id);
      return reply.status(204).send();
    },
  );
}
