import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as permDb from '../db/permissions.js';
import { sendMapInvitationEmail } from '../lib/email.js';

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
        .where(eq(users.email, body.email.toLowerCase()))
        .limit(1);

      const isNewUser = !targetUser;
      const response = isNewUser
        ? {
            ...(await permDb.createPendingInvite(
              req.params.mapId,
              body.email,
              body.permission as permDb.PermissionLevel,
              userId,
            )),
            pending: true as const,
          }
        : await permDb.setPermission(
            req.params.mapId,
            targetUser!.id,
            body.permission as permDb.PermissionLevel,
          );

      // Fire-and-forget invitation email. Errors are logged inside the
      // helper; the API response succeeds either way.
      void sendMapInvitationEmail({
        mapId: req.params.mapId,
        inviterId: userId,
        recipientEmail: body.email,
        isNewUser,
      }).catch((err) => console.warn('[share] Email not sent:', err));

      return reply.status(201).send(response);
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
      const pendingInvites = await permDb.listPendingInvites(req.params.mapId);
      return reply.send({ permissions, pendingInvites });
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

  // ── DELETE /api/maps/:mapId/invites/:email — Cancel pending invite ──
  app.delete<{ Params: { mapId: string; email: string } }>(
    '/api/maps/:mapId/invites/:email',
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
          error: { code: 'FORBIDDEN', message: 'Only admins can cancel invites' },
        });
      }

      const deleted = await permDb.revokePendingInvite(
        req.params.mapId,
        decodeURIComponent(req.params.email),
      );
      if (!deleted) {
        return reply.status(404).send({
          error: { code: 'INVITE_NOT_FOUND', message: 'Pending invite not found' },
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
