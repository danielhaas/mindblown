import { describe, it, expect } from 'vitest';
import type { FleetWithMaps } from '@mindblown/core';
import { fleetOptions, leaveFleetWarning, shareApplies } from '../fleetConnect.js';

function fleet(id: string, name: string, over: Partial<FleetWithMaps> = {}): FleetWithMaps {
  return {
    id,
    name,
    ownerId: 'u1',
    maxActiveClaims: 0,
    autoCheckBlockers: false,
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    maps: [],
    hiddenMapCount: 0,
    isOwner: true,
    ...over,
  };
}

const mapRow = (id: string) => ({ id, name: id, fleetShare: 1, maxActiveClaims: 0, archivedAt: null });

describe('fleetOptions', () => {
  it('offers owned fleets, sorted, with their map count', () => {
    const opts = fleetOptions([fleet('b', 'Zeta', { maps: [mapRow('m1')] }), fleet('a', 'Alpha', { hiddenMapCount: 2 })], null);
    expect(opts).toEqual([
      { id: 'a', label: 'Alpha · 2 maps', disabled: false },
      { id: 'b', label: 'Zeta · 1 map', disabled: false },
    ]);
  });

  it("lists the current fleet someone else owns as disabled, and hides other foreign fleets", () => {
    const foreign = fleet('f', 'Theirs', { isOwner: false, maps: [mapRow('m1')] });
    const other = fleet('g', 'Elsewhere', { isOwner: false });
    expect(fleetOptions([foreign, other], 'f')).toEqual([{ id: 'f', label: 'Theirs · 1 map · owned by someone else', disabled: true }]);
    expect(fleetOptions([foreign, other], null)).toEqual([]);
  });
});

describe('shareApplies', () => {
  it('is false without a fleet or when this map is its only one', () => {
    expect(shareApplies(undefined, 'm1')).toBe(false);
    expect(shareApplies(fleet('a', 'A', { maps: [mapRow('m1')] }), 'm1')).toBe(false);
  });

  it('is true when the fleet serves another map, visible or not', () => {
    expect(shareApplies(fleet('a', 'A', { maps: [mapRow('m1'), mapRow('m2')] }), 'm1')).toBe(true);
    expect(shareApplies(fleet('a', 'A', { maps: [mapRow('m1')], hiddenMapCount: 1 }), 'm1')).toBe(true);
  });

  it('counts this map even before the fleet list has caught up with the connect', () => {
    expect(shareApplies(fleet('a', 'A', { maps: [mapRow('m2')] }), 'm1')).toBe(true);
  });
});

describe('leaveFleetWarning', () => {
  it('asks nothing when no ticket is claimed', () => {
    expect(leaveFleetWarning('Alpha', 0, null)).toBeNull();
  });

  it('names the claims and whether it is a disconnect or a move', () => {
    expect(leaveFleetWarning('Alpha', 1, null)).toMatch(/^Disconnect this map from "Alpha"\?\n\n1 ticket is claimed/);
    expect(leaveFleetWarning('Alpha', 3, 'Beta')).toMatch(/^Move this map from "Alpha" to "Beta"\?\n\n3 tickets are claimed/);
    expect(leaveFleetWarning('Alpha', 3, 'Beta')).toMatch(/count against "Beta"'s cap/);
    expect(leaveFleetWarning('Alpha', 1, null)).not.toMatch(/count against/);
  });
});
