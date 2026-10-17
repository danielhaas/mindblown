import { z } from 'zod';
import type { FleetWithMaps } from '@mindblown/core';
import { defineTool } from '../spec.js';

/** One fleet as a few lines: name, id, cap, connected maps. */
export function renderFleet(f: FleetWithMaps): string {
  const cap = f.maxActiveClaims === 0 ? 'no fleet-wide cap' : `cap ${f.maxActiveClaims} active claims`;
  const lines = [`- ${f.name} (id: ${f.id}) — ${cap}${f.isOwner ? ', you own it' : ''}`];
  if (f.maps.length === 0 && f.hiddenMapCount === 0) lines.push('    no maps connected');
  for (const m of f.maps) {
    const ceiling = m.maxActiveClaims === 0 ? 'map on hold' : `map ceiling ${m.maxActiveClaims}`;
    const archived = m.archivedAt ? ' [ARCHIVED]' : '';
    lines.push(`    · ${m.name} (mapId: ${m.id}) — share ${m.fleetShare}, ${ceiling}${archived}`);
  }
  if (f.hiddenMapCount > 0) lines.push(`    · ${f.hiddenMapCount} more map(s) you have no access to`);
  return lines.join('\n');
}

export const listFleetsTool = defineTool({
  name: 'list_fleets',
  description:
    'List worker fleets: the fleets you own and the fleets working on maps you can see. A fleet is the capacity (worker hosts, a total claim cap) that several maps share; each map connects to at most one fleet (update_map fleetId). Shows each fleet\'s cap and its connected maps with their share and own ceiling.',
  schema: {},
  handler: async (backend) => {
    const fleets = await backend.listFleets();
    if (fleets.length === 0) return 'No fleets. create_fleet makes one; update_map(fleetId) connects a map to it.';
    return [`${fleets.length} fleet(s):`, ...fleets.map(renderFleet)].join('\n');
  },
});

export const createFleetTool = defineTool({
  name: 'create_fleet',
  description:
    'Create a worker fleet; you become its owner. Then connect maps with update_map(mapId, fleetId) — that needs admin on the map. maxActiveClaims is the total claim cap across all connected maps (0 = no fleet-wide limit, the default — each map\'s own maxActiveClaims still applies, and 0 there holds the map).',
  schema: {
    name: z.string().min(1).max(200).describe('Fleet name, e.g. the host group it stands for'),
    maxActiveClaims: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Total cap on concurrently claimed nodes across every connected map. 0 = no fleet-wide limit (default).'),
  },
  handler: async (backend, { name, maxActiveClaims }) => {
    const f = await backend.createFleet(name, maxActiveClaims);
    return `Created fleet "${f.name}" with id: ${f.id} (${f.maxActiveClaims === 0 ? 'no fleet-wide cap' : `cap ${f.maxActiveClaims}`}). Connect a map with update_map(mapId, fleetId: "${f.id}").`;
  },
});

export const updateFleetTool = defineTool({
  name: 'update_fleet',
  description:
    "Rename a fleet or set its total claim cap (maxActiveClaims across all connected maps; 0 = no fleet-wide limit). Owner only. Each map's own ceiling (0 = hold) and queue knobs stay on the map (update_map).",
  schema: {
    fleetId: z.string().describe('The fleet ID'),
    name: z.string().min(1).max(200).optional().describe('New name'),
    maxActiveClaims: z.number().int().min(0).optional().describe('Total claim cap across all connected maps; 0 = no fleet-wide limit'),
  },
  handler: async (backend, { fleetId, name, maxActiveClaims }) => {
    if (name === undefined && maxActiveClaims === undefined) return 'No fields to update.';
    const f = await backend.updateFleet(fleetId, { name, maxActiveClaims });
    return `Updated fleet:\n${renderFleet(f)}`;
  },
});

export const fleetTools = [listFleetsTool, createFleetTool, updateFleetTool];
