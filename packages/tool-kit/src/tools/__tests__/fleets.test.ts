/**
 * Fleets (#477) through the MCP surface: create_fleet → update_map(fleetId)
 * → get_map shows the fleet → list_fleets shows the map. An in-memory
 * backend stands in for the server so the round trip runs through the real
 * tool schemas and handlers.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { FleetWithMaps } from '@mindblown/core';
import { createFleetTool, listFleetsTool, updateFleetTool } from '../fleets.js';
import { getMapTool, updateMapTool } from '../map.js';
import type { ToolBackend } from '../../backend.js';
import type { MapDetail } from '../../types.js';

const MAP_ID = 'map-1';
const FLEET_ID = '11111111-2222-4333-8444-555555555555';

function memoryBackend() {
  const fleets = new Map<string, FleetWithMaps>();
  const map = { id: MAP_ID, name: 'Sonar', fleetId: null as string | null, fleetShare: 1 };
  const view = (f: FleetWithMaps): FleetWithMaps => ({
    ...f,
    maps: map.fleetId === f.id ? [{ id: MAP_ID, name: map.name, fleetShare: map.fleetShare, maxActiveClaims: 2, archivedAt: null }] : [],
  });
  const backend = {
    async createFleet(name: string, maxActiveClaims?: number) {
      const f: FleetWithMaps = {
        id: FLEET_ID, name, ownerId: 'me', maxActiveClaims: maxActiveClaims ?? 0, autoCheckBlockers: false,
        createdAt: '', updatedAt: '', maps: [], hiddenMapCount: 0, isOwner: true,
      };
      fleets.set(f.id, f);
      return view(f);
    },
    async updateFleet(id: string, fields: { name?: string; maxActiveClaims?: number; autoCheckBlockers?: boolean }) {
      const f = fleets.get(id);
      if (!f) throw new Error('not found');
      const next = { ...f, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
      fleets.set(id, next);
      return view(next);
    },
    async listFleets() {
      return [...fleets.values()].map(view);
    },
    async updateMap(_mapId: string, fields: { fleetId?: string | null; fleetShare?: number }) {
      if (fields.fleetId !== undefined) map.fleetId = fields.fleetId;
      if (fields.fleetShare !== undefined) map.fleetShare = fields.fleetShare;
      return { id: MAP_ID, name: map.name };
    },
    async getMap(): Promise<MapDetail> {
      return {
        map: {
          id: MAP_ID, workspaceId: 'w', name: map.name, description: null, rootNodeId: 'root', effortUnit: 'hours',
          healthThreshold: 0.2, computedProgress: 0, healthSignal: 'on_track', createdAt: '', updatedAt: '',
          statusWorkflow: [], baselines: [], wipLimit: null,
          fleetId: map.fleetId, fleetName: map.fleetId ? fleets.get(map.fleetId)?.name : null, fleetShare: map.fleetShare,
        },
        nodes: [{
          id: 'root', mapId: MAP_ID, parentId: null, childrenIds: [], text: 'Root', dependencies: [], tags: [],
          computedEffort: 0, computedProgress: 0, healthSignal: 'on_track',
        } as unknown as MapDetail['nodes'][number]],
      };
    },
  } as unknown as ToolBackend;
  return { backend, map };
}

describe('fleet tools — round trip', () => {
  it('create_fleet → update_map(fleetId, fleetShare) → get_map and list_fleets show the connection', async () => {
    const { backend, map } = memoryBackend();

    const created = await createFleetTool.handler(backend, { name: 'big-blower', maxActiveClaims: 2 });
    expect(created).toContain(FLEET_ID);
    expect(created).toContain('cap 2');

    const updated = await updateMapTool.handler(backend, { mapId: MAP_ID, fleetId: FLEET_ID, fleetShare: 2 } as never);
    expect(updated).toContain('Updated map');
    expect(map).toMatchObject({ fleetId: FLEET_ID, fleetShare: 2 });

    const tree = await getMapTool.handler(backend, { mapId: MAP_ID } as never);
    expect(tree).toContain(`Fleet: big-blower (fleetId: ${FLEET_ID}, share 2)`);

    const listed = await listFleetsTool.handler(backend, {} as never);
    expect(listed).toContain('big-blower');
    expect(listed).toContain(`Sonar (mapId: ${MAP_ID}) — share 2, map ceiling 2`);

    const disconnected = await updateMapTool.handler(backend, { mapId: MAP_ID, fleetId: null } as never);
    expect(disconnected).toContain('Updated map');
    expect(await getMapTool.handler(backend, { mapId: MAP_ID } as never)).not.toContain('Fleet:');
  });

  it('update_fleet changes the cap; no fields is a no-op', async () => {
    const { backend } = memoryBackend();
    await createFleetTool.handler(backend, { name: 'f' });
    expect(await updateFleetTool.handler(backend, { fleetId: FLEET_ID } as never)).toBe('No fields to update.');
    expect(await updateFleetTool.handler(backend, { fleetId: FLEET_ID, maxActiveClaims: 4 } as never)).toContain('cap 4 active claims');
  });

  it('update_fleet switches auto-check blockers on and off', async () => {
    const { backend } = memoryBackend();
    await createFleetTool.handler(backend, { name: 'f' });
    expect(await updateFleetTool.handler(backend, { fleetId: FLEET_ID, autoCheckBlockers: true } as never)).toContain('auto-checks blockers');
    expect(await updateFleetTool.handler(backend, { fleetId: FLEET_ID, autoCheckBlockers: false } as never)).not.toContain('auto-checks blockers');
    expect(() => z.object(updateFleetTool.schema).parse({ fleetId: FLEET_ID, autoCheckBlockers: 'yes' })).toThrow();
  });

  it('list_fleets says how to start when there are none', async () => {
    const { backend } = memoryBackend();
    expect(await listFleetsTool.handler(backend, {} as never)).toMatch(/No fleets/);
  });
});

describe('fleet tool schemas', () => {
  it('update_map: fleetId must be a uuid or null, fleetShare 0.1–100', () => {
    const schema = z.object(updateMapTool.schema);
    expect(schema.parse({ mapId: 'm', fleetId: FLEET_ID }).fleetId).toBe(FLEET_ID);
    expect(schema.parse({ mapId: 'm', fleetId: null }).fleetId).toBeNull();
    expect(() => schema.parse({ mapId: 'm', fleetId: 'big-blower' })).toThrow();
    expect(() => schema.parse({ mapId: 'm', fleetShare: 0 })).toThrow();
    expect(() => schema.parse({ mapId: 'm', fleetShare: 101 })).toThrow();
  });

  it('create_fleet: name required, cap a non-negative integer', () => {
    const schema = z.object(createFleetTool.schema);
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ name: 'f', maxActiveClaims: -1 })).toThrow();
    expect(schema.parse({ name: 'f', maxActiveClaims: 3 }).maxActiveClaims).toBe(3);
  });
});
