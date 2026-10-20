import { describe, it, expect } from 'vitest';
import { capOnFleetConnect, clampFleetShare, DEFAULT_FLEET_SHARE, FLEET_SHARE_MAX, FLEET_SHARE_MIN } from '../fleet.js';

describe('capOnFleetConnect (#482)', () => {
  const F = 'fleet-a';
  it('opens a held map to 1 when it joins a fleet', () => {
    expect(capOnFleetConnect({ fleetId: null, maxActiveClaims: 0 }, { fleetId: F })).toBe(1);
    expect(capOnFleetConnect({ fleetId: 'fleet-b', maxActiveClaims: 0 }, { fleetId: F })).toBe(1);
  });

  it('keeps a cap the map already had', () => {
    expect(capOnFleetConnect({ fleetId: null, maxActiveClaims: 3 }, { fleetId: F })).toBeUndefined();
  });

  it('lets a cap sent in the same update win, even 0', () => {
    expect(capOnFleetConnect({ fleetId: null, maxActiveClaims: 0 }, { fleetId: F, maxActiveClaims: 0 })).toBeUndefined();
  });

  it('leaves the cap alone on disconnect, no fleet change or no fleetId at all', () => {
    expect(capOnFleetConnect({ fleetId: F, maxActiveClaims: 0 }, { fleetId: null })).toBeUndefined();
    expect(capOnFleetConnect({ fleetId: F, maxActiveClaims: 0 }, { fleetId: F })).toBeUndefined();
    expect(capOnFleetConnect({ fleetId: null, maxActiveClaims: 0 }, {})).toBeUndefined();
  });
});

describe('clampFleetShare (#477)', () => {
  it('keeps in-range values', () => {
    expect(clampFleetShare(2)).toBe(2);
    expect(clampFleetShare(0.5)).toBe(0.5);
  });

  it('clamps to 0.1–100', () => {
    expect(clampFleetShare(0)).toBe(FLEET_SHARE_MIN);
    expect(clampFleetShare(-3)).toBe(FLEET_SHARE_MIN);
    expect(clampFleetShare(1000)).toBe(FLEET_SHARE_MAX);
  });

  it('falls back to 1 for junk', () => {
    expect(clampFleetShare(null)).toBe(DEFAULT_FLEET_SHARE);
    expect(clampFleetShare(undefined)).toBe(DEFAULT_FLEET_SHARE);
    expect(clampFleetShare(Number.NaN)).toBe(DEFAULT_FLEET_SHARE);
  });
});
