import { eq, asc, and } from 'drizzle-orm';
import { db } from './connection.js';
import { milestones, nodes } from './schema.js';
import type { Milestone } from '@mindblown/core';

// ── Helpers ───────────────────────────────────────────────────────────

function dbMilestoneToCore(row: Record<string, unknown>): Milestone {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: get('id', 'id') as string,
    versionId: (get('versionId', 'version_id') as string) ?? null,
    workspaceId: get('workspaceId', 'workspace_id') as string,
    name: get('name', 'name') as string,
    description: (get('description', 'description') as string) ?? null,
    status: get('status', 'status') as Milestone['status'],
    targetDate: (get('targetDate', 'target_date') as string) ?? null,
    sortOrder: (get('sortOrder', 'sort_order') as number) ?? 0,
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
  };
}

// ── Create ────────────────────────────────────────────────────────────

export interface CreateMilestoneInput {
  workspaceId: string;
  versionId?: string | null;
  name: string;
  description?: string;
  status?: Milestone['status'];
  targetDate?: string;
  sortOrder?: number;
}

export async function createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
  const [row] = await db.insert(milestones).values({
    workspaceId: input.workspaceId,
    versionId: input.versionId ?? null,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'open',
    targetDate: input.targetDate ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: new Date(),
  }).returning();

  return dbMilestoneToCore(row as unknown as Record<string, unknown>);
}

// ── List ──────────────────────────────────────────────────────────────

export async function listMilestones(workspaceId: string, versionId?: string): Promise<Milestone[]> {
  const conditions = [eq(milestones.workspaceId, workspaceId)];
  if (versionId) {
    conditions.push(eq(milestones.versionId, versionId));
  }

  const rows = await db.select()
    .from(milestones)
    .where(and(...conditions))
    .orderBy(asc(milestones.sortOrder));

  return rows.map((r) => dbMilestoneToCore(r as unknown as Record<string, unknown>));
}

// ── Get ───────────────────────────────────────────────────────────────

export async function getMilestone(id: string): Promise<Milestone | null> {
  const [row] = await db.select().from(milestones).where(eq(milestones.id, id));
  if (!row) return null;
  return dbMilestoneToCore(row as unknown as Record<string, unknown>);
}

// ── Update ────────────────────────────────────────────────────────────

export interface UpdateMilestoneInput {
  name?: string;
  description?: string | null;
  versionId?: string | null;
  status?: Milestone['status'];
  targetDate?: string | null;
  sortOrder?: number;
}

export async function updateMilestone(id: string, input: UpdateMilestoneInput): Promise<Milestone | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.versionId !== undefined) updates.versionId = input.versionId;
  if (input.status !== undefined) updates.status = input.status;
  if (input.targetDate !== undefined) updates.targetDate = input.targetDate;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

  const [row] = await db.update(milestones).set(updates).where(eq(milestones.id, id)).returning();
  if (!row) return null;
  return dbMilestoneToCore(row as unknown as Record<string, unknown>);
}

// ── Delete ────────────────────────────────────────────────────────────

export async function deleteMilestone(id: string): Promise<boolean> {
  // Unset milestoneId on nodes referencing this milestone
  await db.update(nodes)
    .set({ milestoneId: null, updatedAt: new Date() })
    .where(eq(nodes.milestoneId, id));

  const rows = await db.delete(milestones).where(eq(milestones.id, id)).returning();
  return rows.length > 0;
}
