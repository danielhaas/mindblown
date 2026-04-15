import { eq, asc, and, isNull } from 'drizzle-orm';
import { db } from './connection.js';
import { cycles, nodes } from './schema.js';
import { dbNodeToCore } from './helpers.js';
import type { Cycle, Node as CoreNode } from '@mindblown/core';

// ── Helpers ───────────────────────────────────────────────────────────

function dbCycleToCore(row: Record<string, unknown>): Cycle {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: get('id', 'id') as string,
    workspaceId: get('workspaceId', 'workspace_id') as string,
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

// ── Create ────────────────────────────────────────────────────────────

export async function createCycle(
  workspaceId: string,
  name: string,
  startDate: string,
  endDate: string,
  versionId?: string | null,
): Promise<Cycle> {
  const [row] = await db.insert(cycles).values({
    workspaceId,
    name,
    startDate,
    endDate,
    versionId: versionId ?? null,
    createdAt: new Date(),
  }).returning();

  return dbCycleToCore(row as unknown as Record<string, unknown>);
}

// ── List ──────────────────────────────────────────────────────────────

export async function listCycles(workspaceId: string): Promise<Cycle[]> {
  const rows = await db.select()
    .from(cycles)
    .where(eq(cycles.workspaceId, workspaceId))
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

export async function updateCycle(id: string, input: UpdateCycleInput): Promise<Cycle | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.startDate !== undefined) updates.startDate = input.startDate;
  if (input.endDate !== undefined) updates.endDate = input.endDate;
  if (input.status !== undefined) updates.status = input.status;
  if (input.versionId !== undefined) updates.versionId = input.versionId;

  const [row] = await db.update(cycles).set(updates).where(eq(cycles.id, id)).returning();
  if (!row) return null;

  // When a cycle becomes active, default any unset assigned nodes to "todo"
  // so they show up in the Kanban Todo column instead of "Unset". Idempotent
  // — only touches nodes whose status is currently null.
  if (input.status === 'active') {
    await db.update(nodes)
      .set({ status: 'todo', updatedAt: new Date() })
      .where(and(eq(nodes.cycleId, id), isNull(nodes.status)));
  }

  return dbCycleToCore(row as unknown as Record<string, unknown>);
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
    .where(eq(nodes.cycleId, cycleId));

  return rows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));
}

// ── Assign / Unassign ─────────────────────────────────────────────────

export async function assignNodeToCycle(nodeId: string, cycleId: string): Promise<CoreNode | null> {
  // If the target cycle is active and the node has no status yet, default it
  // to "todo" so adding tickets mid-sprint mirrors the activation sweep above.
  const [cycle] = await db.select({ status: cycles.status }).from(cycles).where(eq(cycles.id, cycleId));
  const [current] = await db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId));

  const updates: Record<string, unknown> = { cycleId, updatedAt: new Date() };
  if (cycle?.status === 'active' && current?.status == null) {
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
  // Get all nodes in the source cycle
  const sourceNodes = await db.select()
    .from(nodes)
    .where(eq(nodes.cycleId, fromCycleId));

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
