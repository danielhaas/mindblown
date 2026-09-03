/**
 * Fleet journal loader — collects what core `buildFleetJournal` needs for
 * one map and one window, from the three substrates the fleet writes into:
 *
 *   change_events  — claim trail (node.claimed / released / pr_merged),
 *                    knob writes (map.field_changed), status → blocked
 *   fleet_ticks    — the orchestrator's judgment every ~30 min
 *   nodes          — completed_at / created_at inside the window
 *
 * The claim trail of a delivered node may start before the window (a
 * ticket pulled at 16:50, delivered at 17:30 is "last night's" delivery)
 * so those events are fetched per node over a longer reach, not by the
 * window. The assembly itself is pure and lives in core.
 */
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { buildFleetJournal, JOURNAL_EVENT_TYPES } from '@mindblown/core';
import type { ExternalLink, FleetJournal, FleetTickPayload, JournalEventRow, JournalNodeRow } from '@mindblown/core';
import { db } from '../db/connection.js';
import { changeEvents, fleetTicks, nodes, users, versions } from '../db/schema.js';

/** Longest window a single read serves — a month of a busy fleet is ~1500 ticks and thousands of events. */
export const MAX_WINDOW_MS = 31 * 86_400_000;
/** How far back a delivered node's claim trail is read. */
const TRAIL_REACH_MS = 14 * 86_400_000;
const EVENT_LIMIT = 5000;
const TICK_LIMIT = 2000;

const CLAIM_TRAIL_TYPES = ['node.claimed', 'node.released', 'node.pr_merged'];

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

function toEventRow(r: typeof changeEvents.$inferSelect): JournalEventRow {
  return {
    eventType: r.eventType,
    nodeId: r.nodeId,
    userId: r.userId,
    fieldName: r.fieldName,
    oldValue: r.oldValue,
    newValue: r.newValue,
    createdAt: r.createdAt.toISOString(),
  };
}

function toNodeRow(r: typeof nodes.$inferSelect): JournalNodeRow {
  return {
    id: r.id,
    text: r.text,
    status: r.status,
    completedAt: iso(r.completedAt),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    actualEffort: r.actualEffort,
    effortEstimate: r.effortEstimate,
    priority: r.priority,
    versionId: r.versionId,
    tags: (r.tags as string[]) ?? [],
    externalLinks: (r.externalLinks as ExternalLink[]) ?? [],
    blockedReason: r.blockedReason,
    claimedBySession: r.claimedBySession,
  };
}

export async function loadFleetJournal(mapId: string, from: Date, to: Date): Promise<FleetJournal> {
  const [windowEvents, tickRows, windowNodes] = await Promise.all([
    db
      .select()
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.mapId, mapId),
          gte(changeEvents.createdAt, from),
          lte(changeEvents.createdAt, to),
          or(
            inArray(changeEvents.eventType, [...JOURNAL_EVENT_TYPES]),
            and(eq(changeEvents.eventType, 'node.field_changed'), eq(changeEvents.fieldName, 'status')),
          ),
        ),
      )
      .orderBy(changeEvents.createdAt)
      .limit(EVENT_LIMIT),
    db
      .select()
      .from(fleetTicks)
      .where(and(eq(fleetTicks.mapId, mapId), gte(fleetTicks.receivedAt, from), lte(fleetTicks.receivedAt, to)))
      .orderBy(fleetTicks.receivedAt)
      .limit(TICK_LIMIT),
    db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.mapId, mapId),
          isNull(nodes.deletedAt),
          or(
            and(gte(nodes.completedAt, from), lte(nodes.completedAt, to)),
            and(gte(nodes.createdAt, from), lte(nodes.createdAt, to)),
          ),
        ),
      ),
  ]);

  // Nodes the events point at but the window did not select (a release of
  // something created weeks ago), and the pre-window trail of delivered nodes.
  const have = new Set(windowNodes.map((n) => n.id));
  const eventNodeIds = [...new Set(windowEvents.map((e) => e.nodeId).filter((id): id is string => !!id && !have.has(id)))];
  const deliveredIds = windowNodes.filter((n) => n.completedAt && n.completedAt >= from && n.completedAt <= to).map((n) => n.id);

  const [extraNodes, trailEvents] = await Promise.all([
    eventNodeIds.length > 0
      ? db.select().from(nodes).where(and(eq(nodes.mapId, mapId), inArray(nodes.id, eventNodeIds)))
      : Promise.resolve([] as (typeof nodes.$inferSelect)[]),
    deliveredIds.length > 0
      ? db
          .select()
          .from(changeEvents)
          .where(
            and(
              eq(changeEvents.mapId, mapId),
              inArray(changeEvents.nodeId, deliveredIds),
              inArray(changeEvents.eventType, CLAIM_TRAIL_TYPES),
              gte(changeEvents.createdAt, new Date(from.getTime() - TRAIL_REACH_MS)),
              lte(changeEvents.createdAt, to),
            ),
          )
          .orderBy(changeEvents.createdAt)
          .limit(EVENT_LIMIT)
      : Promise.resolve([] as (typeof changeEvents.$inferSelect)[]),
  ]);

  const seen = new Set(windowEvents.map((e) => e.id));
  const allEvents = [...windowEvents, ...trailEvents.filter((e) => !seen.has(e.id))];
  const allNodes = [...windowNodes, ...extraNodes];

  const userIds = [...new Set([...allEvents.map((e) => e.userId), ...allNodes.map((n) => n.createdBy)].filter((id): id is string => !!id))];
  const [userRows, versionRows] = await Promise.all([
    userIds.length > 0 ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : Promise.resolve([]),
    db.select({ id: versions.id, name: versions.name }).from(versions).where(eq(versions.mapId, mapId)),
  ]);

  return buildFleetJournal({
    window: { from, to },
    ticks: tickRows.map((t) => ({ tickAt: t.tickAt.toISOString(), receivedAt: t.receivedAt.toISOString(), payload: t.payload as FleetTickPayload })),
    events: allEvents.map(toEventRow),
    nodes: allNodes.map(toNodeRow),
    versions: versionRows,
    users: userRows,
  });
}

/**
 * Parse `?from=&to=` (ISO 8601). Defaults: to = now, from = to − 24 h.
 * Refuses unparsable dates, an inverted window, and one longer than
 * MAX_WINDOW_MS — a year-long read would scan every event of the map.
 */
export function parseJournalWindow(q: { from?: unknown; to?: unknown }, now = new Date()): { from: Date; to: Date } | { error: string } {
  const parse = (x: unknown, name: string): Date | { error: string } | null => {
    if (x === undefined || x === null || x === '') return null;
    if (typeof x !== 'string') return { error: `${name} must be an ISO 8601 date` };
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? { error: `${name} is not an ISO 8601 date: "${x}"` } : d;
  };
  const toP = parse(q.to, 'to');
  if (toP && !(toP instanceof Date)) return toP;
  const to = toP ?? now;
  const fromP = parse(q.from, 'from');
  if (fromP && !(fromP instanceof Date)) return fromP;
  const from = fromP ?? new Date(to.getTime() - 24 * 3_600_000);
  if (from.getTime() > to.getTime()) return { error: 'from must not be after to' };
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) return { error: 'window must not exceed 31 days' };
  return { from, to };
}
