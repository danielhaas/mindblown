import type { FastifyInstance } from 'fastify';
import * as commentDb from '../db/comments.js';
import * as nodeDb from '../db/nodes.js';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { broadcast } from '../ws.js';
import { ackFleetNote, isCommentError, parseCommentFilter, parseCommentKind, type CommentError } from '../services/comments.js';

const sendError = (reply: import('fastify').FastifyReply, e: CommentError) =>
  reply.status(e.status).send({ error: { code: e.code, message: e.message } });

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  // The map-scoped routes: view to read, edit to write, 404 for a node on
  // another map (#403). The /api/comments/:id routes stay login-only.
  guardMapRoutes(app, { nodeMapId: (id) => nodeDb.getNodeMapId(id) });
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

      const body = (req.body ?? {}) as { text?: string; kind?: unknown };
      if (!body.text) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'text is required' },
        });
      }
      // 'comment' (default) or 'fleet-note' — a note to the agent running the ticket.
      const kind = parseCommentKind(body.kind);
      if (isCommentError(kind)) return sendError(reply, kind);

      const comment = await commentDb.createComment({
        nodeId: req.params.nodeId,
        userId,
        text: body.text,
        kind,
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
  // ?kind=fleet-note&since=<iso>: the fleet worker's cheap poll for new notes.
  app.get<{ Params: { mapId: string; nodeId: string }; Querystring: { kind?: string; since?: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/comments',
    async (req, reply) => {
      const filter = parseCommentFilter(req.query ?? {});
      if (isCommentError(filter)) return sendError(reply, filter);
      const allComments = await commentDb.listComments(req.params.nodeId, filter);
      return reply.send(allComments);
    },
  );

  // ── PATCH /api/maps/:mapId/nodes/:nodeId/comments/:commentId — Fleet note picked up ─
  // Body `{ deliveredAt?: iso }` (default now). Edit on the map, like writing one.
  app.patch<{ Params: { mapId: string; nodeId: string; commentId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/comments/:commentId',
    async (req, reply) => {
      const body = (req.body ?? {}) as { deliveredAt?: unknown };
      const comment = await ackFleetNote(req.params.nodeId, req.params.commentId, body.deliveredAt);
      if (isCommentError(comment)) return sendError(reply, comment);
      broadcast(req.params.mapId, {
        type: 'comment:updated',
        nodeId: req.params.nodeId,
        comment,
      });
      return reply.send(comment);
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
