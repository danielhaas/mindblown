import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { computeTree } from '@mindblown/core';
import * as cycleDb from '../db/cycles.js';
import { db } from '../db/connection.js';
import { workspaces } from '../db/schema.js';

/** Extract YYYY-MM-DD from an ISO 8601 string or date-only string. */
function toDateOnly(input: string): string {
  return input.slice(0, 10);
}

export async function cycleRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/cycles — Create a cycle ───────────────────────────
  app.post('/api/cycles', async (req, reply) => {
    const body = req.body as {
      workspaceId: string;
      name: string;
      startDate: string;
      endDate: string;
      versionId?: string;
    };

    if (!body.workspaceId || !body.name || !body.startDate || !body.endDate) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId, name, startDate, and endDate are required' },
      });
    }

    // Validate workspace exists
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId));
    if (!ws) {
      return reply.status(404).send({
        error: { code: 'WORKSPACE_NOT_FOUND', message: `Workspace ${body.workspaceId} not found` },
      });
    }

    const startDate = toDateOnly(body.startDate);
    const endDate = toDateOnly(body.endDate);

    const cycle = await cycleDb.createCycle(body.workspaceId, body.name, startDate, endDate, body.versionId);
    return reply.status(201).send(cycle);
  });

  // ── GET /api/cycles — List cycles for a workspace ───────────────
  app.get('/api/cycles', async (req, reply) => {
    const { workspaceId } = req.query as { workspaceId?: string };

    if (!workspaceId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId query parameter is required' },
      });
    }

    const allCycles = await cycleDb.listCycles(workspaceId);
    return reply.send(allCycles);
  });

  // ── GET /api/cycles/:id — Get cycle with nodes and progress ─────
  app.get<{ Params: { id: string } }>('/api/cycles/:id', async (req, reply) => {
    const cycle = await cycleDb.getCycle(req.params.id);
    if (!cycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const cycleNodes = await cycleDb.getCycleNodes(req.params.id);

    // Compute progress across cycle nodes
    const computed = computeTree(cycleNodes, 0.2);

    const nodesWithComputed = cycleNodes.map((node) => {
      const cv = computed.get(node.id);
      return {
        ...node,
        computedEffort: cv?.computedEffort ?? 0,
        computedProgress: cv?.computedProgress ?? 0,
        healthSignal: cv?.healthSignal ?? 'on_track',
      };
    });

    // Aggregate cycle-level progress: weighted average by effort
    let totalEffort = 0;
    let weightedProgress = 0;
    for (const n of nodesWithComputed) {
      const effort = n.computedEffort || 1; // default 1 if unset
      totalEffort += effort;
      weightedProgress += effort * n.computedProgress;
    }
    const cycleProgress = totalEffort > 0 ? weightedProgress / totalEffort : 0;

    return reply.send({
      cycle,
      nodes: nodesWithComputed,
      progress: Math.round(cycleProgress * 100) / 100,
      totalNodes: cycleNodes.length,
      completedNodes: cycleNodes.filter((n) => n.percentComplete === 100).length,
    });
  });

  // ── PUT /api/cycles/:id — Update cycle ──────────────────────────
  app.put<{ Params: { id: string } }>('/api/cycles/:id', async (req, reply) => {
    const body = req.body as cycleDb.UpdateCycleInput;
    const updated = await cycleDb.updateCycle(req.params.id, body);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }
    return reply.send(updated);
  });

  // ── DELETE /api/cycles/:id — Delete cycle ───────────────────────
  app.delete<{ Params: { id: string } }>('/api/cycles/:id', async (req, reply) => {
    const deleted = await cycleDb.deleteCycle(req.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }
    return reply.status(204).send();
  });

  // ── POST /api/cycles/:id/assign — Assign a node to this cycle ──
  app.post<{ Params: { id: string } }>('/api/cycles/:id/assign', async (req, reply) => {
    const body = req.body as { nodeId: string };

    if (!body.nodeId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'nodeId is required' },
      });
    }

    // Verify cycle exists
    const cycle = await cycleDb.getCycle(req.params.id);
    if (!cycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const node = await cycleDb.assignNodeToCycle(body.nodeId, req.params.id);
    if (!node) {
      return reply.status(404).send({
        error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
      });
    }

    return reply.send(node);
  });

  // ── DELETE /api/cycles/:id/assign/:nodeId — Unassign a node ─────
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/api/cycles/:id/assign/:nodeId',
    async (req, reply) => {
      const node = await cycleDb.unassignNodeFromCycle(req.params.nodeId);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }
      return reply.send(node);
    },
  );

  // ── POST /api/cycles/:id/rollover — Auto-rollover incomplete ────
  app.post<{ Params: { id: string } }>('/api/cycles/:id/rollover', async (req, reply) => {
    const body = req.body as { targetCycleId: string };

    if (!body.targetCycleId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'targetCycleId is required' },
      });
    }

    // Verify both cycles exist
    const [sourceCycle, targetCycle] = await Promise.all([
      cycleDb.getCycle(req.params.id),
      cycleDb.getCycle(body.targetCycleId),
    ]);

    if (!sourceCycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Source cycle ${req.params.id} not found` },
      });
    }
    if (!targetCycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Target cycle ${body.targetCycleId} not found` },
      });
    }

    const result = await cycleDb.autoRollover(req.params.id, body.targetCycleId);
    return reply.send(result);
  });
}
