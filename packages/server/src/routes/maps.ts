import type { FastifyInstance } from 'fastify';
import { computeTree, schedule, criticalPath } from '@mindblown/core';
import * as mapDb from '../db/maps.js';

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps — Create a map ─────────────────────────────
  app.post('/api/maps', async (req, reply) => {
    const body = req.body as {
      name: string;
      description?: string;
      workspaceId: string;
      createdBy: string;
      effortUnit?: 'hours' | 'days' | 'points';
    };

    if (!body.name || !body.workspaceId || !body.createdBy) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name, workspaceId, and createdBy are required' },
      });
    }

    const result = await mapDb.createMap(body);
    return reply.status(201).send(result);
  });

  // ── GET /api/maps — List all maps ─────────────────────────────
  app.get('/api/maps', async (_req, reply) => {
    const allMaps = await mapDb.listMaps();

    // For each map, compute aggregate progress and health
    const results = await Promise.all(
      allMaps.map(async (m) => {
        const data = await mapDb.getMap(m.id);
        if (!data || data.nodes.length === 0) {
          return { ...m, computedProgress: 0, healthSignal: 'on_track' as const };
        }
        const computed = computeTree(data.nodes, m.healthThreshold);
        const rootComputed = computed.get(m.rootNodeId);
        return {
          ...m,
          computedProgress: rootComputed?.computedProgress ?? 0,
          healthSignal: rootComputed?.healthSignal ?? 'on_track',
        };
      }),
    );

    return reply.send(results);
  });

  // ── GET /api/maps/:id — Get map with all nodes + computed fields
  app.get<{ Params: { id: string } }>('/api/maps/:id', async (req, reply) => {
    const data = await mapDb.getMap(req.params.id);
    if (!data) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }

    // Compute rollups using @mindblown/core
    const computed = computeTree(data.nodes, data.map.healthThreshold);

    // Attach computed fields to each node
    const nodesWithComputed = data.nodes.map((node) => {
      const cv = computed.get(node.id);
      return {
        ...node,
        computedEffort: cv?.computedEffort ?? 0,
        computedProgress: cv?.computedProgress ?? 0,
        healthSignal: cv?.healthSignal ?? 'on_track',
      };
    });

    return reply.send({
      map: data.map,
      nodes: nodesWithComputed,
    });
  });

  // ── PUT /api/maps/:id — Update map settings ──────────────────
  app.put<{ Params: { id: string } }>('/api/maps/:id', async (req, reply) => {
    const body = req.body as mapDb.UpdateMapInput;
    const updated = await mapDb.updateMap(req.params.id, body);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }
    return reply.send(updated);
  });

  // ── DELETE /api/maps/:id — Delete map ─────────────────────────
  app.delete<{ Params: { id: string } }>('/api/maps/:id', async (req, reply) => {
    const deleted = await mapDb.deleteMap(req.params.id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }
    return reply.status(204).send();
  });

  // ── POST /api/maps/:id/baseline — Create a baseline snapshot ──
  app.post<{ Params: { id: string } }>('/api/maps/:id/baseline', async (req, reply) => {
    const body = req.body as { name: string };
    if (!body.name) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name is required' },
      });
    }

    const updated = await mapDb.createBaseline(req.params.id, body.name);
    if (!updated) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }
    return reply.status(201).send(updated);
  });

  // ── GET /api/maps/:id/schedule — Computed schedule + critical path
  app.get<{ Params: { id: string } }>('/api/maps/:id/schedule', async (req, reply) => {
    const data = await mapDb.getMap(req.params.id);
    if (!data) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }

    const scheduled = schedule(data.nodes);
    const cp = criticalPath(data.nodes);

    return reply.send({
      schedule: scheduled,
      criticalPath: cp,
    });
  });
}
