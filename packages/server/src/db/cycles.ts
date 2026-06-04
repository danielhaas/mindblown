import { eq, asc, and, isNull } from 'drizzle-orm';
import { db } from './connection.js';
import { cycles, nodes, versions, maps } from './schema.js';
import { dbNodeToCore } from './helpers.js';
import { notDeleted } from './nodes.js';
import type { Cycle, Node as CoreNode } from '@mindblown/core';

// ── Helpers ───────────────────────────────────────────────────────────

function dbCycleToCore(row: Record<string, unknown>): Cycle {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: get('id', 'id') as string,
    mapId: get('mapId', 'map_id') as string,
    versionId: (get('versionId', 'version_id') as string) ?? null,
    name: get('name', 'name') as string,
    startDate: get('startDate', 'start_date') as string,
    endDate: get('endDate', 'end_date') as string,
    status: get('status', 'status') as Cycle['status'],
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
  };
}

async function workspaceIdForMap(mapId: string): Promise<string | null> {
  const [row] = await db.select({ workspaceId: maps.workspaceId }).from(maps).where(eq(maps.id, mapId));
  return row?.workspaceId ?? null;
}

// ── Create ────────────────────────────────────────────────────────────

export async function createCycle(
  mapId: string,
  name: string,
  startDate: string,
  endDate: string,
  versionId?: string | null,
): Promise<Cycle> {
  const workspaceId = await workspaceIdForMap(mapId);
  if (!workspaceId) {
    throw new Error(`Map ${mapId} not found`);
  }

  if (versionId) {
    const [version] = await db.select({ mapId: versions.mapId }).from(versions).where(eq(versions.id, versionId));
    if (!version) {
      throw new Error(`Version ${versionId} not found`);
    }
    if (version.mapId !== mapId) {
      throw new Error(`Version ${versionId} belongs to a different map`);
    }
  }

  const [row] = await db.insert(cycles).values({
    workspaceId,
    mapId,
    name,
    startDate,
    endDate,
    versionId: versionId ?? null,
    createdAt: new Date(),
  }).returning();

  return dbCycleToCore(row as unknown as Record<string, unknown>);
}

// ── List ──────────────────────────────────────────────────────────────

export async function listCycles(mapId: string): Promise<Cycle[]> {
  const rows = await db.select()
    .from(cycles)
    .where(eq(cycles.mapId, mapId))
    .orderBy(asc(cycles.startDate));

  return rows.map((r) => dbCycleToCore(r as unknown as Record<string, unknown>));
}

// ── Get ───────────────────────────────────────────────────────────────

export async function getCycle(id: string): Promise<Cycle | null> {
  const [row] = await db.select().from(cycles).where(eq(cycles.id, id));
  if (!row) return null;
  return dbCycleToCore(row as unknown as Record<string, unknown>);
}

// ── Update ────────────────────────────────────────────────────────────

export interface UpdateCycleInput {
  name?: string;
  startDate?: string;
  endDate?: string;
  status?: 'planned' | 'active' | 'completed';
  versionId?: string | null;
}

export interface UpdateCycleResult {
  cycle: Cycle;
  /** Nodes whose status was set by the activation sweep. Empty unless input.status === 'active'. */
  sweptNodes: CoreNode[];
}

export async function updateCycle(id: string, input: UpdateCycleInput): Promise<UpdateCycleResult | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.startDate !== undefined) updates.startDate = input.startDate;
  if (input.endDate !== undefined) updates.endDate = input.endDate;
  if (input.status !== undefined) updates.status = input.status;

  if (input.versionId !== undefined) {
    if (input.versionId) {
      const [cycleRow] = await db.select({ mapId: cycles.mapId }).from(cycles).where(eq(cycles.id, id));
      const [version] = await db.select({ mapId: versions.mapId }).from(versions).where(eq(versions.id, input.versionId));
      if (cycleRow && version && cycleRow.mapId !== version.mapId) {
        throw new Error(`Version ${input.versionId} belongs to a different map than this sprint`);
      }
    }
    updates.versionId = input.versionId;
  }

  const [row] = await db.update(cycles).set(updates).where(eq(cycles.id, id)).returning();
  if (!row) return null;

  // When a cycle becomes active, default any unset assigned nodes to "todo"
  // so they show up in the Kanban Todo column instead of "Unset". Idempotent
  // — only touches nodes whose status is currently null. Returned so the
  // route layer can broadcast WS events to live clients.
  let sweptNodes: CoreNode[] = [];
  if (input.status === 'active') {
    const swept = await db.update(nodes)
      .set({ status: 'todo', updatedAt: new Date() })
      .where(and(eq(nodes.cycleId, id), isNull(nodes.status)))
      .returning();
    sweptNodes = swept.map((n) => dbNodeToCore(n as unknown as Record<string, unknown>));
  }

  return { cycle: dbCycleToCore(row as unknown as Record<string, unknown>), sweptNodes };
}

