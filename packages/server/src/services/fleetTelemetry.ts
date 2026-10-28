/**
 * Fleet telemetry (#479) — rollups and orchestrator ticks belong to a
 * fleet, not a map. Shared by the REST routes (fleet routes and the old
 * map routes that forward to the map's fleet) and the in-app chat backend.
 *
 * Reads follow the fleet read rule (services/fleets.ts): the owner, or
 * anyone with view on a connected map. A worker's claim on a map the
 * reader can't view is redacted (core `redactRollup`). A read through a
 * map narrows the hosts to those serving that map.
 *
 * Pushes need the fleet owner or edit on a connected map — the map
 * routes keep asking edit on their map, as before (#405). A per-fleet
 * credential (#481) will replace the membership check.
 */
import { redactRollup, redactTick, ROLLUP_STALE_MIN, ticketTail, withoutTails } from '@mindblown/core';
import type { FleetRollup, FleetTickPayload } from '@mindblown/core';
import * as fleetDb from '../db/fleet.js';
import * as fleetEntityDb from '../db/fleets.js';
import * as permDb from '../db/permissions.js';
import { broadcast } from '../ws.js';
import { getFleetForUser, type FleetAccessError } from './fleets.js';

export interface TelemetryError {
  status: 400 | 403 | 404 | 409;
  code: string;
  message: string;
}

export interface TelemetryRead {
  fleetId: string | null;
  hosts: fleetDb.FleetStatusRow[];
  ticks: fleetDb.FleetTickRow[];
}

/**
 * Who reads: the fleet, the connected maps they can view, and `full` —
 * the owner or a reader who sees every connected map. Only a full reader
 * gets the ticks' prose; the orchestrator writes about all projects.
 */
export interface TelemetryScope {
  fleetId: string;
  visible: Set<string>;
  full: boolean;
}

/** What one reader sees of the fleet's telemetry; `onlyMapId` keeps the hosts serving that map. */
export async function readTelemetry(scope: TelemetryScope, window: number | fleetDb.TickListWindow, onlyMapId?: string): Promise<TelemetryRead> {
  const { fleetId, visible } = scope;
  const [rows, ticks] = await Promise.all([fleetDb.listRollups(fleetId), fleetDb.listTicks(fleetId, window)]);
  const hosts = rows
    .filter((h) => !onlyMapId || h.mapIds.includes(onlyMapId))
    .map((h) => ({ ...h, mapIds: h.mapIds.filter((id) => visible.has(id)), rollup: redactRollup(withoutTails(h.rollup), h.mapIds, visible) }));
  return { fleetId, hosts, ticks: scope.full ? ticks : ticks.map((t) => ({ ...t, payload: redactTick(t.payload) })) };
}

/**
 * The agent output last reported for a ticket on this map (#585), or null.
 * The route guard checked edit on the map: the lines carry the agent's
 * commands, paths and error snippets, more than a viewer's phase chip.
 */
export async function readTicketTail(mapId: string, nodeId: string): Promise<ReturnType<typeof ticketTail>> {
  const fleetId = await fleetEntityDb.getMapFleetId(mapId);
  if (!fleetId) return null;
  return ticketTail(await fleetDb.listRollups(fleetId), mapId, nodeId);
}

/** The fleet a reader may read, with the connected maps they can view — or why not (404 hides it). */
export async function fleetReadScope(userId: string, fleetId: string): Promise<TelemetryScope | FleetAccessError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  return { fleetId: view.id, visible: new Set(view.maps.map((m) => m.id)), full: view.isOwner || view.hiddenMapCount === 0 };
}

/**
 * Read through a map the reader can view (the route guard checked that):
 * the map's fleet, or null when it has none — an empty read, not an error.
 */
export async function mapReadScope(userId: string, mapId: string): Promise<TelemetryScope | { fleetId: null }> {
  const fleetId = await fleetEntityDb.getMapFleetId(mapId);
  if (!fleetId) return { fleetId: null };
  const scope = await fleetReadScope(userId, fleetId);
  return 'status' in scope ? { fleetId, visible: new Set([mapId]), full: false } : scope;
}

