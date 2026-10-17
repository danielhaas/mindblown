/**
 * The chat backend's fleet methods (#477) are outside the map guard
 * (CHAT_BACKEND_UNSCOPED_METHODS), so the ownership check inside them is the
 * only protection. Pin it: a reader of a connected map can list the fleet
 * but not change it, and the write never reaches the DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const FLEET_ID = '11111111-2222-4333-8444-555555555555';
const fleets = vi.hoisted(() => ({
  updateFleet: vi.fn(),
  createFleet: vi.fn(),
}));

vi.mock('../../db/fleets.js', () => ({
  getFleet: async () => ({ id: FLEET_ID, name: 'F', ownerId: 'owner', maxActiveClaims: 2, createdAt: '', updatedAt: '' }),
  listFleetMaps: async () => [{ id: 'map-a', name: 'A', fleetShare: 1, maxActiveClaims: 1, archivedAt: null }],
  listFleetsByOwnerOrIds: async () => [{ id: FLEET_ID, name: 'F', ownerId: 'owner', maxActiveClaims: 2, createdAt: '', updatedAt: '' }],
  updateFleet: (...a: unknown[]) => fleets.updateFleet(...a),
  createFleet: (...a: unknown[]) => fleets.createFleet(...a),
}));
vi.mock('../../db/maps.js', () => ({
  // The chatting user can view map-a, which is connected to the fleet; a stranger sees nothing.
  listMapsForUser: async (userId: string) => (userId === 'stranger' ? [] : [{ id: 'map-a', fleetId: FLEET_ID }]),
}));
vi.mock('../../db/permissions.js', () => ({ getPermission: async () => 'view', hasPermission: () => false }));
vi.mock('../../db/nodes.js', () => ({}));
vi.mock('../../db/events.js', () => ({}));
vi.mock('../../db/fleet.js', () => ({}));
vi.mock('../../db/asks.js', () => ({}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../embeddings.js', () => ({ scheduleEmbedNode: vi.fn() }));
const pullFleetTicket = vi.hoisted(() => vi.fn(async () => ({ granted: false, reason: 'empty', active: 0, cap: 2, skipped: [] })));
vi.mock('../../services/orchestration.js', () => ({ pullFleetTicket }));
vi.mock('../../services/unblock.js', () => ({}));
vi.mock('../../services/asks.js', () => ({}));
vi.mock('../../services/fleetJournal.js', () => ({}));
vi.mock('../../sync/closedIssueAudit.js', () => ({}));
vi.mock('../../lib/githubContext.js', () => ({}));
vi.mock('../../lib/media.js', () => ({}));
vi.mock('../../lib/attachmentText.js', () => ({}));

import { createChatBackend } from '../backend.js';

beforeEach(() => {
  fleets.updateFleet.mockReset();
  fleets.createFleet.mockReset();
});

describe('chat backend — fleet methods', () => {
  it('lists the fleet for a reader of a connected map', async () => {
    const list = await createChatBackend('reader').listFleets();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: FLEET_ID, isOwner: false });
  });

  it("refuses updateFleet to a non-owner and never writes", async () => {
    await expect(createChatBackend('reader').updateFleet(FLEET_ID, { maxActiveClaims: 50 })).rejects.toThrow(/owner/);
    expect(fleets.updateFleet).not.toHaveBeenCalled();
  });

  it('lets the owner update', async () => {
    await createChatBackend('owner').updateFleet(FLEET_ID, { maxActiveClaims: 5 });
    expect(fleets.updateFleet).toHaveBeenCalledWith(FLEET_ID, { name: undefined, maxActiveClaims: 5 });
  });

  it('pullFleetTicket (#478) hands the service only maps the user may edit — none for a reader', async () => {
    await createChatBackend('reader').pullFleetTicket(FLEET_ID, 's1', { mapIds: ['map-a'] });
    expect(pullFleetTicket).toHaveBeenCalledWith(FLEET_ID, 's1', { mapIds: ['map-a'], allowedMapIds: new Set() });
  });

  it("pullFleetTicket refuses a fleet the user can't read", async () => {
    pullFleetTicket.mockClear();
    await expect(createChatBackend('stranger').pullFleetTicket(FLEET_ID, 's1')).rejects.toThrow(/not found/);
    expect(pullFleetTicket).not.toHaveBeenCalled();
  });

  it('createFleet makes the chatting user the owner', async () => {
    fleets.createFleet.mockResolvedValue({ id: FLEET_ID, name: 'New', ownerId: 'reader', maxActiveClaims: 0, createdAt: '', updatedAt: '' });
    const f = await createChatBackend('reader').createFleet(' New ');
    expect(fleets.createFleet).toHaveBeenCalledWith({ name: 'New', ownerId: 'reader', maxActiveClaims: undefined });
    expect(f.isOwner).toBe(true);
  });
});