// ── Delete ────────────────────────────────────────────────────────────

export async function deleteCycle(id: string): Promise<boolean> {
  // Unset cycleId on all nodes referencing this cycle
  await db.update(nodes)
    .set({ cycleId: null, updatedAt: new Date() })
    .where(eq(nodes.cycleId, id));

  const rows = await db.delete(cycles).where(eq(cycles.id, id)).returning();
  return rows.length > 0;
}

// ── Get cycle nodes ───────────────────────────────────────────────────

export async function getCycleNodes(cycleId: string): Promise<CoreNode[]> {
  const rows = await db.select()
    .from(nodes)
    .where(and(eq(nodes.cycleId, cycleId), notDeleted));

  return rows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));
}

// ── Assign / Unassign ─────────────────────────────────────────────────

export async function assignNodeToCycle(nodeId: string, cycleId: string): Promise<CoreNode | null> {
  // Cross-map assignment is forbidden — versions/cycles are per-map now.
  const [cycle] = await db.select({ status: cycles.status, mapId: cycles.mapId }).from(cycles).where(eq(cycles.id, cycleId));
  const [current] = await db
    .select({ status: nodes.status, mapId: nodes.mapId })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));

  if (!cycle || !current) return null;
  if (cycle.mapId !== current.mapId) {
    throw new Error(`Cannot assign node ${nodeId} to cycle ${cycleId}: different maps`);
  }

  // If the target cycle is active and the node has no status yet, default it
  // to "todo" so adding tickets mid-sprint mirrors the activation sweep above.
  const updates: Record<string, unknown> = { cycleId, updatedAt: new Date() };
  if (cycle.status === 'active' && current.status == null) {
    updates.status = 'todo';
  }

  const [row] = await db.update(nodes)
    .set(updates)
    .where(eq(nodes.id, nodeId))
    .returning();
  if (!row) return null;
  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

export async function unassignNodeFromCycle(nodeId: string): Promise<CoreNode | null> {
  const [row] = await db.update(nodes)
    .set({ cycleId: null, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId))
    .returning();
  if (!row) return null;
  return dbNodeToCore(row as unknown as Record<string, unknown>);
}

// ── Auto-rollover ─────────────────────────────────────────────────────

export async function autoRollover(
  fromCycleId: string,
  toCycleId: string,
): Promise<{ movedCount: number; movedNodeIds: string[] }> {
  // Both cycles must belong to the same map — rollover is strictly per-map.
  const [fromCycle] = await db.select({ mapId: cycles.mapId }).from(cycles).where(eq(cycles.id, fromCycleId));
  const [toCycle] = await db.select({ mapId: cycles.mapId }).from(cycles).where(eq(cycles.id, toCycleId));
  if (!fromCycle || !toCycle) {
    throw new Error('Source or target cycle not found');
  }
  if (fromCycle.mapId !== toCycle.mapId) {
    throw new Error('Cannot roll over between cycles in different maps');
  }

  // Get all nodes in the source cycle
  const sourceNodes = await db.select()
    .from(nodes)
    .where(and(eq(nodes.cycleId, fromCycleId), notDeleted));

  // Filter incomplete nodes (percentComplete < 100 or null)
  const incomplete = sourceNodes.filter((n) => {
    const pct = n.percentComplete;
    return pct === null || pct < 100;
  });

  const movedNodeIds = incomplete.map((n) => n.id);

  if (movedNodeIds.length > 0) {
    const now = new Date();
    for (const id of movedNodeIds) {
      await db.update(nodes)
        .set({ cycleId: toCycleId, updatedAt: now })
        .where(eq(nodes.id, id));
    }
  }

  return { movedCount: movedNodeIds.length, movedNodeIds };
}
