import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { changeEvents } from './schema.js';
import type { Node as CoreNode } from '@mindblown/core';

export type EventType =
  | 'node.created'
  | 'node.deleted'
  | 'node.restored'
  | 'node.moved'
  | 'node.field_changed'
  // Version writes (#331): node_id is null, field_name is the version
  // field (name / status / targetDate / sortOrder).
  | 'version.field_changed';

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
  'blockedReason',
  'priority',
  'startDate',
  'dueDate',
  'versionId',
  'cycleId',
  'assigneeIds',
  'phaseId',
  // The Abnahme surface. The Prüfanleitung is the text a customer's
  // signature refers to at a sign-off, and the two URLs are where he was
  // told to look — so an edit after the fact has to leave a trace. The
  // verdicts themselves are already append-only; without these three the
  // register can say who accepted what, but not what "what" said at the
  // time. Not noise either: they're written once and then rarely touched.
  'verificationText',
  'verificationUrl',
  'verificationVideoUrl',
  // The poster is decoration rather than evidence, but it is tracked for
  // the same reason as its video: it is written once and then rarely
  // touched, so it costs the history nothing, and a swapped still is the
  // cheapest way to make a clip look like it shows something it doesn't.
  'verificationVideoPosterUrl',
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

/**
 * Who last touched each node of a map, from the change log.
 *
 * The Workload view needs a person per leaf. `assigneeIds` is the field
 * built for that, but nothing writes it (no UI, and no MCP caller ever
 * has), and `claimedBySession` only holds a value while work is in
 * flight — so on a real map both are empty and the view has nothing to
 * group by. Authorship is the one signal that is actually populated:
 * whoever last edited a node is, in practice, the person carrying it.
 *
 * Falls back to `nodes.created_by` for nodes with no attributed event
 * (imports, seeds, anything predating the change log). Nodes whose only
 * events have a null `user_id` — MCP/agent writes without a session
 * user — are omitted rather than bucketed under a fake actor.
 */
export async function getLastActorByNode(
  mapId: string,
): Promise<Array<{ nodeId: string; userId: string; userName: string }>> {
  const rows = await db.execute(sql`
    with attributed as (
      select distinct on (e.node_id)
        e.node_id, e.user_id
      from change_events e
      where e.map_id = ${mapId} and e.node_id is not null and e.user_id is not null
      order by e.node_id, e.created_at desc
    )
    select n.id as node_id,
           coalesce(a.user_id, n.created_by) as user_id,
           u.name as user_name
    from nodes n
    left join attributed a on a.node_id = n.id
    join users u on u.id = coalesce(a.user_id, n.created_by)
    where n.map_id = ${mapId} and n.deleted_at is null
  `);

  return (rows.rows as Array<{ node_id: string; user_id: string; user_name: string }>).map((r) => ({
    nodeId: r.node_id,
    userId: r.user_id,
    userName: r.user_name,
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
