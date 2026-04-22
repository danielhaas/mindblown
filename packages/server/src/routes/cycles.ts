import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { computeTree } from '@mindblown/core';
import * as cycleDb from '../db/cycles.js';
import * as permDb from '../db/permissions.js';
import { db } from '../db/connection.js';
import { maps } from '../db/schema.js';
import { broadcast } from '../ws.js';

/** Extract YYYY-MM-DD from an ISO 8601 string or date-only string. */
function toDateOnly(input: string): string {
  return input.slice(0, 10);
}

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
  });
}

export async function cycleRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/cycles — Create a cycle ───────────────────────────
  app.post('/api/cycles', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const body = req.body as {
      mapId: string;
      name: string;
      startDate: string;
      endDate: string;
      versionId?: string;
    };

    if (!body.mapId || !body.name || !body.startDate || !body.endDate) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId, name, startDate, and endDate are required' },
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

    const startDate = toDateOnly(body.startDate);
    const endDate = toDateOnly(body.endDate);

    try {
      const cycle = await cycleDb.createCycle(body.mapId, body.name, startDate, endDate, body.versionId);
      return reply.status(201).send(cycle);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // ── GET /api/cycles — List cycles for a map ─────────────────────
  app.get('/api/cycles', async (req, reply) => {
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

    const allCycles = await cycleDb.listCycles(mapId);
    return reply.send(allCycles);
  });

  // ── GET /api/cycles/:id — Get cycle with nodes and progress ─────
  app.get<{ Params: { id: string } }>('/api/cycles/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const cycle = await cycleDb.getCycle(req.params.id);
    if (!cycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(cycle.mapId, userId);
    if (!permDb.hasPermission(perm, 'view')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'View access required' },
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
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const existing = await cycleDb.getCycle(req.params.id);
    if (!existing) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(existing.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    const body = req.body as cycleDb.UpdateCycleInput;
    try {
      const result = await cycleDb.updateCycle(req.params.id, body);
      if (!result) {
        return reply.status(404).send({
          error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
        });
      }

      // Broadcast a node:updated event for each node touched by the activation
      // sweep so live clients refresh their Kanban without needing a reload.
      for (const node of result.sweptNodes) {
        broadcast(node.mapId, {
          type: 'node:updated',
          nodeId: node.id,
          fields: ['status'],
          node,
        });
      }

      return reply.send(result.cycle);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // ── DELETE /api/cycles/:id — Delete cycle ───────────────────────
  app.delete<{ Params: { id: string } }>('/api/cycles/:id', async (req, reply) => {
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const existing = await cycleDb.getCycle(req.params.id);
    if (!existing) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(existing.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

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
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const body = req.body as { nodeId: string };

    if (!body.nodeId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'nodeId is required' },
      });
    }

    const cycle = await cycleDb.getCycle(req.params.id);
    if (!cycle) {
      return reply.status(404).send({
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
      });
    }

    const perm = await permDb.getPermission(cycle.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    try {
      const node = await cycleDb.assignNodeToCycle(body.nodeId, req.params.id);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
        });
      }

      // Broadcast so live clients see the cycleId change (and any auto-todo
      // status promotion when assigning into an active sprint).
      broadcast(node.mapId, {
        type: 'node:updated',
        nodeId: node.id,
        fields: ['cycleId', 'status'],
        node,
      });

      return reply.send(node);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // ── DELETE /api/cycles/:id/assign/:nodeId — Unassign a node ─────
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/api/cycles/:id/assign/:nodeId',
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) return unauthorized(reply);

      const cycle = await cycleDb.getCycle(req.params.id);
      if (!cycle) {
        return reply.status(404).send({
          error: { code: 'CYCLE_NOT_FOUND', message: `Cycle ${req.params.id} not found` },
        });
      }

      const perm = await permDb.getPermission(cycle.mapId, userId);
      if (!permDb.hasPermission(perm, 'edit')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Edit access required' },
        });
      }

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
    const userId = req.userId;
    if (!userId) return unauthorized(reply);

    const body = req.body as { targetCycleId: string };

    if (!body.targetCycleId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'targetCycleId is required' },
      });
    }

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

    const perm = await permDb.getPermission(sourceCycle.mapId, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Edit access required' },
      });
    }

    try {
      const result = await cycleDb.autoRollover(req.params.id, body.targetCycleId);
      return reply.send(result);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
}
