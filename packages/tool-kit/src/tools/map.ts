import { z } from 'zod';
import { defineTool } from '../spec.js';
import { filterMapData, formatMapTree } from '../formatters.js';

export const listMapsTool = defineTool({
  name: 'list_maps',
  description: 'List all maps with name, progress percentage, and health signal',
  schema: {},
  handler: async (backend) => {
    const maps = await backend.listMaps();
    if (maps.length === 0) return 'No maps found.';
    const lines = maps.map((m) => {
      const health =
        m.healthSignal === 'on_track' ? '[OK]' : m.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
      return `- ${m.name} (id: ${m.id}, workspaceId: ${m.workspaceId}) — ${Math.round(m.computedProgress)}% complete ${health}`;
    });
    return lines.join('\n');
  },
});

export const getMapTool = defineTool({
  name: 'get_map',
  description:
    "Get a map's tree structure with computed fields (effort, progress, health). Optionally filter to only show nodes matching criteria (ancestors are kept to preserve tree structure).",
  schema: {
    mapId: z.string().describe('The map ID'),
    status: z.string().optional().describe('Filter by status (e.g. "in_progress", "done")'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority level'),
    healthSignal: z
      .enum(['on_track', 'at_risk', 'behind'])
      .optional()
      .describe('Filter by health signal'),
    tag: z.string().optional().describe('Filter by tag — show only nodes that have this tag'),
  },
  handler: async (backend, { mapId, status, priority, healthSignal, tag }) => {
    const data = await backend.getMap(mapId);
    const hasFilters =
      status !== undefined || priority !== undefined || healthSignal !== undefined || tag !== undefined;
    const filtered = hasFilters ? filterMapData(data, { status, priority, healthSignal, tag }) : data;
    const header = hasFilters
      ? `[Filtered: ${[
          status && `status=${status}`,
          priority && `priority=${priority}`,
          healthSignal && `health=${healthSignal}`,
          tag && `tag=${tag}`,
        ]
          .filter(Boolean)
          .join(', ')}]\n\n`
      : '';
    return header + formatMapTree(filtered);
  },
});

export const createMapTool = defineTool({
  name: 'create_map',
  description: 'Create a new map/project',
  schema: {
    name: z.string().describe('Map name'),
    description: z.string().optional().describe('Map description'),
  },
  handler: async (backend, { name, description }) => {
    const result = await backend.createMap(name, description);
    return `Created map "${name}" with id: ${result.id}`;
  },
});

export const updateMapTool = defineTool({
  name: 'update_map',
  description:
    "Update a map's name, description, WIP limit, Gantt scheduling anchors, or GitHub auto-import setting. wipLimit is a soft cap on how many nodes may sit in an in_progress status. projectStartDate anchors day 0 of the computed schedule (Gantt view). hoursPerDay sets the hours→days conversion when effortUnit is \"hours\" (default 8). autoImportNewIssues toggles whether new GitHub issues on the bound repo auto-create nodes under the map's GitHub Inbox. Pass nullable fields as null to clear.",
  schema: {
    mapId: z.string().describe('The map ID'),
    name: z.string().optional().describe('New map name'),
    description: z.string().nullable().optional().describe('New map description'),
    wipLimit: z.number().nullable().optional().describe('Soft WIP limit on in-progress nodes (null to disable)'),
    projectStartDate: z
      .string()
      .nullable()
      .optional()
      .describe('Gantt anchor date (ISO YYYY-MM-DD); null = use today'),
    hoursPerDay: z
      .number()
      .min(0.1)
      .optional()
      .describe('Working hours per day for Gantt conversion when effortUnit is "hours" (default 8)'),
    autoImportNewIssues: z
      .boolean()
      .optional()
      .describe('When true, new GitHub issues on the bound repo are auto-imported into this map\'s GitHub Inbox.'),
  },
  handler: async (backend, { mapId, name, description, wipLimit, projectStartDate, hoursPerDay, autoImportNewIssues }) => {
    const fields: {
      name?: string;
      description?: string | null;
      wipLimit?: number | null;
      projectStartDate?: string | null;
      hoursPerDay?: number;
      autoImportNewIssues?: boolean;
    } = {};
    if (name !== undefined) fields.name = name;
    if (description !== undefined) fields.description = description;
    if (wipLimit !== undefined) fields.wipLimit = wipLimit;
    if (projectStartDate !== undefined) fields.projectStartDate = projectStartDate;
    if (hoursPerDay !== undefined) fields.hoursPerDay = hoursPerDay;
    if (autoImportNewIssues !== undefined) fields.autoImportNewIssues = autoImportNewIssues;
    if (Object.keys(fields).length === 0) return 'No fields to update.';
    const updated = await backend.updateMap(mapId, fields);
    return `Updated map "${updated.name}" (id: ${updated.id})`;
  },
});

export const deleteMapTool = defineTool({
  name: 'delete_map',
  description: 'Permanently delete a map and all its nodes',
  schema: {
    mapId: z.string().describe('The map ID to delete'),
  },
  handler: async (backend, { mapId }) => {
    await backend.deleteMap(mapId);
    return `Deleted map ${mapId}`;
  },
});

export const mapTools = [listMapsTool, getMapTool, createMapTool, updateMapTool, deleteMapTool];
