import { eq, asc, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { invalidateMapContext } from '../sync/mapContext.js';
import { versions, cycles, nodes, maps } from './schema.js';
import { compareVersions, findVersionOrderInversions } from '@mindblown/core';
import type { Version } from '@mindblown/core';
import { recordEvent } from './events.js';

// ── Helpers ───────────────────────────────────────────────────────────

function dbVersionToCore(row: Record<string, unknown>): Version {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: get('id', 'id') as string,
    mapId: get('mapId', 'map_id') as string,
    name: get('name', 'name') as string,
    description: (get('description', 'description') as string) ?? null,
    status: get('status', 'status') as Version['status'],
    targetDate: (get('targetDate', 'target_date') as string) ?? null,
    sortOrder: (get('sortOrder', 'sort_order') as number) ?? 0,
    releasedAt: (() => {
      const v = get('releasedAt', 'released_at');
      return v instanceof Date ? v.toISOString() : ((v as string) ?? null);
    })(),
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
    updatedAt: (() => {
      const v = get('updatedAt', 'updated_at');
      return v instanceof Date ? v.toISOString() : ((v as string) ?? null);
    })(),
  };
}

/**
 * Order lint for the write path (#331): the map's versions whose target
 * dates contradict their sortOrder / name order, as ready-to-show text.
 * Never blocks a write — dates may legitimately leapfrog — but the caller
 * is expected to surface it (REST `warnings`, MCP tool text).
 */
export async function orderWarnings(mapId: string): Promise<string[]> {
  const all = await listVersions(mapId);
  return findVersionOrderInversions(all).map((i) => i.reason);
}

async function workspaceIdForMap(mapId: string): Promise<string | null> {
  const [row] = await db.select({ workspaceId: maps.workspaceId }).from(maps).where(eq(maps.id, mapId));
  return row?.workspaceId ?? null;
}

// ── Create ────────────────────────────────────────────────────────────

export interface CreateVersionInput {
  mapId: string;
  name: string;
  description?: string;
  status?: Version['status'];
  targetDate?: string;
  sortOrder?: number;
}

export async function createVersion(input: CreateVersionInput): Promise<Version> {
  const workspaceId = await workspaceIdForMap(input.mapId);
  if (!workspaceId) {
    throw new Error(`Map ${input.mapId} not found`);
  }

  const [row] = await db.insert(versions).values({
    workspaceId,
    mapId: input.mapId,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'planning',
    targetDate: input.targetDate ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();

  // The triage prompt's lane list comes from the mapContext cache —
  // drop it so the next ingest sees the new lane inside the 5-min TTL.
  invalidateMapContext(input.mapId);
  return dbVersionToCore(row as unknown as Record<string, unknown>);
}

// ── List ──────────────────────────────────────────────────────────────

export async function listVersions(mapId: string): Promise<Version[]> {
  // Release order: target date ascending, undated last. Sorted in SQL so
  // paging/streaming callers see the same order, then re-sorted through
  // compareVersions so the semver tiebreak matches the forecast chain.
  const rows = await db.select()
    .from(versions)
    .where(eq(versions.mapId, mapId))
    .orderBy(sql`${versions.targetDate} asc nulls last`, asc(versions.sortOrder), asc(versions.name));

  return rows
    .map((r) => dbVersionToCore(r as unknown as Record<string, unknown>))
    .sort(compareVersions);
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

/** Version fields whose edits land in change_events (#331). */
const AUDITED_VERSION_FIELDS = ['name', 'status', 'targetDate', 'sortOrder'] as const;

export async function updateVersion(
  id: string,
  input: UpdateVersionInput,
  userId: string | null = null,
): Promise<Version | null> {
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;
  if (input.targetDate !== undefined) updates.targetDate = input.targetDate;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

  const current = await getVersion(id);
  if (!current) return null;

  // Ship-date ground truth for the forecast scorecard: stamp released_at
  // on the transition INTO 'released'; clear it when a release is
  // reopened (the old date would be a lie the scorecard trains on).
  if (input.status !== undefined) {
    if (input.status === 'released' && current.status !== 'released') {
      updates.releasedAt = new Date();
    } else if (input.status !== 'released' && current.status === 'released') {
      updates.releasedAt = null;
    }
  }

  updates.updatedAt = new Date();

  const [row] = await db.update(versions).set(updates).where(eq(versions.id, id)).returning();
  if (!row) return null;
  const updated = dbVersionToCore(row as unknown as Record<string, unknown>);
  // Rename / status flip changes what the triage prompt may offer.
  invalidateMapContext(updated.mapId);

  // Audit trail (#331): one change_events row per audited field that
  // actually changed. Before this the only trace of a re-dated release
  // was release_snapshots.target_date. recordEvent never throws.
  for (const field of AUDITED_VERSION_FIELDS) {
    const oldVal = current[field] ?? null;
    const newVal = updated[field] ?? null;
    if (oldVal === newVal) continue;
    await recordEvent({
      mapId: updated.mapId,
      nodeId: null,
      userId,
      eventType: 'version.field_changed',
      fieldName: field,
      oldValue: oldVal,
      newValue: newVal,
    });
  }
  return updated;
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
  if (rows.length > 0) {
    const mapId = (rows[0] as { mapId?: string; map_id?: string }).mapId ??
      (rows[0] as { map_id?: string }).map_id;
    if (mapId) invalidateMapContext(mapId);
  }
  return rows.length > 0;
}
