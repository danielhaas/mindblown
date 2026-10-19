/**
 * Fleet-tab scope (#480): what the workers, Questions and journal sections
 * read — one map of the fleet ("this project", the default on a map's
 * Fleet tab) or every project of it ("all projects", and always on the
 * fleet page `?fleet=<id>`).
 *
 * The sections take the scope from FleetScopeContext; without a provider
 * (a section rendered somewhere else) they read the current map, as they
 * did before fleets existed.
 *
 * Kept free of the store so the label rules are reachable from a unit test.
 */
import { createContext, useContext } from 'react';
import type { FleetTarget } from './api.js';

export interface FleetScope {
  /** The map the tab belongs to; null on the fleet page. */
  mapId: string | null;
  /** The map's fleet; null when it has none. */
  fleetId: string | null;
  /** Every project of the fleet instead of this map. */
  all: boolean;
  /** Connected maps the reader can view, id → name — for the project labels. */
  mapNames: ReadonlyMap<string, string>;
}

export const FleetScopeContext = createContext<FleetScope | null>(null);

export function useFleetScope(): FleetScope | null {
  return useContext(FleetScopeContext);
}

/** Which route a section reads: the fleet when "all" (and there is one), else the map. */
export function scopeTarget(scope: FleetScope | null, currentMapId: string | null): FleetTarget | null {
  if (scope?.all && scope.fleetId) return { fleetId: scope.fleetId };
  const mapId = scope ? scope.mapId : currentMapId;
  return mapId ? { mapId } : null;
}

/**
 * The project label in front of a claim, a question or a journal entry:
 * none for this map's own (or when the data doesn't say), the map's name
 * for another one — a host serving this map can work for others too —
 * and "fleet" for a fleet-level ask, which only the all-projects view has.
 */
export function projectLabel(scope: FleetScope | null, mapId: string | null | undefined): string | null {
  if (!scope) return null;
  if (mapId === null) return scope.all || !scope.mapId ? 'fleet' : null;
  if (!mapId || mapId === scope.mapId) return null;
  return scope.mapNames.get(mapId) ?? 'another project';
}
