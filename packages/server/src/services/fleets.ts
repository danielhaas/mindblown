/**
 * Fleets (#477) — who may see and change a fleet, and the reader-specific
 * view of one. Shared by the REST routes and the in-app chat backend so the
 * two can't drift.
 *
 * Rules:
 *   - the owner administers the fleet (rename, cap, delete, connect maps);
 *   - anyone with view on at least one connected map may read it, and sees
 *     only the connected maps they can view (the rest are a count);
 *   - connecting or disconnecting a map needs admin on the map, and
 *     connecting needs ownership of the target fleet as well.
 */
import type { Fleet, FleetWithMaps } from '@mindblown/core';
import * as fleetDb from '../db/fleets.js';
import * as mapDb from '../db/maps.js';
import * as permDb from '../db/permissions.js';

export interface FleetAccessError {
  status: 403 | 404;
  code: 'FORBIDDEN' | 'FLEET_NOT_FOUND';
  message: string;
}

const notFound = (fleetId: string): FleetAccessError => ({
  status: 404,
  code: 'FLEET_NOT_FOUND',
  message: `Fleet ${fleetId} not found`,
});

async function withMaps(fleet: Fleet, userId: string, visibleMapIds: Set<string>): Promise<FleetWithMaps> {
  const connected = await fleetDb.listFleetMaps(fleet.id);
  const maps = connected.filter((m) => visibleMapIds.has(m.id));
  return { ...fleet, maps, hiddenMapCount: connected.length - maps.length, isOwner: fleet.ownerId === userId };
}

async function visibleMapIdsFor(userId: string): Promise<{ ids: Set<string>; fleetIds: string[] }> {
  const maps = await mapDb.listMapsForUser(userId);
  const fleetIds = [...new Set(maps.map((m) => m.fleetId).filter((id): id is string => !!id))];
  return { ids: new Set(maps.map((m) => m.id)), fleetIds };
}

/** Fleets the user owns or whose maps the user can view. */
export async function listFleetsForUser(userId: string): Promise<FleetWithMaps[]> {
  const visible = await visibleMapIdsFor(userId);
  const fleets = await fleetDb.listFleetsByOwnerOrIds(userId, visible.fleetIds);
  return Promise.all(fleets.map((f) => withMaps(f, userId, visible.ids)));
}

/**
 * One fleet as this reader sees it. A fleet the reader may not read is
 * reported as not found, so its existence doesn't leak.
 */
export async function getFleetForUser(userId: string, fleetId: string): Promise<FleetWithMaps | FleetAccessError> {
  const fleet = await fleetDb.getFleet(fleetId);
  if (!fleet) return notFound(fleetId);
  const visible = await visibleMapIdsFor(userId);
  const view = await withMaps(fleet, userId, visible.ids);
  if (!view.isOwner && view.maps.length === 0) return notFound(fleetId);
  return view;
}

/** The fleet, if the user owns it — else why not (404 when unreadable, 403 when read-only). */
export async function requireFleetOwner(userId: string, fleetId: string): Promise<Fleet | FleetAccessError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  if (!view.isOwner) {
    return { status: 403, code: 'FORBIDDEN', message: "Only the fleet's owner can change it" };
  }
  return view;
}

/**
 * May `userId` apply this map update's fleet fields? Only `fleetId` is
 * special — `fleetShare` is an ordinary edit-level knob like the map's cap.
 * null = allowed (or nothing fleet-related asked).
 */
export async function authorizeMapFleetChange(
  userId: string,
  mapId: string,
  input: { fleetId?: string | null },
): Promise<FleetAccessError | null> {
  if (input.fleetId === undefined) return null;
  const perm = await permDb.getPermission(mapId, userId);
  if (!permDb.hasPermission(perm, 'admin')) {
    return { status: 403, code: 'FORBIDDEN', message: 'Only map admins can connect a map to a fleet or disconnect it' };
  }
  if (input.fleetId === null) return null;
  const fleet = await fleetDb.getFleet(input.fleetId);
  if (!fleet) return notFound(input.fleetId);
  if (fleet.ownerId !== userId) {
    return { status: 403, code: 'FORBIDDEN', message: "Only the fleet's owner can connect maps to it" };
  }
  return null;
}

/** Name of a map's fleet for read views (get_map, the map header); null when none. */
export async function fleetNameOf(fleetId: string | null | undefined): Promise<string | null> {
  if (!fleetId) return null;
  return (await fleetDb.getFleet(fleetId))?.name ?? null;
}

/** Shape check for create/update bodies; a message when invalid. */
export function validateFleetFields(input: { name?: unknown; maxActiveClaims?: unknown }, requireName: boolean): string | null {
  if (requireName || input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '') return 'name must be a non-empty string';
    if (input.name.trim().length > 200) return 'name must be at most 200 characters';
  }
  if (input.maxActiveClaims !== undefined) {
    const n = input.maxActiveClaims;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 'maxActiveClaims must be an integer ≥ 0';
  }
  return null;
}
