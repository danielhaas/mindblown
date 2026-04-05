import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as permDb from '../db/permissions.js';

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps/:mapId/share — Share a map with a user ───────
  app.post<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/share',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      // Verify the requesting user has admin permission
      const callerPerm = await permDb.getPermission(req.params.mapId, userId);
      if (!permDb.hasPermission(callerPerm, 'admin')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Only admins can share maps' },
        });
      }

      const body = req.body as { email?: string; permission?: string };
      if (!body.email || !body.permission) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'email and permission are required' },
        });
      }

      if (!['view', 'edit', 'admin'].includes(body.permission)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'permission must be view, edit, or admin' },
        });
      }

      // Find user by email
      const [targetUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);

      if (!targetUser) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: `No user found with email ${body.email}` },
        });
      }

      const result = await permDb.setPermission(
        req.params.mapId,
        targetUser.id,
        body.permission as permDb.PermissionLevel,
      );

      return reply.status(201).send(result);
    },
  );

  // ── GET /api/maps/:mapId/permissions — List permissions ─────────
  app.get<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/permissions',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const callerPerm = await permDb.getPermission(req.params.mapId, userId);
      if (!permDb.hasPermission(callerPerm, 'admin')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Only admins can view permissions' },
        });
      }

      const permissions = await permDb.listPermissions(req.params.mapId);
      return reply.send(permissions);
    },
  );

  // ── DELETE /api/maps/:mapId/permissions/:userId — Revoke ────────
  app.delete<{ Params: { mapId: string; userId: string } }>(
    '/api/maps/:mapId/permissions/:userId',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const callerPerm = await permDb.getPermission(req.params.mapId, userId);
      if (!permDb.hasPermission(callerPerm, 'admin')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Only admins can revoke permissions' },
        });
      }

      const deleted = await permDb.revokePermission(req.params.mapId, req.params.userId);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: 'PERMISSION_NOT_FOUND', message: 'Permission not found' },
        });
      }

      return reply.status(204).send();
    },
  );

  // ── POST /api/maps/:mapId/public-link — Generate public link ────
  app.post<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/public-link',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        });
      }

      const callerPerm = await permDb.getPermission(req.params.mapId, userId);
      if (!permDb.hasPermission(callerPerm, 'admin')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Only admins can generate public links' },
        });
      }

      const token = await permDb.generatePublicToken(req.params.mapId);
      if (!token) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      return reply.status(201).send({ publicToken: token });
    },
  );
}
