import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import * as versionDb from '../db/versions.js';
import * as cycleDb from '../db/cycles.js';
import * as permDb from '../db/permissions.js';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
  });
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/versions — Create a version ──────────────────────
  app.post('/api/versions', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const body = req.body as versionDb.CreateVersionInput;

    if (!body.mapId || !body.name) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and name are required' },
      });
    }

    const [map] = await db.select().from(maps).where(eq(maps.id, body.mapId));
    if (!map) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    const perm = await permDb.getPermission(body.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    const version = await versionDb.createVersion(body);
    // #331: order lint rides along with the write. Never a reject.
    const warnings = await versionDb.orderWarnings(version.mapId);
    return reply.status(201).send({ ...version, warnings });
  });

  // ── GET /api/versions — List versions for a map ────────────────
  app.get('/api/versions', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const { mapId } = req.query as { mapId?: string };

    if (!mapId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId query parameter is required' },
      });
    }

    const perm = await permDb.getPermission(mapId, userId);
    if (!permDb.hasPermission(perm, 'view')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'View access required' },
      });
    }

    const allVersions = await versionDb.listVersions(mapId);
    return reply.send(allVersions);
  });

  // ── GET /api/versions/:id — Get version with its cycles
  app.get<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const version = await versionDb.getVersion(req.params.id);
    if (!version) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(version.mapId, userId);
    if (!permDb.hasPermission(perm, 'view')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'View access required' },
      });
    }

    const mapCycles = await cycleDb.listCycles(version.mapId);
    const filteredCycles = mapCycles.filter((c) => c.versionId === version.id);

    return reply.send({
      version,
      cycles: filteredCycles,
    });
  });

  // ── PUT /api/versions/:id — Update version ─────────────────────
  app.put<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const existing = await versionDb.getVersion(req.params.id);
    if (!existing) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(existing.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    const body = req.body as versionDb.UpdateVersionInput;
    const updated = await versionDb.updateVersion(req.params.id, body, userId);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }
    // #331: a re-dated release that now sorts against its sortOrder / name
    // order is the silent-forecast bug. Say so; don't block.
    const warnings = await versionDb.orderWarnings(updated.mapId);
    return reply.send({ ...updated, warnings });
  });

  // ── DELETE /api/versions/:id — Delete version ──────────────────
  app.delete<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const existing = await versionDb.getVersion(req.params.id);
    if (!existing) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(existing.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    const deleted = await versionDb.deleteVersion(req.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }
    return reply.status(204).send();
  });
}
