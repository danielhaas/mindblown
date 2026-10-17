import { describe, it, expect } from 'vitest';
import { clampFleetShare, DEFAULT_FLEET_SHARE, FLEET_SHARE_MAX, FLEET_SHARE_MIN } from '../fleet.js';

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
