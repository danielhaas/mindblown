/**
 * Data rules for connecting a map to a fleet (#480): which fleets the
 * picker offers, when the share control applies, and what a disconnect
 * asks first.
 *
 * Kept out of MapFleetPanel.tsx for the same reason dispatch.ts is kept out
 * of DispatchCards.tsx — the component module builds the zustand store at
 * import time, so none of this would be reachable from a unit test.
 *
 * The server is the authority (services/fleets.ts): connecting needs admin
 * on the map AND ownership of the target fleet. The picker only offers what
 * that rule can grant, so the common refusal never has to happen.
 */
import type { FleetWithMaps } from '@mindblown/core';

export interface FleetOption {
  id: string;
  label: string;
  /** Listed so the current value is visible, but not selectable. */
  disabled: boolean;
}

function mapCount(fleet: FleetWithMaps): number {
  return fleet.maps.length + fleet.hiddenMapCount;
}

/**
 * The picker's fleets: every fleet the user owns, plus the map's current
 * fleet when someone else owns it (shown, not offered — only its owner
 * connects maps to it).
 */
export function fleetOptions(fleets: FleetWithMaps[], currentFleetId: string | null): FleetOption[] {
  return fleets
    .filter((f) => f.isOwner || f.id === currentFleetId)
    .map((f) => {
      const n = mapCount(f);
      const maps = `${n} map${n === 1 ? '' : 's'}`;
      return {
        id: f.id,
        label: f.isOwner ? `${f.name} · ${maps}` : `${f.name} · ${maps} · owned by someone else`,
        disabled: !f.isOwner,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Whether the map's share means anything: the fleet picks between projects
 * only when it serves more than one. Counts this map whether or not the
 * fleet list has caught up with a connect that just landed.
 */
export function shareApplies(fleet: FleetWithMaps | undefined, mapId: string): boolean {
  if (!fleet) return false;
  const others = mapCount(fleet) - (fleet.maps.some((m) => m.id === mapId) ? 1 : 0);
  return others >= 1;
}

/** The confirm text before leaving a fleet; null when nothing is claimed. */
export function leaveFleetWarning(fleetName: string, liveClaims: number, nextFleetName: string | null): string | null {
  if (liveClaims === 0) return null;
  const tickets = `${liveClaims} ticket${liveClaims === 1 ? ' is' : 's are'}`;
  const move = nextFleetName ? `Move this map from "${fleetName}" to "${nextFleetName}"?` : `Disconnect this map from "${fleetName}"?`;
  return `${move}\n\n${tickets} claimed by workers right now. The claims stay on the tickets; the workers finish or release them, but no new ticket from this map goes to "${fleetName}".`;
}
