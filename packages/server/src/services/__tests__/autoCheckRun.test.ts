/**
 * One auto-check round (asksInbox runAutoCheck): each fleet with the switch
 * on, as its owner, on the maps the owner may edit — held and archived maps
 * left out. The blocker rules themselves are pinned in derivedAsks.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  fleets: [] as Array<{ id: string; ownerId: string }>,
  maps: [] as Array<{ id: string; maxActiveClaims: number; archivedAt: string | null }>,
  editable: new Set<string>(),
}));
const autoCheckBlockers = vi.hoisted(() => vi.fn());

vi.mock('../../db/asks.js', () => ({}));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../fleetTelemetry.js', () => ({ authorizeTickPush: vi.fn() }));
vi.mock('../../db/fleets.js', () => ({ listAutoCheckFleets: async () => state.fleets }));
vi.mock('../fleets.js', () => ({
  getFleetForUser: async (_u: string, id: string) => (id === 'gone' ? { status: 404 } : { id, maps: state.maps }),
}));
vi.mock('../../db/permissions.js', () => ({
  getPermission: async (mapId: string) => (state.editable.has(mapId) ? 'edit' : 'view'),
  hasPermission: (p: string) => p === 'edit',
}));
vi.mock('../derivedAsks.js', () => ({
  autoCheckBlockers: (...a: unknown[]) => autoCheckBlockers(...a),
  openDerivedAsks: vi.fn(),
  sendBlockersToFleet: vi.fn(),
}));

import { runAutoCheck } from '../asksInbox.js';

beforeEach(() => {
  autoCheckBlockers.mockReset();
  autoCheckBlockers.mockResolvedValue({ sent: [{ askId: 'blocker-n', mapId: 'm1', action: 'fleet-check' }], failed: [] });
  state.fleets = [{ id: 'f1', ownerId: 'owner' }];
  state.maps = [
    { id: 'm1', maxActiveClaims: 2, archivedAt: null },
    { id: 'held', maxActiveClaims: 0, archivedAt: null },
    { id: 'old', maxActiveClaims: 2, archivedAt: '2026-10-01T00:00:00Z' },
    { id: 'view-only', maxActiveClaims: 2, archivedAt: null },
  ];
  state.editable = new Set(['m1', 'held', 'old']);
});

describe('runAutoCheck', () => {
  it('checks as the owner, on running maps the owner may edit', async () => {
    const out = await runAutoCheck();
    expect(autoCheckBlockers).toHaveBeenCalledWith({ fleetId: 'f1', visibleMapIds: ['m1'], fleetLevel: false }, ['m1'], 'owner', expect.any(Date));
    expect(out).toEqual({ fleets: 1, sent: 1, errors: [] });
  });

  it('a fleet with nothing to check, or one gone, is skipped; one failing fleet does not stop the next', async () => {
    state.fleets = [{ id: 'gone', ownerId: 'owner' }, { id: 'boom', ownerId: 'owner' }, { id: 'f1', ownerId: 'owner' }];
    autoCheckBlockers.mockRejectedValueOnce(new Error('db down'));
    const out = await runAutoCheck();
    expect(out.sent).toBe(1);
    expect(out.errors).toEqual(['fleet boom: db down']);
    state.editable = new Set();
    autoCheckBlockers.mockClear();
    await runAutoCheck();
    expect(autoCheckBlockers).not.toHaveBeenCalled();
  });
});
