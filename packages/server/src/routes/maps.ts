import type { FastifyInstance } from 'fastify';
import { computeTree, schedule, criticalPath } from '@mindblown/core';
import type { ScheduleConstraint, NodeId } from '@mindblown/core';
import * as mapDb from '../db/maps.js';
import * as permDb from '../db/permissions.js';
import { db } from '../db/connection.js';
import { workspaces, users } from '../db/schema.js';

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps — Create a map ─────────────────────────────
  app.post('/api/maps', async (req, reply) => {
    const body = req.body as {
      name: string;
      description?: string;
      workspaceId: string;
      createdBy?: string;
      effortUnit?: 'hours' | 'days' | 'points';
    };
    let userId = req.userId ?? body.createdBy;
    if (!userId) {
      const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
      userId = firstUser?.id ?? 'system';
    }

    if (!body.name || !body.workspaceId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name and workspaceId are required' },
      });
    }

    // Resolve 'default' workspaceId to the first available workspace
    let { workspaceId } = body;
    if (workspaceId === 'default') {
      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
      if (!ws) {
        return reply.status(400).send({
          error: { code: 'NO_WORKSPACE', message: 'No workspace found. Create a workspace first.' },
        });
      }
      workspaceId = ws.id;
    }

    const result = await mapDb.createMap({
      ...body,
      workspaceId,
      createdBy: userId,
    });
    return reply.status(201).send(result);
  });

  // ── GET /api/maps — List all maps ─────────────────────────────
  app.get('/api/maps', async (req, reply) => {
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
    const userId = req.userId;

    // Check permissions if authenticated
    if (userId) {
      const perm = await permDb.getPermission(req.params.id, userId);
      if (!permDb.hasPermission(perm, 'view')) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this map' },
        });
      }
    }

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
    const userId = req.userId!;

    const perm = await permDb.getPermission(req.params.id, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'You need edit permission to update this map' },
      });
    }

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
    const userId = req.userId!;

    const perm = await permDb.getPermission(req.params.id, userId);
    if (!permDb.hasPermission(perm, 'admin')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Only admins can delete maps' },
      });
    }

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
    const userId = req.userId!;

    const perm = await permDb.getPermission(req.params.id, userId);
    if (!permDb.hasPermission(perm, 'edit')) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'You need edit permission to create baselines' },
      });
    }

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

    // Anchor day 0 of the schedule to the map's projectStartDate (or today).
    const projectStartDate = data.map.projectStartDate
      ? new Date(data.map.projectStartDate)
      : new Date(new Date().toISOString().slice(0, 10));
    // Normalize to UTC midnight so day arithmetic is stable.
    projectStartDate.setUTCHours(0, 0, 0, 0);

    // Conversion factor: effort-unit → calendar days.
    // - days: 1 unit = 1 day
    // - hours: 1 unit = 1 / hoursPerDay days
    // - points: undefined (clients should warn); default to 1 day/point so a
    //   roadmap still renders something.
    const unitsPerDay =
      data.map.effortUnit === 'hours'
        ? (data.map.hoursPerDay ?? 8)
        : 1;

    // Build per-node constraints from manual start/due dates. Any node with
    // a user-set date gets pinned; everything else flows from effort + deps.
    const MS_PER_DAY = 86_400_000;
    const toDayOffset = (isoDate: string): number => {
      const d = new Date(isoDate);
      d.setUTCHours(0, 0, 0, 0);
      const calendarDays = Math.round((d.getTime() - projectStartDate.getTime()) / MS_PER_DAY);
      // Convert calendar-day offset back to the scheduler's effort-unit space.
      return calendarDays * unitsPerDay;
    };

    const constraints = new Map<NodeId, ScheduleConstraint>();
    for (const n of data.nodes) {
      const pin: ScheduleConstraint = {};
      if (n.startDate) pin.minStart = toDayOffset(n.startDate);
      if (n.dueDate) pin.maxEnd = toDayOffset(n.dueDate);
      if (pin.minStart !== undefined || pin.maxEnd !== undefined) {
        constraints.set(n.id, pin);
      }
    }

    const scheduled = schedule(data.nodes, 0, constraints);
    const cp = criticalPath(data.nodes);

    return reply.send({
      schedule: scheduled,
      criticalPath: cp,
      projectStartDate: projectStartDate.toISOString().slice(0, 10),
      effortUnit: data.map.effortUnit,
      unitsPerDay,
    });
  });
}
