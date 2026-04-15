import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { changeEvents } from './schema.js';
import type { Node as CoreNode } from '@mindblown/core';

export type EventType = 'node.created' | 'node.deleted' | 'node.moved' | 'node.field_changed';

export interface ChangeEvent {
  id: string;
  mapId: string;
  nodeId: string | null;
  userId: string | null;
  eventType: EventType;
  fieldName: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

// Fields that participate in the change log. Anything not on this list is
// considered noise (x/y, collapsed, description, tags, dependencies,
// externalLinks — they mutate often or aren't interesting for MI).
export const TRACKED_FIELDS = new Set<keyof CoreNode>([
  'text',
  'effortEstimate',
  'actualEffort',
  'percentComplete',
  'status',
  'priority',
  'startDate',
  'dueDate',
  'versionId',
  'cycleId',
  'assigneeIds',
]);

function valuesDiffer(a: unknown, b: unknown): boolean {
  // Fast path for primitives + nulls.
  if (a === b) return false;
  if (a == null && b == null) return false;
  // Arrays/objects — JSON compare. Good enough for the fields we track.
  return JSON.stringify(a) !== JSON.stringify(b);
}

export async function recordEvent(row: {
  mapId: string;
  nodeId: string | null;
  userId: string | null;
  eventType: EventType;
  fieldName?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}): Promise<void> {
  try {
    await db.insert(changeEvents).values({
      mapId: row.mapId,
      nodeId: row.nodeId,
      userId: row.userId,
      eventType: row.eventType,
      fieldName: row.fieldName ?? null,
      oldValue: row.oldValue ?? null,
      newValue: row.newValue ?? null,
    });
  } catch (err) {
    // Never let logging failure break a mutation.
    console.error('[change-events] failed to record event:', err);
  }
}

/**
 * Diff old vs new node and emit one field_changed event per tracked field
 * that actually changed.
 */
export async function recordFieldChanges(
  mapId: string,
  nodeId: string,
  userId: string | null,
  oldNode: Partial<CoreNode>,
  newNode: Partial<CoreNode>,
): Promise<void> {
  const events: Array<Parameters<typeof recordEvent>[0]> = [];
  for (const field of TRACKED_FIELDS) {
    const oldVal = (oldNode as Record<string, unknown>)[field];
    const newVal = (newNode as Record<string, unknown>)[field];
    if (valuesDiffer(oldVal, newVal)) {
      events.push({
        mapId,
        nodeId,
        userId,
        eventType: 'node.field_changed',
        fieldName: field,
        oldValue: oldVal ?? null,
        newValue: newVal ?? null,
      });
    }
  }
  for (const e of events) await recordEvent(e);
}

export interface ListEventsOptions {
  mapId: string;
  nodeId?: string;
  eventType?: EventType;
  fieldName?: string;
  since?: Date;
  limit?: number;
}

export async function listEvents(opts: ListEventsOptions): Promise<ChangeEvent[]> {
  const conditions = [eq(changeEvents.mapId, opts.mapId)];
  if (opts.nodeId) conditions.push(eq(changeEvents.nodeId, opts.nodeId));
  if (opts.eventType) conditions.push(eq(changeEvents.eventType, opts.eventType));
  if (opts.fieldName) conditions.push(eq(changeEvents.fieldName, opts.fieldName));
  if (opts.since) conditions.push(gte(changeEvents.createdAt, opts.since));

  const rows = await db
    .select()
    .from(changeEvents)
    .where(and(...conditions))
    .orderBy(desc(changeEvents.createdAt))
    .limit(opts.limit ?? 200);

  return rows.map((r) => ({
    id: r.id,
    mapId: r.mapId,
    nodeId: r.nodeId,
    userId: r.userId,
    eventType: r.eventType as EventType,
    fieldName: r.fieldName,
    oldValue: r.oldValue,
    newValue: r.newValue,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Count events per event_type + field for a scope. Used by digest/burnup. */
export async function countEventsByType(
  mapId: string,
  since: Date,
): Promise<Array<{ eventType: string; fieldName: string | null; count: number }>> {
  const rows = await db
    .select({
      eventType: changeEvents.eventType,
      fieldName: changeEvents.fieldName,
      count: sql<number>`count(*)::int`,
    })
    .from(changeEvents)
    .where(and(eq(changeEvents.mapId, mapId), gte(changeEvents.createdAt, since)))
    .groupBy(changeEvents.eventType, changeEvents.fieldName);
  return rows;
}
