import type { FastifyInstance } from 'fastify';
import { computeTree, schedule, criticalPath } from '@mindblown/core';
import type { ScheduleConstraint, NodeId, Node as CoreNode, MindMap } from '@mindblown/core';
import * as mapDb from '../db/maps.js';
import * as permDb from '../db/permissions.js';
import * as milestoneDb from '../db/milestones.js';
import * as versionDb from '../db/versions.js';
import { db } from '../db/connection.js';
import { workspaces, users } from '../db/schema.js';

interface MapProjection {
  totalScope: number;
  totalDone: number;
  totalRemaining: number;
  weightedProgress: number;
  leafCount: number;
  noEstimateCount: number;
  plannedFinishDate: string | null;
  plannedFinishOffsetDays: number | null;
}

/**
 * Pure-function projection of a map's totals + planned finish. Used by the
 * scope_simulate endpoint to compute before/after snapshots without
 * persisting anything.
 */
function projectMap(nodes: CoreNode[], map: MindMap): MapProjection {
  const leaves = nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
  let totalScope = 0;
  let totalDone = 0;
  let noEstimateCount = 0;
  for (const l of leaves) {
    if (l.effortEstimate == null) noEstimateCount++;
    const est = l.effortEstimate ?? 0;
    const prog = l.percentComplete ?? 0;
    totalScope += est;
    totalDone += est * (prog / 100);
  }
  const totalRemaining = totalScope - totalDone;
  const weightedProgress = totalScope > 0 ? (totalDone / totalScope) * 100 : 0;

  // Planned finish via the scheduler (mirrors the schedule endpoint).
  let plannedFinishOffsetDays: number | null = null;
  let plannedFinishDate: string | null = null;
  try {
    const projectStartDate = map.projectStartDate
      ? new Date(map.projectStartDate)
      : new Date(new Date().toISOString().slice(0, 10));
    projectStartDate.setUTCHours(0, 0, 0, 0);
    const unitsPerDay = map.effortUnit === 'hours' ? (map.hoursPerDay ?? 8) : 1;
    const MS_PER_DAY = 86_400_000;
    const toDayOffset = (isoDate: string): number => {
      const d = new Date(isoDate);
      d.setUTCHours(0, 0, 0, 0);
      const calendarDays = Math.round((d.getTime() - projectStartDate.getTime()) / MS_PER_DAY);
      return calendarDays * unitsPerDay;
    };
    const constraints = new Map<NodeId, ScheduleConstraint>();
    for (const n of nodes) {
      const pin: ScheduleConstraint = {};
      if (n.startDate) pin.minStart = toDayOffset(n.startDate);
      if (n.dueDate) pin.maxEnd = toDayOffset(n.dueDate);
      if (pin.minStart !== undefined || pin.maxEnd !== undefined) {
        constraints.set(n.id, pin);
      }
    }
    const scheduled = schedule(nodes, 0, constraints);
    const maxEnd = scheduled.reduce((m, s) => Math.max(m, s.computedEnd), 0);
    plannedFinishOffsetDays = maxEnd / unitsPerDay;
    const finish = new Date(projectStartDate.getTime());
    finish.setUTCDate(finish.getUTCDate() + Math.ceil(plannedFinishOffsetDays));
    plannedFinishDate = finish.toISOString().slice(0, 10);
  } catch {
    /* scheduler errors out on circular deps etc — leave null */
  }

  return {
    totalScope,
    totalDone,
    totalRemaining,
    weightedProgress,
    leafCount: leaves.length,
    noEstimateCount,
    plannedFinishDate,
    plannedFinishOffsetDays,
  };
}

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

  // ── POST /api/maps/:id/simulate — Scope-simulation what-if ────
  // Apply a list of patches to an in-memory copy of the map's nodes and
  // return before/after totals + planned finish dates. No persistence.
  app.post<{ Params: { id: string } }>('/api/maps/:id/simulate', async (req, reply) => {
    const data = await mapDb.getMap(req.params.id);
    if (!data) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }
    const body = req.body as {
      patches: Array<
        | { action: 'remove'; nodeId: string }
        | { action: 'add'; parentId: string; text: string; effortEstimate: number; dueDate?: string | null }
        | {
            action: 'update';
            nodeId: string;
            effortEstimate?: number | null;
            startDate?: string | null;
            dueDate?: string | null;
            percentComplete?: number | null;
          }
      >;
    };
    if (!Array.isArray(body?.patches)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'patches array is required' },
      });
    }

    // Compute "before" projection from the live state
    const before = projectMap(data.nodes, data.map);

    // Apply patches to a deep-cloned node list
    const cloned: typeof data.nodes = data.nodes.map((n) => ({
      ...n,
      childrenIds: [...(n.childrenIds ?? [])],
      dependencies: [...(n.dependencies ?? [])],
      assigneeIds: [...(n.assigneeIds ?? [])],
      tags: [...(n.tags ?? [])],
      externalLinks: [...(n.externalLinks ?? [])],
    }));
    const byId = new Map(cloned.map((n) => [n.id, n]));

    const removeSubtree = (rootId: string) => {
      const removed = new Set<string>();
      const stack = [rootId];
      while (stack.length) {
        const id = stack.pop()!;
        if (removed.has(id)) continue;
        removed.add(id);
        const n = byId.get(id);
        if (n) for (const cid of n.childrenIds ?? []) stack.push(cid);
      }
      // Remove from parent's childrenIds
      const root = byId.get(rootId);
      if (root?.parentId) {
        const parent = byId.get(root.parentId);
        if (parent) parent.childrenIds = parent.childrenIds.filter((c) => !removed.has(c));
      }
      // Remove from the array
      for (let i = cloned.length - 1; i >= 0; i--) {
        if (removed.has(cloned[i].id)) cloned.splice(i, 1);
      }
      for (const id of removed) byId.delete(id);
    };

    let nextSimId = 0;
    const newSimId = () => `sim-${++nextSimId}`;

    for (const p of body.patches) {
      if (p.action === 'remove') {
        if (byId.has(p.nodeId)) removeSubtree(p.nodeId);
      } else if (p.action === 'add') {
        const parent = byId.get(p.parentId);
        if (!parent) continue;
        const id = newSimId();
        const now = new Date().toISOString();
        const stub: CoreNode = {
          id,
          mapId: data.map.id,
          parentId: parent.id,
          childrenIds: [],
          text: p.text,
          description: null,
          x: null,
          y: null,
          collapsed: false,
          effortEstimate: p.effortEstimate,
          actualEffort: null,
          percentComplete: null,
          status: null,
          assigneeIds: [],
          priority: null,
          dueDate: p.dueDate ?? null,
          startDate: null,
          tags: [],
          customFields: {},
          dependencies: [],
          isMilestone: false,
          versionId: null,
          milestoneId: null,
          cycleId: null,
          externalLinks: [],
          createdAt: now,
          updatedAt: now,
          createdBy: parent.createdBy,
        };
        cloned.push(stub);
        byId.set(id, stub);
        parent.childrenIds.push(id);
      } else if (p.action === 'update') {
        const n = byId.get(p.nodeId);
        if (!n) continue;
        if (p.effortEstimate !== undefined) n.effortEstimate = p.effortEstimate;
        if (p.startDate !== undefined) n.startDate = p.startDate;
        if (p.dueDate !== undefined) n.dueDate = p.dueDate;
        if (p.percentComplete !== undefined) n.percentComplete = p.percentComplete;
      }
    }

    const after = projectMap(cloned, data.map);
    return reply.send({ before, after });
  });

  // ── GET /api/maps/:id/schedule — Computed schedule + critical path
  //
  // Optional ?versionId=... scopes the schedule to nodes in that version
  // (via ancestor inheritance — same pattern as remaining_work and friends).
  // Cross-version dependencies are dropped from the scheduler input and
  // reported back as `crossVersionDependencies` so callers can spot them.
  app.get<{ Params: { id: string }; Querystring: { versionId?: string } }>(
    '/api/maps/:id/schedule',
    async (req, reply) => {
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

    // ── Version scoping ──────────────────────────────────────
    const versionId = req.query.versionId;
    let scopedNodes = data.nodes;
    const crossVersionDependencies: Array<{
      fromNodeId: string;
      fromText: string;
      toNodeId: string;
      toText: string;
      type: string;
    }> = [];
    if (versionId) {
      // A node is in scope if itself OR any ancestor has the matching versionId.
      const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
      const inScope = new Set<string>();
      for (const n of data.nodes) {
        let cur: typeof n | undefined = n;
        while (cur) {
          if (cur.versionId === versionId) {
            inScope.add(n.id);
            break;
          }
          cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
        }
      }
      // Prune dependencies that cross the version boundary; record them.
      scopedNodes = data.nodes
        .filter((n) => inScope.has(n.id))
        .map((n) => {
          const kept: typeof n.dependencies = [];
          for (const dep of n.dependencies) {
            if (inScope.has(dep.targetNodeId)) {
              kept.push(dep);
            } else {
              const target = nodeById.get(dep.targetNodeId);
              crossVersionDependencies.push({
                fromNodeId: n.id,
                fromText: n.text,
                toNodeId: dep.targetNodeId,
                toText: target?.text ?? dep.targetNodeId,
                type: dep.type,
              });
            }
          }
          // childrenIds also need pruning so the scheduler's tree view stays valid
          const keptChildren = n.childrenIds.filter((cid) => inScope.has(cid));
          return { ...n, dependencies: kept, childrenIds: keptChildren };
        });
    }

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
    for (const n of scopedNodes) {
      const pin: ScheduleConstraint = {};
      if (n.startDate) pin.minStart = toDayOffset(n.startDate);
      if (n.dueDate) pin.maxEnd = toDayOffset(n.dueDate);
      if (pin.minStart !== undefined || pin.maxEnd !== undefined) {
        constraints.set(n.id, pin);
      }
    }

    const scheduled = schedule(scopedNodes, 0, constraints);
    const cp = criticalPath(scopedNodes);

    return reply.send({
      schedule: scheduled,
      criticalPath: cp,
      projectStartDate: projectStartDate.toISOString().slice(0, 10),
      effortUnit: data.map.effortUnit,
      unitsPerDay,
      versionId: versionId ?? null,
      crossVersionDependencies: versionId ? crossVersionDependencies : [],
    });
  });

  // ── GET /api/maps/:id/forecast — Completion forecast
  //
  // Ports the MCP `completion_forecast` math to HTTP so browser views can
  // render per-milestone / per-version ETAs. Scope with one of nodeId,
  // versionId, or milestoneId (omit all to forecast the whole map).
  // Returns planned finish (scheduler), velocity-adjusted finish (scaled by
  // all-time estimation fudge), target date, and slip.
  app.get<{
    Params: { id: string };
    Querystring: { nodeId?: string; versionId?: string; milestoneId?: string };
  }>('/api/maps/:id/forecast', async (req, reply) => {
    const data = await mapDb.getMap(req.params.id);
    if (!data) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` },
      });
    }

    const { nodeId, versionId, milestoneId } = req.query;
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

    const ancestorTags = (leafId: string): { versions: Set<string>; milestones: Set<string> } => {
      const versions = new Set<string>();
      const milestones = new Set<string>();
      let cur: CoreNode | undefined = nodeById.get(leafId);
      while (cur) {
        if (cur.versionId) versions.add(cur.versionId);
        if (cur.milestoneId) milestones.add(cur.milestoneId);
        cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
      }
      return { versions, milestones };
    };

    // ── Determine scope ──
    let leaves: CoreNode[];
    let scopeLabel = 'whole map';
    if (nodeId) {
      const root = nodeById.get(nodeId);
      if (!root) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found in map ${req.params.id}` },
        });
      }
      scopeLabel = `subtree of "${root.text}"`;
      const subtreeLeaves: CoreNode[] = [];
      const stack: CoreNode[] = [root];
      while (stack.length) {
        const n = stack.pop()!;
        if ((n.childrenIds?.length ?? 0) === 0) {
          subtreeLeaves.push(n);
        } else {
          for (const cid of n.childrenIds) {
            const c = nodeById.get(cid);
            if (c) stack.push(c);
          }
        }
      }
      leaves = subtreeLeaves;
    } else {
      leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
    }
    if (versionId) {
      scopeLabel = `version ${versionId}` + (nodeId ? ` within ${scopeLabel}` : '');
      leaves = leaves.filter((n) => ancestorTags(n.id).versions.has(versionId));
    }
    if (milestoneId) {
      scopeLabel = `milestone ${milestoneId}` + (versionId || nodeId ? ` within ${scopeLabel}` : '');
      leaves = leaves.filter((n) => ancestorTags(n.id).milestones.has(milestoneId));
    }

    // ── Remaining effort ──
    let remainingEffort = 0;
    let totalEffort = 0;
    let noEstimateLeaves = 0;
    const leafDueDates: string[] = [];
    for (const leaf of leaves) {
      if (leaf.effortEstimate == null) noEstimateLeaves++;
      const est = leaf.effortEstimate ?? 0;
      const prog = leaf.percentComplete ?? 0;
      totalEffort += est;
      remainingEffort += est * (1 - prog / 100);
      if (leaf.dueDate) leafDueDates.push(leaf.dueDate);
    }

    // ── Velocity fudge factor from all-time calibration leaves ──
    const calibrationLeaves = data.nodes.filter(
      (n) =>
        (n.childrenIds?.length ?? 0) === 0 &&
        n.effortEstimate != null &&
        n.actualEffort != null,
    );
    const calibEstimate = calibrationLeaves.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
    const calibActual = calibrationLeaves.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
    const fudgeFactor = calibEstimate > 0 ? calibActual / calibEstimate : null;
    const effectiveFudge = fudgeFactor ?? 1.0;

    // ── Run scheduler over the full map so cross-scope deps still apply ──
    const projectStart = data.map.projectStartDate
      ? new Date(data.map.projectStartDate)
      : new Date(new Date().toISOString().slice(0, 10));
    projectStart.setUTCHours(0, 0, 0, 0);
    const unitsPerDay =
      data.map.effortUnit === 'hours' ? (data.map.hoursPerDay ?? 8) : 1;
    const MS_PER_DAY = 86_400_000;
    const toDayOffset = (isoDate: string): number => {
      const d = new Date(isoDate);
      d.setUTCHours(0, 0, 0, 0);
      const calendarDays = Math.round((d.getTime() - projectStart.getTime()) / MS_PER_DAY);
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

    let plannedFinishDate: string | null = null;
    let velocityAdjustedFinishDate: string | null = null;
    let maxScopedEnd = 0;
    try {
      const scheduled = schedule(data.nodes, 0, constraints);
      const scopedIds = new Set(leaves.map((l) => l.id));
      maxScopedEnd = scheduled
        .filter((s) => scopedIds.has(s.nodeId))
        .reduce((m, s) => Math.max(m, s.computedEnd), 0);

      const addCalendarDays = (base: Date, days: number): Date => {
        const d = new Date(base.getTime());
        d.setUTCDate(d.getUTCDate() + Math.ceil(days));
        return d;
      };

      if (maxScopedEnd > 0) {
        const plannedCalDays = maxScopedEnd / unitsPerDay;
        plannedFinishDate = addCalendarDays(projectStart, plannedCalDays).toISOString().slice(0, 10);

        if (remainingEffort > 0) {
          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          const anchor = today > projectStart ? today : projectStart;
          const elapsedFromStart = Math.max(
            0,
            Math.round((anchor.getTime() - projectStart.getTime()) / MS_PER_DAY),
          );
          const remainingSchedulerDays = Math.max(0, plannedCalDays - elapsedFromStart);
          const velDays = remainingSchedulerDays * effectiveFudge;
          velocityAdjustedFinishDate = addCalendarDays(anchor, velDays).toISOString().slice(0, 10);
        }
      }
    } catch {
      /* scheduler errors (e.g. circular deps) — leave dates null */
    }

    // ── Target date resolution ──
    let targetDate: string | null = null;
    let targetSource: string | null = null;
    if (milestoneId) {
      const m = await milestoneDb.getMilestone(milestoneId);
      if (m?.targetDate) {
        targetDate = m.targetDate.slice(0, 10);
        targetSource = `milestone "${m.name}"`;
      }
    }
    if (!targetDate && versionId) {
      const v = await versionDb.getVersion(versionId);
      if (v?.targetDate) {
        targetDate = v.targetDate.slice(0, 10);
        targetSource = `version "${v.name}"`;
      }
    }
    if (!targetDate && leafDueDates.length > 0) {
      targetDate = leafDueDates.sort().slice(-1)[0].slice(0, 10);
      targetSource = 'max leaf dueDate';
    }

    // ── Slip ──
    const daysBetween = (a: string, b: string): number => {
      const da = new Date(a);
      const db2 = new Date(b);
      return Math.round((da.getTime() - db2.getTime()) / MS_PER_DAY);
    };
    const slipPlannedDays =
      targetDate && plannedFinishDate ? daysBetween(plannedFinishDate, targetDate) : null;
    const slipVelocityDays =
      targetDate && velocityAdjustedFinishDate
        ? daysBetween(velocityAdjustedFinishDate, targetDate)
        : null;

    return reply.send({
      scopeLabel,
      leaves: leaves.length,
      noEstimateLeaves,
      totalEffort,
      remainingEffort,
      effortUnit: data.map.effortUnit,
      fudgeFactor,
      calibrationLeafCount: calibrationLeaves.length,
      projectStartDate: projectStart.toISOString().slice(0, 10),
      plannedFinishDate,
      velocityAdjustedFinishDate,
      targetDate,
      targetSource,
      slipPlannedDays,
      slipVelocityDays,
    });
  });
}
