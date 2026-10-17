/**
 * get_next_ticket with fleetId (#478) — the fleet-wide pull on the MCP
 * surface: exactly one of mapId / fleetId, mapIds only with a fleet, and the
 * answer names the map the ticket came from.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getNextTicketTool } from '../orchestration.js';
import type { ToolBackend, GetNextTicketResult } from '../../backend.js';

const FLEET = '11111111-2222-4333-8444-555555555555';

function makeBackend(result: GetNextTicketResult) {
  const fleetCalls: Array<{ fleetId: string; sessionId: string; opts?: { profile?: string; mapIds?: string[] } }> = [];
  const mapCalls: string[] = [];
  const backend = {
    getNextTicket: async (mapId: string) => {
      mapCalls.push(mapId);
      return result;
    },
    pullFleetTicket: async (fleetId: string, sessionId: string, opts?: { profile?: string; mapIds?: string[] }) => {
      fleetCalls.push({ fleetId, sessionId, opts });
      return result;
    },
  } as unknown as ToolBackend;
  return { backend, fleetCalls, mapCalls };
}

const ticket = {
  id: 'n1',
  mapId: 'map-b',
  text: 'Fix the parser',
  description: 'Steps',
  priority: null,
  priorityRank: null,
  tags: [],
  scopes: [],
  versionId: null,
  effortEstimate: null,
  githubLinks: [],
  claimedAt: '2026-10-17T10:00:00Z',
};

describe('get_next_ticket schema — fleet pull', () => {
  const schema = z.object(getNextTicketTool.schema);

  it('accepts fleetId + mapIds, rejects a non-uuid fleetId and an empty mapIds', () => {
    expect(schema.parse({ fleetId: FLEET, sessionId: 'w', mapIds: ['a'] }).mapIds).toEqual(['a']);
    expect(() => schema.parse({ fleetId: 'nope', sessionId: 'w' })).toThrow();
    expect(() => schema.parse({ fleetId: FLEET, sessionId: 'w', mapIds: [] })).toThrow();
  });
});

describe('get_next_ticket handler — fleet pull', () => {
  it('round-trips: forwards fleetId, profile and mapIds, and names the granted map', async () => {
    const { backend, fleetCalls, mapCalls } = makeBackend({
      granted: true,
      active: 3,
      cap: 4,
      ticket,
      skipped: [],
      mapId: 'map-b',
      mapName: 'Beta',
      fleet: { id: FLEET, name: 'big-blower', active: 3, cap: 4 },
    });
    const out = await getNextTicketTool.handler(backend, {
      fleetId: FLEET,
      sessionId: 'big-blower:qwen-1',
      profile: 'light',
      mapIds: ['map-a', 'map-b'],
    } as never);
    expect(mapCalls).toEqual([]);
    expect(fleetCalls).toEqual([
      { fleetId: FLEET, sessionId: 'big-blower:qwen-1', opts: { profile: 'light', mapIds: ['map-a', 'map-b'] } },
    ]);
    expect(out).toContain('map: Beta (mapId: map-b)');
    expect(out).toContain('3/4 fleet claims active');
    expect(out).toContain('Fix the parser');
  });

  it('refuses both or neither of mapId / fleetId, and mapIds without a fleet', async () => {
    const { backend } = makeBackend({ granted: false, reason: 'empty', active: 0, cap: 1, skipped: [] });
    await expect(getNextTicketTool.handler(backend, { sessionId: 'w' } as never)).rejects.toThrow(/exactly one/);
    await expect(getNextTicketTool.handler(backend, { mapId: 'm', fleetId: FLEET, sessionId: 'w' } as never)).rejects.toThrow(/exactly one/);
    await expect(getNextTicketTool.handler(backend, { mapId: 'm', mapIds: ['m'], sessionId: 'w' } as never)).rejects.toThrow(/fleetId/);
  });

  it('renders a fleet cap of 0 as no cap, never as "n/0"', async () => {
    const fleetPull = makeBackend({ granted: true, active: 3, cap: 0, ticket, skipped: [], mapId: 'map-b', mapName: 'Beta', fleet: { id: FLEET, name: 'F', active: 3, cap: 0 } });
    const out1 = await getNextTicketTool.handler(fleetPull.backend, { fleetId: FLEET, sessionId: 'w' } as never);
    expect(out1).toContain('3 fleet claims active, no fleet cap');
    expect(out1).not.toContain('3/0');
    const mapPull = makeBackend({ granted: true, active: 1, cap: 4, ticket, skipped: [], mapId: 'map-b', mapName: 'Beta', fleet: { id: FLEET, name: 'F', active: 1, cap: 0 } });
    const out2 = await getNextTicketTool.handler(mapPull.backend, { mapId: 'map-b', sessionId: 'w' } as never);
    expect(out2).toContain('1/4 map claims active — fleet "F" 1, no fleet cap');
    expect(out2).not.toContain('1/0');
  });

  it('explains fleet_cap', async () => {
    const full = makeBackend({ granted: false, reason: 'fleet_cap', active: 4, cap: 4, skipped: [], fleet: { id: FLEET, name: 'F', active: 4, cap: 4 } });
    expect(await getNextTicketTool.handler(full.backend, { fleetId: FLEET, sessionId: 'w' } as never)).toContain('fleet is full (4/4');
  });

  it('a map pull on a connected map shows the fleet numbers and reports fleet_cap', async () => {
    const { backend } = makeBackend({
      granted: false,
      reason: 'fleet_cap',
      active: 1,
      cap: 5,
      skipped: [],
      mapId: 'm',
      mapName: 'M',
      fleet: { id: FLEET, name: 'F', active: 6, cap: 6 },
    });
    expect(await getNextTicketTool.handler(backend, { mapId: 'm', sessionId: 'w' } as never)).toContain('fleet is full (6/6');
  });

  it('lists per-map reasons when nothing was granted', async () => {
    const { backend } = makeBackend({
      granted: false,
      reason: 'empty',
      active: 1,
      cap: 4,
      skipped: [],
      fleet: { id: FLEET, name: 'F', active: 1, cap: 4 },
      maps: [
        { mapId: 'a', name: 'Alpha', reason: 'hold' },
        { mapId: 'b', name: 'Beta', reason: 'empty' },
      ],
    });
    const out = await getNextTicketTool.handler(backend, { fleetId: FLEET, sessionId: 'w' } as never);
    expect(out).toContain('no dispatchable ticket in any map');
    expect(out).toContain('Alpha (mapId: a): hold');
    expect(out).toContain('Beta (mapId: b): empty');
  });
});
