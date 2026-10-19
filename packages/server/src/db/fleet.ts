/**
 * Fleet telemetry store — last-known rollup per (fleet, host) and the
 * orchestrator's recent ticks, keyed by fleet since #479.
 *
 * Snapshots, not a register: a rollup row is overwritten on every push,
 * a tick row is appended and old ones are trimmed. MindBlown never
 * derives fleet topology from this — a host that stops pushing simply
 * goes stale (the card says so) and one that never pushed is unknown.
 *
 * (db/fleets.ts, plural, is the fleet entity itself.)
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { rollupServedMaps } from '@mindblown/core';
import type { FleetRollup, FleetTickPayload } from '@mindblown/core';
import { db } from './connection.js';
import { fleetStatus, fleetTicks } from './schema.js';

/**
 * Ticks are kept by AGE, not by count: the question the history answers is
 * "what happened last night / this week", and a count-based window
 * (formerly 500 rows) silently shrank to hours whenever the orchestrator
 * ran at a faster cadence.
 */
export const TICK_RETENTION_DAYS = 7;
/**
 * Runaway guard on top of the age window — an orchestrator stuck in a
 * tight loop posts thousands of ticks per hour, and the age trim would
 * not stop that until a week later. ~7 days at a 5-min cadence.
 */
export const TICK_HARD_CAP = 2000;

export interface FleetStatusRow {
  host: string;
  generatedAt: string;
  receivedAt: string;
  /** The maps this host serves: v2 names them, v1 serves the map it was pushed for. */
  mapIds: string[];
  rollup: FleetRollup;
}

export interface FleetTickRow {
  id: string;
  tickAt: string;
  receivedAt: string;
  payload: FleetTickPayload;
}

/** `viaMapId` = the map route the rollup came in through; null for the fleet route. */
export async function upsertRollup(fleetId: string, rollup: FleetRollup, viaMapId: string | null): Promise<FleetStatusRow> {
  const generatedAt = new Date(rollup.generated_at);
  const [row] = await db
    .insert(fleetStatus)
    .values({ fleetId, host: rollup.host, mapId: viaMapId, generatedAt, payload: rollup })
    .onConflictDoUpdate({
      target: [fleetStatus.fleetId, fleetStatus.host],
      set: { mapId: viaMapId, generatedAt, payload: rollup, receivedAt: sql`now()` },
    })
    .returning();
  return toStatusRow(row);
}

export async function listRollups(fleetId: string): Promise<FleetStatusRow[]> {
  const rows = await db.select().from(fleetStatus).where(eq(fleetStatus.fleetId, fleetId));
  return rows.map(toStatusRow).sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Ordering and retention go by `received_at` (server clock), never by the
 * caller's `tick_at`: an orchestrator with a wrong clock could otherwise
 * pin "latest tick" forever and push real ticks out of the window.
 */
export async function insertTick(fleetId: string, payload: FleetTickPayload, tickAt: Date, viaMapId: string | null): Promise<FleetTickRow> {
  const [row] = await db.insert(fleetTicks).values({ fleetId, mapId: viaMapId, tickAt, payload }).returning();
  // Trim on every insert — one statement, no cron: older than the window,
  // or beyond the hard cap counted from the newest. Per fleet (#479).
  await db.execute(sql`
    DELETE FROM fleet_ticks
    WHERE fleet_id = ${fleetId}
      AND (
        received_at < now() - make_interval(days => ${TICK_RETENTION_DAYS})
        OR id NOT IN (SELECT id FROM fleet_ticks WHERE fleet_id = ${fleetId} ORDER BY received_at DESC LIMIT ${TICK_HARD_CAP})
      )
  `);
  return toTickRow(row);
}

/** Window on `received_at` (server clock) — same axis as ordering and retention. */
export interface TickListWindow {
  since?: Date | null;
  until?: Date | null;
  limit: number;
}

/**
 * Newest first, capped by `limit`. A plain number is the pre-history
 * signature (`listTicks(fleetId, 20)`); the window form is what the
 * `?since=` read uses.
 */
export async function listTicks(fleetId: string, window: number | TickListWindow = 20): Promise<FleetTickRow[]> {
  const w = typeof window === 'number' ? { limit: window } : window;
  const conds = [eq(fleetTicks.fleetId, fleetId)];
  if (w.since) conds.push(gte(fleetTicks.receivedAt, w.since));
  if (w.until) conds.push(lte(fleetTicks.receivedAt, w.until));
  const rows = await db
    .select()
    .from(fleetTicks)
    .where(and(...conds))
    .orderBy(desc(fleetTicks.receivedAt))
    .limit(w.limit);
  return rows.map(toTickRow);
}

function toStatusRow(r: typeof fleetStatus.$inferSelect): FleetStatusRow {
  const rollup = r.payload as FleetRollup;
  return {
    host: r.host,
    generatedAt: r.generatedAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    mapIds: rollupServedMaps(rollup, r.mapId),
    rollup,
  };
}

function toTickRow(r: typeof fleetTicks.$inferSelect): FleetTickRow {
  return {
    id: r.id,
    tickAt: r.tickAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    payload: r.payload as FleetTickPayload,
  };
}
