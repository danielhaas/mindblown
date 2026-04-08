import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as milestoneDb from '../db/milestones.js';
import { db } from '../db/connection.js';
import { workspaces, nodes } from '../db/schema.js';
import { dbNodeToCore } from '../db/helpers.js';
import { computeTree } from '@mindblown/core';

export async function milestoneRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/milestones — Create a milestone ──────────────────
  app.post('/api/milestones', async (req, reply) => {
    const body = req.body as milestoneDb.CreateMilestoneInput;

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

    const milestone = await milestoneDb.createMilestone(body);
    return reply.status(201).send(milestone);
  });

  // ── GET /api/milestones — List milestones ──────────────────────
  app.get('/api/milestones', async (req, reply) => {
    const { workspaceId, versionId } = req.query as { workspaceId?: string; versionId?: string };

    if (!workspaceId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId query parameter is required' },
      });
    }

    const allMilestones = await milestoneDb.listMilestones(workspaceId, versionId);
    return reply.send(allMilestones);
  });

  // ── GET /api/milestones/:id — Get milestone with linked nodes ──
  app.get<{ Params: { id: string } }>('/api/milestones/:id', async (req, reply) => {
    const milestone = await milestoneDb.getMilestone(req.params.id);
    if (!milestone) {
      return reply.status(404).send({
        error: { code: 'MILESTONE_NOT_FOUND', message: `Milestone ${req.params.id} not found` },
      });
    }

    // Get nodes linked to this milestone
    const milestoneNodes = await db.select()
      .from(nodes)
      .where(eq(nodes.milestoneId, req.params.id));

    const coreNodes = milestoneNodes.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));
    const computed = computeTree(coreNodes, 0.2);

    const nodesWithComputed = coreNodes.map((node) => {
      const cv = computed.get(node.id);
      return {
        ...node,
        computedEffort: cv?.computedEffort ?? 0,
        computedProgress: cv?.computedProgress ?? 0,
        healthSignal: cv?.healthSignal ?? 'on_track',
      };
    });

    // Aggregate milestone-level progress
    let totalEffort = 0;
    let weightedProgress = 0;
    for (const n of nodesWithComputed) {
      const effort = n.computedEffort || 1;
      totalEffort += effort;
      weightedProgress += effort * n.computedProgress;
    }
    const milestoneProgress = totalEffort > 0 ? weightedProgress / totalEffort : 0;

    return reply.send({
      milestone,
      nodes: nodesWithComputed,
      progress: Math.round(milestoneProgress * 100) / 100,
      totalNodes: coreNodes.length,
    });
  });

  // ── PUT /api/milestones/:id — Update milestone ─────────────────
  app.put<{ Params: { id: string } }>('/api/milestones/:id', async (req, reply) => {
    const body = req.body as milestoneDb.UpdateMilestoneInput;
    const updated = await milestoneDb.updateMilestone(req.params.id, body);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'MILESTONE_NOT_FOUND', message: `Milestone ${req.params.id} not found` },
      });
    }
    return reply.send(updated);
  });

  // ── DELETE /api/milestones/:id — Delete milestone ──────────────
  app.delete<{ Params: { id: string } }>('/api/milestones/:id', async (req, reply) => {
    const deleted = await milestoneDb.deleteMilestone(req.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'MILESTONE_NOT_FOUND', message: `Milestone ${req.params.id} not found` },
      });
    }
    return reply.status(204).send();
  });

  // ── POST /api/milestones/:id/assign — Assign node to milestone ─
  app.post<{ Params: { id: string } }>('/api/milestones/:id/assign', async (req, reply) => {
    const body = req.body as { nodeId: string };

    if (!body.nodeId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'nodeId is required' },
      });
    }

    const milestone = await milestoneDb.getMilestone(req.params.id);
    if (!milestone) {
      return reply.status(404).send({
        error: { code: 'MILESTONE_NOT_FOUND', message: `Milestone ${req.params.id} not found` },
      });
    }

    const [row] = await db.update(nodes)
      .set({ milestoneId: req.params.id, updatedAt: new Date() })
      .where(eq(nodes.id, body.nodeId))
      .returning();

    if (!row) {
      return reply.status(404).send({
        error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
      });
    }

    return reply.send(dbNodeToCore(row as unknown as Record<string, unknown>));
  });
}
