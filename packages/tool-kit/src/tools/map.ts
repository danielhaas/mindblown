import { z } from 'zod';
import { DISPATCH_POLICY_KEYS, MIX_BUGS_PREFIX, MIX_BUGS_REGEX } from '@mindblown/core';
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
    "Update a map's name, description, WIP limit, Gantt scheduling anchors, worker count, focus factor, phases, or GitHub auto-import setting. phases is the map's project-phase definition list ({id, name, position} — statusWorkflow idiom); pass the COMPLETE new array to add, rename, or reorder phases. Keep existing ids stable when renaming/reordering — nodes reference phases by id (node.phaseId), so a changed id orphans them. Omit id on a NEW entry and one is generated. wipLimit is a soft cap on how many nodes may sit in an in_progress status. projectStartDate anchors day 0 of the computed schedule (Gantt view). hoursPerDay sets the hours→days conversion when effortUnit is \"hours\" (default 8). workerCount is the parallel-track count the schedule projects onto (view knob, default 1 = strict serial). focusFactor (0.05–1.0, default 1) is the fraction of calendar time that actually reaches planned-ticket work — set it below 1 to stretch the velocity-adjusted completion forecast for meetings/support/firefighting/unplanned work (e.g. 0.5 = half of each day reaches planned work, so forecasts take twice as long). autoImportNewIssues toggles whether new GitHub issues on the bound repo auto-create nodes under the map's GitHub Inbox. maxActiveClaims / dispatchGate / dispatchPolicy configure the get_next_ticket pull queue: maxActiveClaims caps concurrently claimed nodes fleet-wide (0 = hold, grants nothing — the default); dispatchGate is an AND-filter fencing what the queue hands out (entries \"version:<versionId>\" or \"type:bug\"; empty = no fence; a ticket outside the gate is invisible, not deprioritized); dispatchPolicy is the ordered ranking of the gated ready set (keys bugs/priority/size/age; empty = default [\"bugs\",\"priority\",\"age\"]; optionally ONE parametric entry \"mix:bugs=<0-100>\" that deterministically interleaves bugs and non-bugs at that percentage — each class sorted by the remaining keys, 0 = inert, 100 = all bugs first, a drained class is back-filled by the other); profilePolicy activates profile routing for get_next_ticket (heavy = first refusal on P0-or-big tickets, light = only small P2/P3 tickets, standard/unknown = everything else; unestimated tickets go to everyone) — thresholds in hours ({heavyMinHours, lightMaxHours}, defaults: one day / 2h), estimates normalized from the map's effortUnit via hoursPerDay; null (the default) keeps the queue profile-blind. Pass nullable fields as null to clear.",
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
    workerCount: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Number of parallel work tracks the schedule projects onto (view knob, default 1 = strict serial single-worker view; higher = more parallelism).'),
    focusFactor: z
      .number()
      .min(0.05)
      .max(1)
      .optional()
      .describe('Fraction of calendar time reaching planned-ticket work (0.05–1.0, default 1). Below 1 stretches the velocity-adjusted completion forecast to absorb meetings/support/unplanned work (0.5 = half of each day reaches planned work).'),
    maxActiveClaims: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Fleet-wide cap on concurrently claimed nodes for the get_next_ticket pull queue. 0 = hold: the queue grants nothing and in-flight work drains naturally (default 0).'),
    dispatchGate: z
      .array(z.string().regex(/^(version:.+|type:bug)$/, 'gate entries must be "version:<versionId>" or "type:bug"'))
      .optional()
      .describe('Pull-queue AND-filter (REPLACE mode — the full new array). Entries: "version:<versionId>" (effective version, ancestor-inherited) and "type:bug" (node tagged "bug" or "type:bug", case-insensitive — GitHub-mirrored labels arrive as "type:bug"). Empty array = no fence. Tickets outside the gate are invisible to get_next_ticket.'),
    dispatchPolicy: z
      .array(
        // One refine, one message naming BOTH alternatives — a union of
        // enum + regex reports only the regex branch's error for an
        // off-vocabulary key like "chaos", which reads as if mix:bugs
        // were the only accepted shape.
        z.string().refine(
          (k) => (DISPATCH_POLICY_KEYS as readonly string[]).includes(k) || MIX_BUGS_REGEX.test(k),
          { message: 'policy entries must be "bugs", "priority", "size", "age", or "mix:bugs=<N>" with integer N 0-100' },
        ),
      )
      .superRefine((arr, ctx) => {
        const mixAt = arr.map((k, i) => (k.startsWith(MIX_BUGS_PREFIX) ? i : -1)).filter((i) => i >= 0);
        if (mixAt.length > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [mixAt[1]],
            message: 'at most one "mix:bugs=<N>" entry is allowed',
          });
        }
      })
      .optional()
      .describe('Pull-queue ranking keys in order (REPLACE mode): bugs = bug-tagged ("bug"/"type:bug") first, priority = priorityRank then P0–P3, size = smallest estimate first (nulls last), age = oldest first. Empty array = default ["bugs","priority","age"]. May additionally contain at most ONE parametric entry "mix:bugs=<N>" (integer N 0-100): candidates are split into bugs and non-bugs, each class is sorted by the remaining keys, then interleaved deterministically at N:(100-N) — N=0 is inert (exactly the ordering without the entry), N=100 hands out all bugs first, and a drained class is back-filled gaplessly by the other. The weave phase is persisted server-side per map and advances only on actual grants, so repeated single-ticket get_next_ticket pulls walk the pattern instead of restarting it; it is internal state, not configurable.'),
    profilePolicy: z
      .object({
        heavyMinHours: z.number().positive().optional().describe("Heavy-class floor in hours (estimate at/above = heavy pullers only). Omitted = one day (the map's hoursPerDay)."),
        lightMaxHours: z.number().positive().optional().describe('Light-eligible ceiling in hours. Omitted = 2.'),
      })
      .strict()
      .nullable()
      .optional()
      .describe('Profile routing table for get_next_ticket (#262). Presence ACTIVATES routing: heavy-class tickets (P0 or estimate ≥ heavyMinHours) go only to profile "heavy"; profile "light" gets only tickets ≤ lightMaxHours with priority P2/P3; unestimated tickets and profile "standard"/unknown/absent fail open. Ranking is unchanged — this only filters eligibility. null (the default) = profile-blind queue, the pre-#262 behavior.'),
    autoImportNewIssues: z
      .boolean()
      .optional()
      .describe('When true, new GitHub issues on the bound repo are auto-imported into this map\'s GitHub Inbox.'),
    phases: z
      .array(
        z.object({
          id: z
            .string()
            .optional()
            .describe('Stable phase id. REQUIRED for existing phases (keep it unchanged); omit for a new phase and one is generated.'),
          name: z.string().min(1).describe('Display name, e.g. "M1 – Grundgerüst"'),
          position: z
            .number()
            .optional()
            .describe('Canonical sort position. Omitted = the entry\'s index in this array.'),
          color: z.string().optional().describe('Optional hex color'),
          targetDate: z
            .string()
            .nullable()
            .optional()
            .describe('Optional ISO target date (modeled, unused in v1)'),
        }),
      )
      .optional()
      .describe(
        'Project phase definitions (REPLACE mode — the full new array). Send the complete list to add, rename, or reorder; keep ids of existing phases stable so node.phaseId references stay valid.',
      ),
  },
  handler: async (backend, { mapId, name, description, wipLimit, projectStartDate, hoursPerDay, workerCount, focusFactor, maxActiveClaims, dispatchGate, dispatchPolicy, profilePolicy, autoImportNewIssues, phases }) => {
    const fields: {
      name?: string;
      description?: string | null;
      wipLimit?: number | null;
      projectStartDate?: string | null;
      hoursPerDay?: number;
      workerCount?: number;
      focusFactor?: number;
      maxActiveClaims?: number;
      dispatchGate?: string[];
      dispatchPolicy?: string[];
      profilePolicy?: { heavyMinHours?: number; lightMaxHours?: number } | null;
      autoImportNewIssues?: boolean;
      phases?: Array<{ id: string; name: string; position: number; color?: string; targetDate?: string | null }>;
    } = {};
    if (name !== undefined) fields.name = name;
    if (description !== undefined) fields.description = description;
    if (wipLimit !== undefined) fields.wipLimit = wipLimit;
    if (projectStartDate !== undefined) fields.projectStartDate = projectStartDate;
    if (hoursPerDay !== undefined) fields.hoursPerDay = hoursPerDay;
    if (workerCount !== undefined) fields.workerCount = workerCount;
    if (focusFactor !== undefined) fields.focusFactor = focusFactor;
    if (maxActiveClaims !== undefined) fields.maxActiveClaims = maxActiveClaims;
    if (dispatchGate !== undefined) fields.dispatchGate = dispatchGate;
    if (dispatchPolicy !== undefined) fields.dispatchPolicy = dispatchPolicy;
    if (profilePolicy !== undefined) fields.profilePolicy = profilePolicy;
    if (autoImportNewIssues !== undefined) fields.autoImportNewIssues = autoImportNewIssues;
    if (phases !== undefined) {
      // Normalize: generate ids for new entries, default position to the
      // array index — callers reordering can just send the array in the
      // desired order without renumbering by hand. Entries carrying an
      // explicit position win the ordering (stable sort), then positions
      // are renumbered sequentially so mixed explicit/omitted input can't
      // produce duplicate positions with arbitrary tie-breaks downstream.
      fields.phases = phases
        .map((p, i) => ({
          id: p.id ?? crypto.randomUUID(),
          name: p.name,
          position: p.position ?? i,
          ...(p.color !== undefined ? { color: p.color } : {}),
          ...(p.targetDate !== undefined ? { targetDate: p.targetDate } : {}),
        }))
        .sort((a, b) => a.position - b.position)
        .map((p, i) => ({ ...p, position: i }));
    }
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
