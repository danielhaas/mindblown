import { eq, asc } from 'drizzle-orm';
import { db } from './connection.js';
import { versions, cycles, nodes } from './schema.js';
import type { Version } from '@mindblown/core';

// ── Helpers ───────────────────────────────────────────────────────────

function dbVersionToCore(row: Record<string, unknown>): Version {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: get('id', 'id') as string,
    workspaceId: get('workspaceId', 'workspace_id') as string,
    name: get('name', 'name') as string,
    description: (get('description', 'description') as string) ?? null,
    status: get('status', 'status') as Version['status'],
    targetDate: (get('targetDate', 'target_date') as string) ?? null,
    sortOrder: (get('sortOrder', 'sort_order') as number) ?? 0,
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
  };
}

// ── Create ────────────────────────────────────────────────────────────

export interface CreateVersionInput {
  workspaceId: string;
  name: string;
  description?: string;
  status?: Version['status'];
  targetDate?: string;
  sortOrder?: number;
}

export async function createVersion(input: CreateVersionInput): Promise<Version> {
  const [row] = await db.insert(versions).values({
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'planning',
    targetDate: input.targetDate ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: new Date(),
  }).returning();

  return dbVersionToCore(row as unknown as Record<string, unknown>);
}

// ── List ──────────────────────────────────────────────────────────────

export async function listVersions(workspaceId: string): Promise<Version[]> {
  const rows = await db.select()
    .from(versions)
    .where(eq(versions.workspaceId, workspaceId))
    .orderBy(asc(versions.sortOrder));

  return rows.map((r) => dbVersionToCore(r as unknown as Record<string, unknown>));
}

// ── Get ───────────────────────────────────────────────────────────────

export async function getVersion(id: string): Promise<Version | null> {
  const [row] = await db.select().from(versions).where(eq(versions.id, id));
  if (!row) return null;
  return dbVersionToCore(row as unknown as Record<string, unknown>);
}

// ── Update ────────────────────────────────────────────────────────────

export interface UpdateVersionInput {
  name?: string;
  description?: string | null;
  status?: Version['status'];
  targetDate?: string | null;
  sortOrder?: number;
}

export async function updateVersion(id: string, input: UpdateVersionInput): Promise<Version | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;
  if (input.targetDate !== undefined) updates.targetDate = input.targetDate;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

  const [row] = await db.update(versions).set(updates).where(eq(versions.id, id)).returning();
  if (!row) return null;
  return dbVersionToCore(row as unknown as Record<string, unknown>);
}

// ── Delete ────────────────────────────────────────────────────────────

export async function deleteVersion(id: string): Promise<boolean> {
  // Unset versionId on cycles and nodes referencing this version
  await db.update(cycles)
    .set({ versionId: null })
    .where(eq(cycles.versionId, id));
  await db.update(nodes)
    .set({ versionId: null, updatedAt: new Date() })
    .where(eq(nodes.versionId, id));

  const rows = await db.delete(versions).where(eq(versions.id, id)).returning();
  return rows.length > 0;
}