async function canEditAll(userId: string, mapIds: string[]): Promise<boolean> {
  for (const id of mapIds) {
    if (!permDb.hasPermission(await permDb.getPermission(id, userId), 'edit')) return false;
  }
  return true;
}

/**
 * May this user push a rollup naming these maps? The owner, or edit on
 * every map it names — an editor of one project must not paint another's
 * card. A fleet the user can't read is a 404.
 */
export async function authorizeRollupPush(userId: string, fleetId: string, mapIds: string[]): Promise<TelemetryError | null> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  if (view.isOwner || (mapIds.length > 0 && (await canEditAll(userId, mapIds)))) return null;
  return { status: 403, code: 'FORBIDDEN', message: "Pushing a rollup needs the fleet's owner or edit on every map it names" };
}

/**
 * May this user push a tick? Every cockpit of the fleet shows it, so the
 * owner, or edit on every connected map (hidden ones included).
 */
export async function authorizeTickPush(userId: string, fleetId: string): Promise<TelemetryError | null> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  if (view.isOwner) return null;
  const all = (await fleetEntityDb.listFleetMaps(fleetId)).map((m) => m.id);
  if (all.length > 0 && (await canEditAll(userId, all))) return null;
  return { status: 403, code: 'FORBIDDEN', message: "Pushing an orchestrator tick needs the fleet's owner or edit on every map of the fleet" };
}

/** The map's fleet for a push through the map route — 409 when it has none. */
export async function fleetForMapPush(mapId: string): Promise<string | TelemetryError> {
  const fleetId = await fleetEntityDb.getMapFleetId(mapId);
  if (fleetId) return fleetId;
  return {
    status: 409,
    code: 'NO_FLEET',
    message: `Map ${mapId} is not connected to a fleet. Connect it first (map Settings → Fleet, or update_map fleetId), then push again.`,
  };
}

/** Tell every open view of the fleet's maps that the telemetry moved. */
async function broadcastFleet(fleetId: string, event: Record<string, unknown>): Promise<void> {
  for (const m of await fleetEntityDb.listFleetMaps(fleetId)) broadcast(m.id, { type: 'fleet:updated', ...event });
}

export async function pushRollup(fleetId: string, rollup: FleetRollup, viaMapId: string | null): Promise<fleetDb.FleetStatusRow | TelemetryError> {
  // A v2 rollup may only name maps of this fleet — it is what the reads
  // filter and redact by, so a stray id would show the host on a project
  // it does not work for.
  if (rollup.maps && rollup.maps.length > 0) {
    const connected = new Set((await fleetEntityDb.listFleetMaps(fleetId)).map((m) => m.id));
    const stray = rollup.maps.filter((id) => !connected.has(id));
    if (stray.length > 0) {
      return { status: 400, code: 'VALIDATION_ERROR', message: `Rollup names maps not connected to this fleet: ${stray.join(', ')}` };
    }
  } else if (viaMapId) {
    // A v1 host that reports once per map would overwrite its own row for
    // the other map every push — the card flaps. One live row per host per
    // fleet: the second map is refused until the host sends one v2 rollup.
    const prev = await fleetDb.getRollupOrigin(fleetId, rollup.host);
    const fresh = prev && Date.now() - new Date(prev.receivedAt).getTime() < ROLLUP_STALE_MIN * 60_000;
    if (prev && fresh && prev.viaMapId && prev.viaMapId !== viaMapId) {
      return {
        status: 409,
        code: 'HOST_SERVES_SEVERAL_MAPS',
        message: `Host ${rollup.host} already reports for map ${prev.viaMapId} in this fleet. A host serving several maps sends one v2 rollup (maps[]) to /api/fleets/${fleetId}/fleet-status/${rollup.host}.`,
      };
    }
  }
  const row = await fleetDb.upsertRollup(fleetId, rollup, viaMapId);
  await broadcastFleet(fleetId, { kind: 'rollup', host: row.host, receivedAt: row.receivedAt });
  return row;
}

export async function pushTick(fleetId: string, payload: FleetTickPayload, tickAt: Date, viaMapId: string | null): Promise<fleetDb.FleetTickRow> {
  const row = await fleetDb.insertTick(fleetId, payload, tickAt, viaMapId);
  await broadcastFleet(fleetId, { kind: 'tick', tickAt: row.tickAt });
  return row;
}
