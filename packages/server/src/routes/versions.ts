import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as versionDb from '../db/versions.js';
import * as milestoneDb from '../db/milestones.js';
import * as cycleDb from '../db/cycles.js';
import { db } from '../db/connection.js';
import { workspaces } from '../db/schema.js';

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/versions — Create a version ──────────────────────
  app.post('/api/versions', async (req, reply) => {
    const body = req.body as versionDb.CreateVersionInput;

    if (!body.workspaceId || !body.name) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId and name are required' },
      });
    }

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId));
    if (!ws) {
      return reply.status(404).send({
        error: { code: 'WORKSPACE_NOT_FOUND', message: `Workspace ${body.workspaceId} not found` },
      });
    }

    const version = await versionDb.createVersion(body);
    return reply.status(201).send(version);
  });

  // ── GET /api/versions — List versions for a workspace ──────────
  app.get('/api/versions', async (req, reply) => {
    const { workspaceId } = req.query as { workspaceId?: string };

    if (!workspaceId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId query parameter is required' },
      });
    }

    const allVersions = await versionDb.listVersions(workspaceId);
    return reply.send(allVersions);
  });

  // ── GET /api/versions/:id — Get version with milestones and cycles
  app.get<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const version = await versionDb.getVersion(req.params.id);
    if (!version) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }

    const [versionMilestones, versionCycles] = await Promise.all([
      milestoneDb.listMilestones(version.workspaceId, version.id),
      cycleDb.listCycles(version.workspaceId),
    ]);

    // Filter cycles belonging to this version
    const filteredCycles = versionCycles.filter((c) => c.versionId === version.id);

    return reply.send({
      version,
      milestones: versionMilestones,
      cycles: filteredCycles,
    });
  });

  // ── PUT /api/versions/:id — Update version ─────────────────────
  app.put<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const body = req.body as versionDb.UpdateVersionInput;
    const updated = await versionDb.updateVersion(req.params.id, body);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }
    return reply.send(updated);
  });

  // ── DELETE /api/versions/:id — Delete version ──────────────────
  app.delete<{ Params: { id: string } }>('/api/versions/:id', async (req, reply) => {
    const deleted = await versionDb.deleteVersion(req.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'VERSION_NOT_FOUND', message: `Version ${req.params.id} not found` },
      });
    }
    return reply.status(204).send();
  });
}
