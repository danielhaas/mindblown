/**
 * Fleet telemetry store — last-known rollup per (map, host) and the
 * orchestrator's recent ticks.
 *
 * Snapshots, not a register: a rollup row is overwritten on every push,
 * a tick row is appended and old ones are trimmed. MindBlown never
 * derives fleet topology from this — a host that stops pushing simply
 * goes stale (the card says so) and one that never pushed is unknown.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { fleetStatus, fleetTicks } from './schema.js';
import type { FleetRollup, FleetTickPayload } from '@mindblown/core';

/** Ticks kept per map — ~10 days at the orchestrator's 30-min cadence. */
export const TICK_RETENTION = 500;

export interface FleetStatusRow {
  host: string;
  generatedAt: string;
  receivedAt: string;
  rollup: FleetRollup;
}

export interface FleetTickRow {
  id: string;
  tickAt: string;
  receivedAt: string;
  payload: FleetTickPayload;
}

export async function upsertRollup(mapId: string, rollup: FleetRollup): Promise<FleetStatusRow> {
  const generatedAt = new Date(rollup.generated_at);
  const [row] = await db
    .insert(fleetStatus)
    .values({ mapId, host: rollup.host, generatedAt, payload: rollup })
    .onConflictDoUpdate({
      target: [fleetStatus.mapId, fleetStatus.host],
      set: { generatedAt, payload: rollup, receivedAt: sql`now()` },
    })
    .returning();
  return toStatusRow(row);
}

export async function listRollups(mapId: string): Promise<FleetStatusRow[]> {
  const rows = await db.select().from(fleetStatus).where(eq(fleetStatus.mapId, mapId));
  return rows.map(toStatusRow).sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Ordering and retention go by `received_at` (server clock), never by the
 * caller's `tick_at`: an orchestrator with a wrong clock could otherwise
 * pin "latest tick" forever and push real ticks out of the window.
 */
export async function insertTick(mapId: string, payload: FleetTickPayload, tickAt: Date): Promise<FleetTickRow> {
  const [row] = await db.insert(fleetTicks).values({ mapId, tickAt, payload }).returning();
  // Trim beyond the retention window — one statement, no cron.
  await db.execute(sql`
    DELETE FROM fleet_ticks
    WHERE map_id = ${mapId}
      AND id NOT IN (SELECT id FROM fleet_ticks WHERE map_id = ${mapId} ORDER BY received_at DESC LIMIT ${TICK_RETENTION})
  `);
  return toTickRow(row);
}

export async function listTicks(mapId: string, limit = 20): Promise<FleetTickRow[]> {
  const rows = await db
    .select()
    .from(fleetTicks)
    .where(eq(fleetTicks.mapId, mapId))
    .orderBy(desc(fleetTicks.receivedAt))
    .limit(limit);
  return rows.map(toTickRow);
}

function toStatusRow(r: typeof fleetStatus.$inferSelect): FleetStatusRow {
  return {
    host: r.host,
    generatedAt: r.generatedAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    rollup: r.payload as FleetRollup,
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
