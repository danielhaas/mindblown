/**
 * Fleets (#477) — the entity several maps share. Plain persistence; who may
 * read or change what is decided in services/fleets.ts.
 *
 * (db/fleet.ts, singular, is the telemetry store: rollups and ticks.)
 */
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Fleet } from '@mindblown/core';
import { db } from './connection.js';
import { apiKeys, fleets, mapPermissions, maps, nodes, users } from './schema.js';
import { invalidateApiKeyCache } from '../lib/apiKeys.js';
import { dbFleetToCore } from './helpers.js';
import { holdsCapSlotSql } from './capSlot.js';

/**
 * Claims held right now on every map of the fleet — what its cap is
 * measured against (the pull counts the same way, services/orchestration).
 */
export async function countActiveClaims(fleetId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .innerJoin(maps, eq(nodes.mapId, maps.id))
    .where(and(eq(maps.fleetId, fleetId), isNull(nodes.deletedAt), holdsCapSlotSql()));
  return Number(row?.n ?? 0);
}

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

/** A map's fleet and archive state, without its nodes; null when no such map. */
export async function getMapFleetState(
  mapId: string,
): Promise<{ fleetId: string | null; archivedAt: Date | null; createdBy: string } | null> {
  if (!isFleetId(mapId)) return null;
  const [row] = await db
    .select({ fleetId: maps.fleetId, archivedAt: maps.archivedAt, createdBy: maps.createdBy })
    .from(maps)
    .where(eq(maps.id, mapId));
  return row ?? null;
}

/** Fleets with auto-check blockers on (#576), with their owner. */
export async function listAutoCheckFleets(): Promise<Array<{ id: string; ownerId: string }>> {
  return db.select({ id: fleets.id, ownerId: fleets.ownerId }).from(fleets).where(eq(fleets.autoCheckBlockers, true));
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
  // The owner is a person: a fleet key must not own fleets (REST and chat alike).
  if (await isFleetUser(input.ownerId)) throw new FleetUserForbiddenError('fleets');
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

/** A deleted fleet's service user: kept for the history it wrote, never usable again. */
export const FLEET_RETIRED = 'fleet_retired';

/** True for a fleet's service user, active or retired (#481). */
export async function isFleetUser(userId: string): Promise<boolean> {
  const [row] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  return row?.kind === 'fleet' || row?.kind === FLEET_RETIRED;
}

/** Thrown by a create on behalf of a fleet's service user — every path, REST or chat (#481). */
export class FleetUserForbiddenError extends Error {
  constructor(what: string) {
    super(`A fleet key cannot create ${what}`);
    this.name = 'FleetUserForbiddenError';
  }
}

/** Which fleet this user is the service identity of — null for a person. */
export async function fleetOfServiceUser(userId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: fleets.id, name: fleets.name }).from(fleets).where(eq(fleets.serviceUserId, userId));
  return row ?? null;
}

export async function updateFleet(id: string, input: { name?: string; maxActiveClaims?: number; autoCheckBlockers?: boolean }): Promise<Fleet | null> {
  if (!isFleetId(id)) return null;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.maxActiveClaims !== undefined) updates.maxActiveClaims = Math.max(0, Math.floor(input.maxActiveClaims));
  if (input.autoCheckBlockers !== undefined) updates.autoCheckBlockers = input.autoCheckBlockers;
  const [row] = await db.update(fleets).set(updates).where(eq(fleets.id, id)).returning();
  return row ? dbFleetToCore(row as unknown as Record<string, unknown>) : null;
}

/**
 * Connected maps fall back to no fleet (FK ON DELETE SET NULL). The service
 * user is retired with the fleet, in the same transaction: every key
 * revoked, every grant gone, kind 'fleet_retired'. Not deleted — nodes,
 * comments and acceptances it wrote reference it (no cascade), and the
 * history keeps its name.
 */
export async function deleteFleet(id: string): Promise<boolean> {
  if (!isFleetId(id)) return false;
  const revokedKeyIds: string[] = [];
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx.delete(fleets).where(eq(fleets.id, id)).returning({ id: fleets.id, serviceUserId: fleets.serviceUserId });
    const userId = rows[0]?.serviceUserId;
    if (userId) {
      const keys = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      revokedKeyIds.push(...keys.map((k) => k.id));
      await tx.delete(mapPermissions).where(eq(mapPermissions.userId, userId));
      await tx.update(users).set({ kind: FLEET_RETIRED }).where(eq(users.id, userId));
    }
    return rows.length > 0;
  });
  // After commit: a validated key sits in the auth cache for up to a minute.
  for (const keyId of revokedKeyIds) invalidateApiKeyCache(keyId);
  return deleted;
}
