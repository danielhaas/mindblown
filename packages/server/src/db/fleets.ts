/**
 * Fleets (#477) — the entity several maps share. Plain persistence; who may
 * read or change what is decided in services/fleets.ts.
 *
 * (db/fleet.ts, singular, is the telemetry store: rollups and ticks.)
 */
import { asc, eq, inArray, or } from 'drizzle-orm';
import type { Fleet } from '@mindblown/core';
import { db } from './connection.js';
import { fleets, maps, users } from './schema.js';
import { dbFleetToCore } from './helpers.js';

/** Postgres rejects a malformed uuid with an error; callers get "not found" instead. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isFleetId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id);

export interface FleetMapRow {
  id: string;
  name: string;
  fleetShare: number;
  maxActiveClaims: number;
  archivedAt: string | null;
}

export async function getFleet(id: string): Promise<Fleet | null> {
  if (!isFleetId(id)) return null;
  const [row] = await db.select().from(fleets).where(eq(fleets.id, id));
  return row ? dbFleetToCore(row as unknown as Record<string, unknown>) : null;
}

/** Fleets the user owns plus the given ids (fleets of maps the user can view). */
export async function listFleetsByOwnerOrIds(ownerId: string, ids: string[]): Promise<Fleet[]> {
  const where = ids.length > 0 ? or(eq(fleets.ownerId, ownerId), inArray(fleets.id, ids)) : eq(fleets.ownerId, ownerId);
  const rows = await db.select().from(fleets).where(where).orderBy(asc(fleets.createdAt));
  return rows.map((r) => dbFleetToCore(r as unknown as Record<string, unknown>));
}

/** The fleet a map is connected to; null when none (or no such map). */
export async function getMapFleetId(mapId: string): Promise<string | null> {
  const [row] = await db.select({ fleetId: maps.fleetId }).from(maps).where(eq(maps.id, mapId));
  return row?.fleetId ?? null;
}

/** Every map connected to the fleet, oldest first. */
export async function listFleetMaps(fleetId: string): Promise<FleetMapRow[]> {
  const rows = await db
    .select({
      id: maps.id,
      name: maps.name,
      fleetShare: maps.fleetShare,
      maxActiveClaims: maps.maxActiveClaims,
      archivedAt: maps.archivedAt,
    })
    .from(maps)
    .where(eq(maps.fleetId, fleetId))
    .orderBy(asc(maps.createdAt));
  return rows.map((r) => ({ ...r, archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null }));
}

/**
 * Create a fleet together with its service user (#481): kind 'fleet', no
 * password (it can't sign in), an address no mailbox or OAuth login can
 * claim. The fleet's API keys act as this user.
 */
export async function createFleet(input: { name: string; ownerId: string; maxActiveClaims?: number }): Promise<Fleet> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fleets)
      .values({
        name: input.name,
        ownerId: input.ownerId,
        maxActiveClaims: Math.max(0, Math.floor(input.maxActiveClaims ?? 0)),
      })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({ email: `fleet-${row.id}@fleets.invalid`, name: `Fleet: ${input.name}`, kind: 'fleet' })
      .returning({ id: users.id });
    await tx.update(fleets).set({ serviceUserId: user.id }).where(eq(fleets.id, row.id));
    return dbFleetToCore(row as unknown as Record<string, unknown>);
  });
}

/** The fleet's service user id; null when the fleet has none (or doesn't exist). */
export async function getServiceUserId(fleetId: string): Promise<string | null> {
  if (!isFleetId(fleetId)) return null;
  const [row] = await db.select({ id: fleets.serviceUserId }).from(fleets).where(eq(fleets.id, fleetId));
  return row?.id ?? null;
}

/** True for a fleet's service user (users.kind = 'fleet', #481). */
export async function isFleetUser(userId: string): Promise<boolean> {
  const [row] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  return row?.kind === 'fleet';
}

/** Which fleet this user is the service identity of — null for a person. */
export async function fleetOfServiceUser(userId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: fleets.id, name: fleets.name }).from(fleets).where(eq(fleets.serviceUserId, userId));
  return row ?? null;
}

export async function updateFleet(id: string, input: { name?: string; maxActiveClaims?: number }): Promise<Fleet | null> {
  if (!isFleetId(id)) return null;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.maxActiveClaims !== undefined) updates.maxActiveClaims = Math.max(0, Math.floor(input.maxActiveClaims));
  const [row] = await db.update(fleets).set(updates).where(eq(fleets.id, id)).returning();
  return row ? dbFleetToCore(row as unknown as Record<string, unknown>) : null;
}

/**
 * Connected maps fall back to no fleet (FK ON DELETE SET NULL). The service
 * user goes with the fleet — its keys and grants cascade with it.
 */
export async function deleteFleet(id: string): Promise<boolean> {
  if (!isFleetId(id)) return false;
  const rows = await db.delete(fleets).where(eq(fleets.id, id)).returning({ id: fleets.id, serviceUserId: fleets.serviceUserId });
  if (rows[0]?.serviceUserId) await db.delete(users).where(eq(users.id, rows[0].serviceUserId));
  return rows.length > 0;
}
