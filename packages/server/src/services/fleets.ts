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
import type { Fleet, FleetWithMaps, MindMap } from '@mindblown/core';
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
 * May `userId` apply this map update's fleet fields? null = allowed (or
 * nothing fleet-related asked).
 *
 *   - fleetId: admin on the map; connecting also needs ownership of the
 *     target fleet (a fleet the user can't read is a 404, like everywhere).
 *   - fleetShare: how the fleet splits its capacity between projects, so on
 *     a connected map it is the fleet owner's call — an editor of one map
 *     must not be able to starve the others. On a map without a fleet it is
 *     inert and stays an ordinary edit-level knob.
 */
export async function authorizeMapFleetChange(
  userId: string,
  mapId: string,
  input: { fleetId?: string | null; fleetShare?: number },
): Promise<FleetAccessError | null> {
  if (input.fleetId !== undefined) {
    const perm = await permDb.getPermission(mapId, userId);
    if (!permDb.hasPermission(perm, 'admin')) {
      return { status: 403, code: 'FORBIDDEN', message: 'Only map admins can connect a map to a fleet or disconnect it' };
    }
    if (input.fleetId !== null) {
      const target = await getFleetForUser(userId, input.fleetId);
      if ('status' in target) return target;
      if (!target.isOwner) {
        return { status: 403, code: 'FORBIDDEN', message: "Only the fleet's owner can connect maps to it" };
      }
    }
  }
  if (input.fleetShare !== undefined) {
    // The share applies to the fleet being connected in this request, else the current one.
    const fleetId = input.fleetId !== undefined ? input.fleetId : await fleetDb.getMapFleetId(mapId);
    const fleet = fleetId ? await fleetDb.getFleet(fleetId) : null;
    if (fleet && fleet.ownerId !== userId) {
      return { status: 403, code: 'FORBIDDEN', message: "Only the fleet's owner sets a map's share in it" };
    }
  }
  return null;
}

/**
 * Delete a fleet the user owns. Each connected map is disconnected through
 * the audited map update first (so change_history shows it); the callers
 * broadcast the returned maps. The FK would null them anyway — silently.
 */
export async function deleteFleetForUser(userId: string, fleetId: string): Promise<MindMap[] | FleetAccessError> {
  const owned = await requireFleetOwner(userId, fleetId);
  if ('status' in owned) return owned;
  const disconnected: MindMap[] = [];
  for (const m of await fleetDb.listFleetMaps(fleetId)) {
    const updated = await mapDb.updateMap(m.id, { fleetId: null }, userId);
    if (updated) disconnected.push(updated);
  }
  await fleetDb.deleteFleet(fleetId);
  return disconnected;
}

/**
 * Which of the fleet's maps `userId` may take tickets from in a fleet pull
 * (#478): connected maps where the user has edit — the same level the map
 * route's pull asks. A fleet the user can't read is a 404. (A per-fleet
 * credential, #481, will replace this per-map membership check.)
 */
export async function fleetPullScope(userId: string, fleetId: string): Promise<{ allowedMapIds: Set<string> } | FleetAccessError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  const allowedMapIds = new Set<string>();
  for (const m of await fleetDb.listFleetMaps(fleetId)) {
    if (permDb.hasPermission(await permDb.getPermission(m.id, userId), 'edit')) allowedMapIds.add(m.id);
  }
  return { allowedMapIds };
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
