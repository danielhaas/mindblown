#!/usr/bin/env node
/**
 * MindBlown MCP Server
 *
 * Exposes MindBlown's project management capabilities to AI agents
 * via the Model Context Protocol (stdio transport).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as api from './api.js';
import { formatMapTree, filterMapData, formatHealthReport, formatScheduleReport, formatSprintOverview, formatNodeDetail } from './formatters.js';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Check if a node is a leaf (has no children). Returns an error message string
 * if the node is a parent or not found, or null if validation passes.
 */
async function assertLeafNode(
  mapId: string,
  nodeId: string,
  operation: string,
): Promise<string | null> {
  const mapData = await api.getMap(mapId);
  const node = mapData.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return `Error: Node ${nodeId} not found in map ${mapId}.`;
  }
  if (node.childrenIds.length > 0) {
    return `Cannot ${operation} on a parent node. ${operation === 'set estimate' ? 'Estimates are' : 'Progress is'} auto-computed from child nodes. Set ${operation === 'set estimate' ? 'estimates' : 'progress'} on leaf nodes instead.`;
  }
  return null;
}

// ── Server setup ────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'mindblown',
    version: '0.0.1',
  },
  {
    instructions: `MindBlown is a mindmap-based project management tool. The core idea: you brainstorm in a mindmap, and the mindmap IS your project plan. There is no separate "task list" — every node in the mindmap is a task.

## Key concepts

- **Maps** are projects. Each map has a root node and a tree of child nodes.
- **Nodes** are everything: ideas, tasks, epics, milestones. A node starts as a simple text label and can be gradually enriched with estimates, status, priority, dates, assignees, etc.
- **Leaf nodes** are where you set effort estimates and percent complete. Parent nodes auto-compute these values from their children using weighted rollup.
- **Health signals** propagate upward: if any leaf is "behind", its entire ancestor chain is marked "behind" (worst-child-wins).
- **Dependencies** link nodes with 4 types: Finish-to-Start (FS), Start-to-Start (SS), Finish-to-Finish (FF), Start-to-Finish (SF). These feed the critical path scheduler.
- **Versions** are release containers (e.g. "V1", "V2"). They are NOT tree nodes — they are separate entities created with create_version. Nodes are linked to a version via update_node (set versionId), independent of their position in the tree. Multiple sprints and milestones belong to a version.
- **Milestones** are key deliverables within a version (first-class entities, not node flags). Nodes can be linked to a milestone.
- **Sprints/Cycles** are time-boxed iterations within a version. Nodes can be assigned to a sprint.

## The planning loop

1. Map out work as a mindmap (create nodes under parents)
2. Set effort estimates on leaf nodes (set_estimate)
3. Set percent complete on leaves as work progresses (set_progress)
4. Parent nodes auto-compute progress (weighted: sum(child.estimate × child.progress) / sum(child.estimate))
5. Health signals propagate upward automatically
6. Schedule projections update via critical path analysis (get_schedule)

## Typical workflows

**Starting a new project:** create_map → create nodes for major areas → add child nodes for tasks → set estimates on leaves.

**Checking status:** list_maps → get_map (shows full tree with computed progress/health) → use get_schedule for timeline.

**Updating progress:** set_progress on leaf nodes you've worked on. Parents update automatically.

**Release planning (versions + milestones):**
1. create_version to define a release (e.g. "V1", "V2")
2. create_milestone to define key deliverables within that version (e.g. "Kernsystem MVP", "Billing Module")
3. Tag nodes with a version using assign_to_version, or set versionId/milestoneId via update_node
4. list_versions / list_milestones to review what's planned for each release

Example: A node "Data Retention Policy" lives under Compliance in the tree (functional), and is tagged with version "V1" and milestone "Kernsystem MVP" (release planning). These are independent dimensions.

**Multi-release project:**
1. create_version for each release (e.g. "V1", "V2")
2. Build the tree by functional area (Auth, Billing, etc.) — the tree structure stays the same across releases
3. Tag leaf nodes with the version they ship in: update_node with versionId
4. Some nodes under "Auth" might be V1, others V2 — that's expected. The tree groups by WHAT, versions group by WHEN.
5. Use list_versions to see progress per release, get_map to see progress per functional area

**Sprint planning:**
1. create_cycle to define a time-boxed sprint, optionally within a version (set versionId)
2. assign_to_sprint to add tasks to the sprint
3. list_cycles to review sprints and their progress

**Finding problems:** Use the identify_risks or project_status prompts, or read the health resource to see at-risk/behind nodes.

**GitHub integration:** import_github_issues to pull issues from a connected GitHub repo (creates a FUNCTIONAL mindmap grouped by feature area, not by version; GitHub milestones become MindBlown versions + milestones; re-runs are safe — existing links are skipped, text matches are linked in place). link_github_issue attaches an existing node to a specific GitHub issue. create_github_issue_from_node does the reverse: promotes an existing MindBlown node to a new GitHub issue and links it back. NEVER use create_node when the task already exists as a GitHub issue — use import/link instead so it syncs.

## Important: Mindmap = functional structure, Versions = release planning

The mindmap tree is organized by **functional area** (e.g. "Compliance", "Billing", "Workflows") — this is the WHAT.
Versions, milestones, and sprints are orthogonal metadata on nodes — this is the WHEN and WHY.

- **versionId** on a node = "this ships in V1"
- **milestoneId** on a node = "this contributes to the Kernsystem MVP milestone"
- **cycleId** on a node = "this is being worked on in Sprint 3"

A node can have all three set independently. Never reorganize the tree by version — use these fields instead.

**Do NOT create tree nodes for versions.** "V1" and "V2" are created with create_version, not create_node. If you create a "V1" node in the tree, it won't function as a version — it's just a regular node with no release-tracking capabilities.

## Important notes

- Always call list_maps first to discover available maps and their IDs.
- When creating nodes, you need a mapId and parentId. Get these from get_map.
- Progress and effort only make sense on leaf nodes (nodes with no children). Parents compute automatically.
- The get_map tool returns the full tree with all computed fields — it's the most informative single call.
- Node IDs are UUIDs. You'll get them from list_maps, get_map, or create responses.
- For GitHub issues, always use import_github_issues or link_github_issue instead of create_node.
- When organizing a project, group nodes by functional area (what it does), not by version (when it ships).`,
  },
);

// ── Helper: wrap tool handlers with error handling ──────────────

function toolResult(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function toolError(err: unknown) {
  const message = err instanceof api.ApiError
    ? `API Error (${err.status}): ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ════════════════════════════════════════════════════════════════
//  TOOLS
// ════════════════════════════════════════════════════════════════

// ── Map tools ───────────────────────────────────────────────────

server.tool(
  'list_maps',
  'List all maps with name, progress percentage, and health signal',
  {},
  async () => {
    try {
      const maps = await api.listMaps();
      const lines = maps.map((m) => {
        const health = m.healthSignal === 'on_track' ? '[OK]' : m.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
        return `- ${m.name} (id: ${m.id}, workspaceId: ${m.workspaceId}) — ${Math.round(m.computedProgress)}% complete ${health}`;
      });
      return toolResult(lines.length > 0 ? lines.join('\n') : 'No maps found.');
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'get_map',
  'Get a map\'s tree structure with computed fields (effort, progress, health). Optionally filter to only show nodes matching criteria (ancestors are kept to preserve tree structure).',
  {
    mapId: z.string().describe('The map ID'),
    status: z.string().optional().describe('Filter by status (e.g. "in_progress", "done")'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority level'),
    healthSignal: z.enum(['on_track', 'at_risk', 'behind']).optional().describe('Filter by health signal'),
    tag: z.string().optional().describe('Filter by tag — show only nodes that have this tag'),
  },
  async ({ mapId, status, priority, healthSignal, tag }) => {
    try {
      const data = await api.getMap(mapId);
      const hasFilters = status !== undefined || priority !== undefined || healthSignal !== undefined || tag !== undefined;
      const filtered = hasFilters ? filterMapData(data, { status, priority, healthSignal, tag }) : data;
      const header = hasFilters ? `[Filtered: ${[status && `status=${status}`, priority && `priority=${priority}`, healthSignal && `health=${healthSignal}`, tag && `tag=${tag}`].filter(Boolean).join(', ')}]\n\n` : '';
      return toolResult(header + formatMapTree(filtered));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_map',
  'Create a new map/project',
  {
    name: z.string().describe('Map name'),
    description: z.string().optional().describe('Map description'),
  },
  async ({ name, description }) => {
    try {
      const result = await api.createMap(name, description);
      return toolResult(`Created map "${name}" with id: ${result.id}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'update_map',
  'Update a map\'s name, description, WIP limit, or Gantt scheduling anchors. wipLimit is a soft cap on how many nodes may sit in an in_progress status. projectStartDate anchors day 0 of the computed schedule (Gantt view). hoursPerDay sets the hours→days conversion when effortUnit is "hours" (default 8). Pass nullable fields as null to clear.',
  {
    mapId: z.string().describe('The map ID'),
    name: z.string().optional().describe('New map name'),
    description: z.string().nullable().optional().describe('New map description'),
    wipLimit: z.number().nullable().optional().describe('Soft WIP limit on in-progress nodes (null to disable)'),
    projectStartDate: z.string().nullable().optional().describe('Gantt anchor date (ISO YYYY-MM-DD); null = use today'),
    hoursPerDay: z.number().min(0.1).optional().describe('Working hours per day for Gantt conversion when effortUnit is "hours" (default 8)'),
  },
  async ({ mapId, name, description, wipLimit, projectStartDate, hoursPerDay }) => {
    try {
      const fields: {
        name?: string;
        description?: string | null;
        wipLimit?: number | null;
        projectStartDate?: string | null;
        hoursPerDay?: number;
      } = {};
      if (name !== undefined) fields.name = name;
      if (description !== undefined) fields.description = description;
      if (wipLimit !== undefined) fields.wipLimit = wipLimit;
      if (projectStartDate !== undefined) fields.projectStartDate = projectStartDate;
      if (hoursPerDay !== undefined) fields.hoursPerDay = hoursPerDay;
      if (Object.keys(fields).length === 0) {
        return toolResult('No fields to update.');
      }
      const updated = await api.updateMap(mapId, fields);
      return toolResult(`Updated map "${updated.name}" (id: ${updated.id})`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'delete_map',
  'Permanently delete a map and all its nodes',
  {
    mapId: z.string().describe('The map ID to delete'),
  },
  async ({ mapId }) => {
    try {
      await api.deleteMap(mapId);
      return toolResult(`Deleted map ${mapId}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Node tools ──────────────────────────────────────────────────

server.tool(
  'create_node',
  'Create a new node (task/idea) in a map under a parent node',
  {
    mapId: z.string().describe('The map ID'),
    parentId: z.string().describe('Parent node ID to create under'),
    text: z.string().describe('Node title/label'),
    effortEstimate: z.number().optional().describe('Effort estimate (leaf nodes only)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority level'),
    status: z.string().optional().describe('Status (must match map\'s status workflow)'),
    dueDate: z.string().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().optional().describe('Start date (ISO 8601)'),
    versionId: z.string().optional().describe('Version ID to assign this node to'),
  },
  async ({ mapId, parentId, text, ...fields }) => {
    try {
      const cleanFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) cleanFields[k] = v;
      }
      const node = await api.createNode(mapId, parentId, text, cleanFields);
      return toolResult(`Created node "${text}" (id: ${node.id}) under parent ${parentId}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'update_node',
  'Update any field on a node',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to update'),
    text: z.string().optional().describe('New title/label'),
    description: z.string().optional().describe('Rich text description'),
    effortEstimate: z.number().nullable().optional().describe('Effort estimate'),
    percentComplete: z.number().nullable().optional().describe('Percent complete (0-100)'),
    status: z.string().nullable().optional().describe('Status'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable().optional().describe('Priority'),
    dueDate: z.string().nullable().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().nullable().optional().describe('Start date (ISO 8601)'),
    tags: z.array(z.string()).optional().describe('Tags'),
    assigneeIds: z.array(z.string()).optional().describe('Assignee user IDs'),
    versionId: z.string().nullable().optional().describe('Version ID (null to unassign)'),
    isMilestone: z.boolean().optional().describe('Whether this is a milestone'),
  },
  async ({ mapId, nodeId, ...fields }) => {
    try {
      const cleanFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) cleanFields[k] = v;
      }
      if (Object.keys(cleanFields).length === 0) {
        return toolResult('No fields to update.');
      }
      await api.updateNode(mapId, nodeId, cleanFields);
      return toolResult(`Updated node ${nodeId}: ${Object.keys(cleanFields).join(', ')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'delete_node',
  'Delete a node and all its descendants',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to delete'),
  },
  async ({ mapId, nodeId }) => {
    try {
      await api.deleteNode(mapId, nodeId);
      return toolResult(`Deleted node ${nodeId} and its descendants.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'move_node',
  'Move a node to a new parent',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to move'),
    newParentId: z.string().describe('The new parent node ID'),
    index: z.number().optional().describe('Position among siblings (0-based)'),
  },
  async ({ mapId, nodeId, newParentId, index }) => {
    try {
      await api.moveNode(mapId, nodeId, newParentId, index);
      return toolResult(`Moved node ${nodeId} under parent ${newParentId}${index !== undefined ? ` at position ${index}` : ''}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

const VALID_NODE_FIELDS = new Set([
  'text', 'description', 'effortEstimate', 'percentComplete', 'status',
  'priority', 'dueDate', 'startDate', 'tags', 'assigneeIds', 'isMilestone',
]);

server.tool(
  'bulk_update_nodes',
  'Update multiple nodes at once. Valid fields: text, description, effortEstimate, percentComplete, status, priority, dueDate, startDate, tags, assigneeIds, isMilestone',
  {
    mapId: z.string().describe('The map ID'),
    updates: z.array(z.object({
      nodeId: z.string().describe('Node ID'),
      fields: z.record(z.unknown()).describe('Fields to update'),
    })).describe('Array of {nodeId, fields} updates'),
  },
  async ({ mapId, updates }) => {
    try {
      const results: string[] = [];
      for (const { nodeId, fields } of updates) {
        const unknownFields = Object.keys(fields).filter((k) => !VALID_NODE_FIELDS.has(k));
        if (unknownFields.length > 0) {
          results.push(`  ${nodeId}: FAILED — unknown field(s): ${unknownFields.join(', ')}`);
          continue;
        }
        try {
          await api.updateNode(mapId, nodeId, fields as Record<string, unknown>);
          results.push(`  ${nodeId}: updated ${Object.keys(fields).join(', ')}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`  ${nodeId}: FAILED — ${msg}`);
        }
      }
      return toolResult(`Bulk update results:\n${results.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_create_nodes',
  'Create multiple nodes in a single batch. Nodes are created sequentially so earlier nodes can be parents of later ones. Use tempId to reference a node created earlier in the same batch as a parentId.',
  {
    mapId: z.string().describe('The map ID'),
    nodes: z.array(z.object({
      tempId: z.string().optional().describe('Temporary ID for this node, so later nodes in the batch can reference it as parentId'),
      parentId: z.string().describe('Parent node ID (can be a real ID or a tempId from an earlier node in this batch)'),
      text: z.string().describe('Node title/label'),
      effortEstimate: z.number().optional().describe('Effort estimate (leaf nodes only)'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority level'),
      status: z.string().optional().describe('Status (must match map\'s status workflow)'),
      dueDate: z.string().optional().describe('Due date (ISO 8601)'),
      startDate: z.string().optional().describe('Start date (ISO 8601)'),
    })).describe('Array of node definitions to create, processed in order'),
  },
  async ({ mapId, nodes }) => {
    try {
      const tempIdMap = new Map<string, string>();
      const results: string[] = [];
      let created = 0;

      for (let i = 0; i < nodes.length; i++) {
        const { tempId, parentId, text, ...fields } = nodes[i];
        try {
          // Resolve parentId: check if it's a tempId reference
          const resolvedParentId = tempIdMap.get(parentId) ?? parentId;

          const cleanFields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined) cleanFields[k] = v;
          }

          const node = await api.createNode(mapId, resolvedParentId, text, cleanFields);
          created++;

          // Register tempId mapping if provided
          if (tempId) {
            tempIdMap.set(tempId, node.id);
          }

          results.push(`  ${tempId ?? `[${i}]`}: "${text}" created (id: ${node.id}) under ${resolvedParentId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`  ${tempId ?? `[${i}]`}: "${text}" FAILED — ${msg}`);
        }
      }
      return toolResult(`Bulk create results (${created}/${nodes.length} created):\n${results.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_set_estimate',
  'Set effort estimates on multiple leaf nodes at once',
  {
    mapId: z.string().describe('The map ID'),
    estimates: z.array(z.object({
      nodeId: z.string().describe('Node ID'),
      estimate: z.number().min(0).describe('Effort estimate (must be >= 0)'),
    })).describe('Array of {nodeId, estimate} pairs'),
  },
  async ({ mapId, estimates }) => {
    try {
      const mapData = await api.getMap(mapId);
      const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n]));
      const results: string[] = [];
      for (const { nodeId, estimate } of estimates) {
        try {
          const node = nodeMap.get(nodeId);
          if (!node) {
            results.push(`  ${nodeId}: FAILED — Node not found in map ${mapId}`);
            continue;
          }
          if (node.childrenIds.length > 0) {
            results.push(`  ${nodeId}: SKIPPED — Cannot set estimate on a parent node. Estimates are auto-computed from child nodes.`);
            continue;
          }
          await api.updateNode(mapId, nodeId, { effortEstimate: estimate });
          results.push(`  ${nodeId}: estimate = ${estimate}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`  ${nodeId}: FAILED — ${msg}`);
        }
      }
      return toolResult(`Bulk set_estimate results (${estimates.length} nodes):\n${results.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_set_progress',
  'Set percent complete on multiple leaf nodes at once',
  {
    mapId: z.string().describe('The map ID'),
    updates: z.array(z.object({
      nodeId: z.string().describe('Node ID'),
      percent: z.number().min(0).max(100).describe('Percent complete (0-100)'),
    })).describe('Array of {nodeId, percent} pairs'),
  },
  async ({ mapId, updates }) => {
    try {
      const mapData = await api.getMap(mapId);
      const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n]));
      const results: string[] = [];
      for (const { nodeId, percent } of updates) {
        try {
          const node = nodeMap.get(nodeId);
          if (!node) {
            results.push(`  ${nodeId}: FAILED — Node not found in map ${mapId}`);
            continue;
          }
          if (node.childrenIds.length > 0) {
            results.push(`  ${nodeId}: SKIPPED — Cannot set progress on a parent node. Progress is auto-computed from child nodes.`);
            continue;
          }
          await api.updateNode(mapId, nodeId, { percentComplete: percent });
          results.push(`  ${nodeId}: progress = ${percent}%`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`  ${nodeId}: FAILED — ${msg}`);
        }
      }
      return toolResult(`Bulk set_progress results (${updates.length} nodes):\n${results.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Task property tools ─────────────────────────────────────────

server.tool(
  'set_estimate',
  'Set effort estimate on a leaf node',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    estimate: z.number().describe('Effort estimate value'),
  },
  async ({ mapId, nodeId, estimate }) => {
    try {
      const err = await assertLeafNode(mapId, nodeId, 'set estimate');
      if (err) return toolResult(err);
      await api.updateNode(mapId, nodeId, { effortEstimate: estimate });
      return toolResult(`Set estimate on ${nodeId} to ${estimate}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'set_actual_effort',
  'Record the actual effort spent on a leaf node, in the same unit as the estimate. Enables the estimation feedback loop — compare planned vs actual with get_estimation_accuracy. Usually set when marking a task complete.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    actualEffort: z.number().min(0).describe('Actual effort (must be >= 0), in the map\'s effort unit'),
  },
  async ({ mapId, nodeId, actualEffort }) => {
    try {
      const err = await assertLeafNode(mapId, nodeId, 'set actual effort');
      if (err) return toolResult(err);
      await api.updateNode(mapId, nodeId, { actualEffort });
      return toolResult(`Set actual effort on ${nodeId} to ${actualEffort}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_set_actual_effort',
  'Record actual effort on multiple leaf nodes at once',
  {
    mapId: z.string().describe('The map ID'),
    updates: z.array(z.object({
      nodeId: z.string().describe('Node ID'),
      actualEffort: z.number().min(0).describe('Actual effort (must be >= 0)'),
    })).describe('Array of {nodeId, actualEffort} pairs'),
  },
  async ({ mapId, updates }) => {
    try {
      const mapData = await api.getMap(mapId);
      const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n]));
      const results: string[] = [];
      for (const { nodeId, actualEffort } of updates) {
        try {
          const node = nodeMap.get(nodeId);
          if (!node) {
            results.push(`  ${nodeId}: FAILED — Node not found in map ${mapId}`);
            continue;
          }
          if (node.childrenIds.length > 0) {
            results.push(`  ${nodeId}: SKIPPED — Cannot set actual effort on a parent node.`);
            continue;
          }
          await api.updateNode(mapId, nodeId, { actualEffort });
          results.push(`  ${nodeId}: actual = ${actualEffort}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`  ${nodeId}: FAILED — ${msg}`);
        }
      }
      return toolResult(`Bulk set_actual_effort results (${updates.length} nodes):\n${results.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'get_estimation_accuracy',
  'Report estimation accuracy (actual vs estimated effort) across completed leaf nodes. Returns overall fudge factor (sum(actual)/sum(estimate)), distribution buckets, and per-node detail. Optionally scope by sprint, version, or assignee.',
  {
    mapId: z.string().describe('The map ID'),
    cycleId: z.string().optional().describe('Scope to a specific sprint/cycle'),
    versionId: z.string().optional().describe('Scope to a specific version'),
    assigneeId: z.string().optional().describe('Scope to a specific assignee'),
  },
  async ({ mapId, cycleId, versionId, assigneeId }) => {
    try {
      const data = await api.getMap(mapId);
      const candidates = data.nodes.filter((n) => {
        if ((n.childrenIds?.length ?? 0) > 0) return false;
        if (n.effortEstimate == null || n.actualEffort == null) return false;
        if (cycleId && n.cycleId !== cycleId) return false;
        if (versionId && n.versionId !== versionId) return false;
        if (assigneeId && !(n.assigneeIds ?? []).includes(assigneeId)) return false;
        return true;
      });

      if (candidates.length === 0) {
        return toolResult(
          'No nodes with both effortEstimate and actualEffort recorded. Set actualEffort on completed leaf nodes to build up estimation history.',
        );
      }

      const totalEstimate = candidates.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
      const totalActual = candidates.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
      const fudgeFactor = totalEstimate > 0 ? totalActual / totalEstimate : 0;

      // Distribution buckets by ratio per node
      const buckets = { under: 0, onTarget: 0, over: 0, wayOver: 0 };
      for (const n of candidates) {
        const est = n.effortEstimate ?? 0;
        const act = n.actualEffort ?? 0;
        if (est === 0) continue;
        const ratio = act / est;
        if (ratio < 0.8) buckets.under++;
        else if (ratio <= 1.2) buckets.onTarget++;
        else if (ratio <= 2.0) buckets.over++;
        else buckets.wayOver++;
      }

      const unit = data.map.effortUnit ?? 'units';
      const scope: string[] = [];
      if (cycleId) scope.push(`cycle=${cycleId}`);
      if (versionId) scope.push(`version=${versionId}`);
      if (assigneeId) scope.push(`assignee=${assigneeId}`);

      const lines: string[] = [];
      lines.push(`Estimation accuracy${scope.length ? ` [${scope.join(', ')}]` : ''}`);
      lines.push(`Nodes with both estimate + actual: ${candidates.length}`);
      lines.push(`Total estimated: ${totalEstimate.toFixed(2)} ${unit}`);
      lines.push(`Total actual:    ${totalActual.toFixed(2)} ${unit}`);
      lines.push(`Fudge factor:    ${fudgeFactor.toFixed(2)}x (multiply future estimates by this)`);
      lines.push('');
      lines.push('Distribution (per node ratio = actual / estimate):');
      lines.push(`  Underestimated by user (<0.8x):   ${buckets.under}`);
      lines.push(`  On target (0.8x – 1.2x):          ${buckets.onTarget}`);
      lines.push(`  Over (1.2x – 2.0x):               ${buckets.over}`);
      lines.push(`  Way over (>2.0x):                 ${buckets.wayOver}`);
      lines.push('');
      lines.push('Worst 5 offenders (largest overrun):');
      const sorted = [...candidates]
        .filter((n) => (n.effortEstimate ?? 0) > 0)
        .sort((a, b) => {
          const ra = (a.actualEffort ?? 0) / (a.effortEstimate ?? 1);
          const rb = (b.actualEffort ?? 0) / (b.effortEstimate ?? 1);
          return rb - ra;
        })
        .slice(0, 5);
      for (const n of sorted) {
        const est = n.effortEstimate ?? 0;
        const act = n.actualEffort ?? 0;
        const ratio = est > 0 ? (act / est).toFixed(2) : '∞';
        lines.push(`  - ${n.id} ${n.text}: ${est} → ${act} (${ratio}x)`);
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'remaining_work',
  'Report how much work is left for a node/subtree/version/milestone. Returns remaining effort, incomplete leaf count, weighted % done, and count of leaves with no estimate. Answers "how much is left?" — the basic MI question. Scope with one of nodeId (subtree), versionId, or milestoneId; omit all to report on the whole map.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().optional().describe('Scope to this node and its descendants'),
    versionId: z.string().optional().describe('Scope to leaves tagged with this version (directly or via an ancestor)'),
    milestoneId: z.string().optional().describe('Scope to leaves tagged with this milestone (directly or via an ancestor)'),
  },
  async ({ mapId, nodeId, versionId, milestoneId }) => {
    try {
      const data = await api.getMap(mapId);
      const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

      // Walk ancestor chain for a given leaf, collecting version/milestone ids
      // encountered along the way. Used for inherited-scope matching.
      const ancestorTags = (leafId: string): { versions: Set<string>; milestones: Set<string> } => {
        const versions = new Set<string>();
        const milestones = new Set<string>();
        let cur = nodeById.get(leafId);
        while (cur) {
          if (cur.versionId) versions.add(cur.versionId);
          if (cur.milestoneId) milestones.add(cur.milestoneId);
          cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
        }
        return { versions, milestones };
      };

      // Collect the set of leaf ids in scope. Subtree scoping walks down from
      // nodeId; version/milestone scoping filters across the whole map using
      // inherited tags.
      let leaves: typeof data.nodes;
      let scopeLabel = 'whole map';

      if (nodeId) {
        const root = nodeById.get(nodeId);
        if (!root) return toolError(`Node ${nodeId} not found in map ${mapId}.`);
        scopeLabel = `subtree of "${root.text}" (${nodeId})`;
        const subtreeLeaves: typeof data.nodes = [];
        const stack = [root];
        while (stack.length) {
          const n = stack.pop()!;
          if ((n.childrenIds?.length ?? 0) === 0) {
            subtreeLeaves.push(n);
          } else {
            for (const cid of n.childrenIds) {
              const c = nodeById.get(cid);
              if (c) stack.push(c);
            }
          }
        }
        leaves = subtreeLeaves;
      } else {
        leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
      }

      if (versionId) {
        scopeLabel = `version ${versionId}` + (nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).versions.has(versionId));
      }
      if (milestoneId) {
        scopeLabel = `milestone ${milestoneId}` + (versionId || nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).milestones.has(milestoneId));
      }

      if (leaves.length === 0) {
        return toolResult(`No leaf nodes in scope (${scopeLabel}).`);
      }

      let totalEffort = 0;
      let doneEffort = 0;
      let remainingEffort = 0;
      let completeLeaves = 0;
      let incompleteLeaves = 0;
      let noEstimateLeaves = 0;
      const remainingDetails: Array<{ id: string; text: string; remaining: number; progress: number }> = [];

      for (const leaf of leaves) {
        const estimate = leaf.effortEstimate ?? 0;
        const progress = leaf.percentComplete ?? 0;
        if (leaf.effortEstimate == null) noEstimateLeaves++;
        totalEffort += estimate;
        doneEffort += estimate * (progress / 100);
        const leafRemaining = estimate * (1 - progress / 100);
        remainingEffort += leafRemaining;
        if (progress >= 100) {
          completeLeaves++;
        } else {
          incompleteLeaves++;
          if (estimate > 0) {
            remainingDetails.push({
              id: leaf.id,
              text: leaf.text,
              remaining: leafRemaining,
              progress,
            });
          }
        }
      }

      const weightedPercent = totalEffort > 0 ? (doneEffort / totalEffort) * 100 : 0;
      const unit = data.map.effortUnit ?? 'units';

      const lines: string[] = [];
      lines.push(`Remaining work — ${scopeLabel}`);
      lines.push('');
      lines.push(`Leaves in scope:     ${leaves.length}`);
      lines.push(`  Complete:          ${completeLeaves}`);
      lines.push(`  Incomplete:        ${incompleteLeaves}`);
      lines.push(`  Without estimate:  ${noEstimateLeaves}${noEstimateLeaves > 0 ? ' ⚠' : ''}`);
      lines.push('');
      lines.push(`Total estimated:     ${totalEffort.toFixed(2)} ${unit}`);
      lines.push(`Done:                ${doneEffort.toFixed(2)} ${unit}`);
      lines.push(`Remaining:           ${remainingEffort.toFixed(2)} ${unit}`);
      lines.push(`Weighted % done:     ${weightedPercent.toFixed(1)}%`);

      if (remainingDetails.length > 0) {
        lines.push('');
        lines.push('Top 10 largest remaining items:');
        const sorted = [...remainingDetails].sort((a, b) => b.remaining - a.remaining).slice(0, 10);
        for (const item of sorted) {
          lines.push(`  - ${item.remaining.toFixed(2)} ${unit} (${item.progress}% done) ${item.id} ${item.text}`);
        }
      }

      if (noEstimateLeaves > 0) {
        lines.push('');
        lines.push(`⚠ ${noEstimateLeaves} leaf(s) in scope have no estimate — remaining total excludes them.`);
      }

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'completion_forecast',
  'Forecast "when will it be done?" for a node/subtree/version/milestone. Reports: planned finish date (scheduler-based, respects dependencies), velocity-adjusted finish date (scales by past estimation accuracy from get_estimation_accuracy), target date (from version/milestone or node dueDates), and slip vs target. Scope with one of nodeId, versionId, or milestoneId; omit all to forecast the whole map.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().optional().describe('Scope to this node and its descendants'),
    versionId: z.string().optional().describe('Scope to leaves tagged with this version (directly or via an ancestor)'),
    milestoneId: z.string().optional().describe('Scope to leaves tagged with this milestone (directly or via an ancestor)'),
  },
  async ({ mapId, nodeId, versionId, milestoneId }) => {
    try {
      const data = await api.getMap(mapId);
      const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

      const ancestorTags = (leafId: string): { versions: Set<string>; milestones: Set<string> } => {
        const versions = new Set<string>();
        const milestones = new Set<string>();
        let cur = nodeById.get(leafId);
        while (cur) {
          if (cur.versionId) versions.add(cur.versionId);
          if (cur.milestoneId) milestones.add(cur.milestoneId);
          cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
        }
        return { versions, milestones };
      };

      // ── Determine scope (same logic as remaining_work) ──
      let leaves: typeof data.nodes;
      let scopeLabel = 'whole map';
      if (nodeId) {
        const root = nodeById.get(nodeId);
        if (!root) return toolError(`Node ${nodeId} not found in map ${mapId}.`);
        scopeLabel = `subtree of "${root.text}" (${nodeId})`;
        const subtreeLeaves: typeof data.nodes = [];
        const stack = [root];
        while (stack.length) {
          const n = stack.pop()!;
          if ((n.childrenIds?.length ?? 0) === 0) {
            subtreeLeaves.push(n);
          } else {
            for (const cid of n.childrenIds) {
              const c = nodeById.get(cid);
              if (c) stack.push(c);
            }
          }
        }
        leaves = subtreeLeaves;
      } else {
        leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
      }
      if (versionId) {
        scopeLabel = `version ${versionId}` + (nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).versions.has(versionId));
      }
      if (milestoneId) {
        scopeLabel = `milestone ${milestoneId}` + (versionId || nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).milestones.has(milestoneId));
      }

      if (leaves.length === 0) {
        return toolResult(`No leaf nodes in scope (${scopeLabel}).`);
      }

      // ── Remaining effort (same math as remaining_work) ──
      let remainingEffort = 0;
      let totalEffort = 0;
      let noEstimateLeaves = 0;
      const targetDates: string[] = [];
      for (const leaf of leaves) {
        if (leaf.effortEstimate == null) noEstimateLeaves++;
        const estimate = leaf.effortEstimate ?? 0;
        const progress = leaf.percentComplete ?? 0;
        totalEffort += estimate;
        remainingEffort += estimate * (1 - progress / 100);
        if (leaf.dueDate) targetDates.push(leaf.dueDate);
      }

      // ── Fudge factor from estimation accuracy ──
      const calibrationLeaves = data.nodes.filter(
        (n) =>
          (n.childrenIds?.length ?? 0) === 0 &&
          n.effortEstimate != null &&
          n.actualEffort != null,
      );
      const calibEstimate = calibrationLeaves.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
      const calibActual = calibrationLeaves.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
      const fudgeFactor = calibEstimate > 0 ? calibActual / calibEstimate : null;
      const effectiveFudge = fudgeFactor ?? 1.0;

      // ── Scheduler-based planned finish ──
      const sched = await api.getSchedule(mapId);
      const scopedIds = new Set(leaves.map((l) => l.id));
      const scopedSched = sched.schedule.filter((s) => scopedIds.has(s.nodeId));
      const maxComputedEnd = scopedSched.reduce((m, s) => Math.max(m, s.computedEnd), 0);

      const MS_PER_DAY = 86_400_000;
      const projectStart = new Date(sched.projectStartDate);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const effortUnitsToCalendarDays = (units: number): number => units / sched.unitsPerDay;
      const addCalendarDays = (base: Date, days: number): Date => {
        const d = new Date(base.getTime());
        d.setUTCDate(d.getUTCDate() + Math.ceil(days));
        return d;
      };
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const daysBetween = (a: Date, b: Date) =>
        Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);

      const plannedFinishCalendarDays = effortUnitsToCalendarDays(maxComputedEnd);
      const plannedFinishDate = addCalendarDays(projectStart, plannedFinishCalendarDays);

      // Velocity-adjusted finish: take the scheduler's remaining calendar days
      // (which already accounts for parallelism and dependencies) and scale by
      // the fudge factor. If the scheduler says 5 days and fudge is 1.5x, we
      // expect 7.5 days. Anchor at max(today, projectStart) so a future-start
      // project doesn't report a past finish.
      const anchor = today > projectStart ? today : projectStart;
      const elapsedFromStart = Math.max(0, daysBetween(anchor, projectStart));
      const remainingSchedulerDays = Math.max(0, plannedFinishCalendarDays - elapsedFromStart);
      const velocityFinishCalendarDays = remainingSchedulerDays * effectiveFudge;
      const velocityFinishDate = addCalendarDays(anchor, velocityFinishCalendarDays);

      // ── Target date resolution ──
      let targetDate: string | null = null;
      let targetSource = '';
      if (versionId || milestoneId) {
        try {
          if (milestoneId) {
            const milestones = await api.listMilestones(data.map.workspaceId);
            const m = milestones.find((m) => m.id === milestoneId);
            if (m?.targetDate) {
              targetDate = m.targetDate.slice(0, 10);
              targetSource = `milestone "${m.name}"`;
            }
          }
          if (!targetDate && versionId) {
            const versions = await api.listVersions(data.map.workspaceId);
            const v = versions.find((v) => v.id === versionId);
            if (v?.targetDate) {
              targetDate = v.targetDate.slice(0, 10);
              targetSource = `version "${v.name}"`;
            }
          }
        } catch {
          /* fall through to node dueDates */
        }
      }
      if (!targetDate && targetDates.length > 0) {
        targetDate = targetDates.sort().slice(-1)[0].slice(0, 10);
        targetSource = 'max leaf dueDate';
      }

      // ── Format output ──
      const unit = data.map.effortUnit ?? 'units';
      const lines: string[] = [];
      lines.push(`Completion forecast — ${scopeLabel}`);
      lines.push('');
      lines.push(`Leaves in scope:     ${leaves.length}`);
      lines.push(`  Without estimate:  ${noEstimateLeaves}${noEstimateLeaves > 0 ? ' ⚠' : ''}`);
      lines.push(`Total estimated:     ${totalEffort.toFixed(2)} ${unit}`);
      lines.push(`Remaining:           ${remainingEffort.toFixed(2)} ${unit}`);
      lines.push('');
      if (fudgeFactor != null) {
        lines.push(`Velocity calibration: ${calibrationLeaves.length} completed leaves, fudge = ${fudgeFactor.toFixed(2)}x`);
      } else {
        lines.push(`Velocity calibration: no data (need leaves with both estimate + actual); using 1.00x`);
      }
      lines.push('');

      if (maxComputedEnd > 0) {
        lines.push(`Planned finish:      ${iso(plannedFinishDate)} (scheduler, project start ${sched.projectStartDate})`);
      } else {
        lines.push(`Planned finish:      (no schedulable effort in scope)`);
      }
      if (remainingEffort > 0) {
        lines.push(`Velocity-adjusted:   ${iso(velocityFinishDate)} (${velocityFinishCalendarDays.toFixed(1)} calendar days from ${iso(anchor)}, fudge ${effectiveFudge.toFixed(2)}x)`);
      } else {
        lines.push(`Velocity-adjusted:   already complete`);
      }

      if (targetDate) {
        lines.push('');
        lines.push(`Target:              ${targetDate} (${targetSource})`);
        const targetDateObj = new Date(targetDate);
        if (maxComputedEnd > 0) {
          const slipPlanned = daysBetween(plannedFinishDate, targetDateObj);
          lines.push(`Slip (planned):      ${slipPlanned >= 0 ? '+' : ''}${slipPlanned} days`);
        }
        if (remainingEffort > 0) {
          const slipVel = daysBetween(velocityFinishDate, targetDateObj);
          lines.push(`Slip (velocity):     ${slipVel >= 0 ? '+' : ''}${slipVel} days`);
        }
      } else {
        lines.push('');
        lines.push(`Target:              (no target date set)`);
      }

      if (noEstimateLeaves > 0) {
        lines.push('');
        lines.push(`⚠ ${noEstimateLeaves} leaf(s) in scope have no estimate — excluded from remaining-effort math.`);
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'risk_scan',
  'Surface project risks across a map/subtree/version/milestone: stalled in-progress work, leaves without estimates, in-flight overruns (actual > estimate), fragile critical-path nodes (on CP with problems), and unassigned P0/P1 leaves. Use this before planning sessions to catch problems early.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().optional().describe('Scope to this node and its descendants'),
    versionId: z.string().optional().describe('Scope to leaves tagged with this version'),
    milestoneId: z.string().optional().describe('Scope to leaves tagged with this milestone'),
    stalledDays: z.number().int().min(1).default(7).describe('Days since last update before in-progress work is flagged as stalled (default 7)'),
  },
  async ({ mapId, nodeId, versionId, milestoneId, stalledDays }) => {
    try {
      const data = await api.getMap(mapId);
      const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

      const ancestorTags = (leafId: string): { versions: Set<string>; milestones: Set<string> } => {
        const versions = new Set<string>();
        const milestones = new Set<string>();
        let cur = nodeById.get(leafId);
        while (cur) {
          if (cur.versionId) versions.add(cur.versionId);
          if (cur.milestoneId) milestones.add(cur.milestoneId);
          cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
        }
        return { versions, milestones };
      };

      let leaves: typeof data.nodes;
      let scopeLabel = 'whole map';
      if (nodeId) {
        const root = nodeById.get(nodeId);
        if (!root) return toolError(`Node ${nodeId} not found in map ${mapId}.`);
        scopeLabel = `subtree of "${root.text}" (${nodeId})`;
        const subtreeLeaves: typeof data.nodes = [];
        const stack = [root];
        while (stack.length) {
          const n = stack.pop()!;
          if ((n.childrenIds?.length ?? 0) === 0) {
            subtreeLeaves.push(n);
          } else {
            for (const cid of n.childrenIds) {
              const c = nodeById.get(cid);
              if (c) stack.push(c);
            }
          }
        }
        leaves = subtreeLeaves;
      } else {
        leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
      }
      if (versionId) {
        scopeLabel = `version ${versionId}` + (nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).versions.has(versionId));
      }
      if (milestoneId) {
        scopeLabel = `milestone ${milestoneId}` + (versionId || nodeId ? ` within ${scopeLabel}` : '');
        leaves = leaves.filter((n) => ancestorTags(n.id).milestones.has(milestoneId));
      }

      if (leaves.length === 0) {
        return toolResult(`No leaf nodes in scope (${scopeLabel}).`);
      }

      // Which status ids mean "in progress"?
      const inProgressStatusIds = new Set(
        (data.map.statusWorkflow ?? [])
          .filter((s) => s.category === 'in_progress')
          .map((s) => s.id),
      );
      const isInProgress = (n: typeof leaves[number]) =>
        n.status != null && inProgressStatusIds.has(n.status);

      const staleCutoff = Date.now() - stalledDays * 86_400_000;

      // ── Risk buckets ──
      const stalled: typeof leaves = [];
      const noEstimate: typeof leaves = [];
      const overruns: Array<{ node: typeof leaves[number]; ratio: number }> = [];
      const unassignedHighPrio: typeof leaves = [];

      for (const leaf of leaves) {
        if ((leaf.percentComplete ?? 0) >= 100) continue; // only risks on incomplete work

        if (isInProgress(leaf) && new Date(leaf.updatedAt).getTime() < staleCutoff) {
          stalled.push(leaf);
        }
        if (leaf.effortEstimate == null) {
          noEstimate.push(leaf);
        }
        if (
          leaf.effortEstimate != null &&
          leaf.effortEstimate > 0 &&
          leaf.actualEffort != null &&
          leaf.actualEffort > leaf.effortEstimate * 1.2
        ) {
          overruns.push({ node: leaf, ratio: leaf.actualEffort / leaf.effortEstimate });
        }
        if (
          (leaf.priority === 'P0' || leaf.priority === 'P1') &&
          (leaf.assigneeIds?.length ?? 0) === 0
        ) {
          unassignedHighPrio.push(leaf);
        }
      }

      // ── Fragile critical path: CP leaves that also appear in any risk bucket ──
      let cpIds = new Set<string>();
      try {
        const sched = await api.getSchedule(mapId);
        cpIds = new Set(sched.criticalPath?.path ?? []);
      } catch {
        /* best-effort — no CP if scheduler fails */
      }
      const cpScopedLeaves = leaves.filter((l) => cpIds.has(l.id));
      const riskIds = new Set<string>([
        ...stalled.map((n) => n.id),
        ...noEstimate.map((n) => n.id),
        ...overruns.map((o) => o.node.id),
        ...unassignedHighPrio.map((n) => n.id),
      ]);
      const fragileCP = cpScopedLeaves.filter(
        (l) => riskIds.has(l.id) || l.healthSignal === 'behind' || l.healthSignal === 'at_risk',
      );

      // ── Format ──
      const unit = data.map.effortUnit ?? 'units';
      const fmtNode = (n: typeof leaves[number]) => {
        const bits: string[] = [`${n.id} ${n.text}`];
        if (n.priority) bits.push(`[${n.priority}]`);
        if (n.status) {
          const s = data.map.statusWorkflow?.find((s) => s.id === n.status);
          bits.push(`(${s?.name ?? n.status})`);
        }
        return bits.join(' ');
      };

      const totalRisks =
        stalled.length + noEstimate.length + overruns.length + unassignedHighPrio.length + fragileCP.length;

      const lines: string[] = [];
      lines.push(`Risk scan — ${scopeLabel}`);
      lines.push(`Incomplete leaves: ${leaves.filter((l) => (l.percentComplete ?? 0) < 100).length} / ${leaves.length}`);
      lines.push(`Total risk flags:  ${totalRisks}`);
      lines.push('');

      lines.push(`## Stalled WIP (in-progress, no update in ${stalledDays}+ days): ${stalled.length}`);
      if (stalled.length === 0) {
        lines.push('  ✓ None');
      } else {
        for (const n of stalled.slice(0, 20)) {
          const daysSince = Math.floor((Date.now() - new Date(n.updatedAt).getTime()) / 86_400_000);
          lines.push(`  - ${fmtNode(n)} — ${daysSince}d since update`);
        }
        if (stalled.length > 20) lines.push(`  … and ${stalled.length - 20} more`);
      }
      lines.push('');

      lines.push(`## No-estimate leaves: ${noEstimate.length}`);
      if (noEstimate.length === 0) {
        lines.push('  ✓ None');
      } else {
        for (const n of noEstimate.slice(0, 20)) {
          lines.push(`  - ${fmtNode(n)}`);
        }
        if (noEstimate.length > 20) lines.push(`  … and ${noEstimate.length - 20} more`);
      }
      lines.push('');

      lines.push(`## Overruns (actual > 1.2× estimate, still incomplete): ${overruns.length}`);
      if (overruns.length === 0) {
        lines.push('  ✓ None');
      } else {
        const sorted = [...overruns].sort((a, b) => b.ratio - a.ratio);
        for (const { node, ratio } of sorted.slice(0, 20)) {
          lines.push(
            `  - ${fmtNode(node)} — est ${node.effortEstimate} ${unit}, actual ${node.actualEffort} ${unit} (${ratio.toFixed(2)}x)`,
          );
        }
        if (sorted.length > 20) lines.push(`  … and ${sorted.length - 20} more`);
      }
      lines.push('');

      lines.push(`## Unassigned P0/P1 leaves: ${unassignedHighPrio.length}`);
      if (unassignedHighPrio.length === 0) {
        lines.push('  ✓ None');
      } else {
        for (const n of unassignedHighPrio.slice(0, 20)) {
          lines.push(`  - ${fmtNode(n)}`);
        }
        if (unassignedHighPrio.length > 20) lines.push(`  … and ${unassignedHighPrio.length - 20} more`);
      }
      lines.push('');

      lines.push(`## Fragile critical path (CP leaves with risks or poor health): ${fragileCP.length}`);
      if (fragileCP.length === 0) {
        lines.push(
          cpIds.size === 0
            ? '  (scheduler returned no critical path)'
            : '  ✓ None',
        );
      } else {
        for (const n of fragileCP.slice(0, 20)) {
          lines.push(`  - ${fmtNode(n)} — health ${n.healthSignal}`);
        }
        if (fragileCP.length > 20) lines.push(`  … and ${fragileCP.length - 20} more`);
      }

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'alert_digest',
  'Generate a markdown alert digest for push delivery (email/slack/webhook). Reports threshold-triggered alerts only: milestones past target, scoped finish dates slipping past target, P0 nodes that are behind, and unassigned P0/P1 leaves. Returns nothing if no alerts. Pipe the output to your delivery channel of choice — MindBlown does not send the message itself.',
  {
    mapId: z.string().describe('The map ID'),
  },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      const leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
      const today = new Date().toISOString().slice(0, 10);

      // Slipped milestones: targetDate < today AND any contributing leaf incomplete
      const milestones = await api.listMilestones(data.map.workspaceId).catch(() => []);
      const slippedMilestones: Array<{ name: string; targetDate: string; incomplete: number }> = [];
      for (const m of milestones) {
        if (!m.targetDate) continue;
        if (m.targetDate.slice(0, 10) >= today) continue;
        const contributing = leaves.filter((l) => l.milestoneId === m.id && (l.percentComplete ?? 0) < 100);
        if (contributing.length > 0) {
          slippedMilestones.push({
            name: m.name,
            targetDate: m.targetDate.slice(0, 10),
            incomplete: contributing.length,
          });
        }
      }

      // Slipped versions: same logic
      const versions = await api.listVersions(data.map.workspaceId).catch(() => []);
      const slippedVersions: Array<{ name: string; targetDate: string; incomplete: number }> = [];
      for (const v of versions) {
        if (!v.targetDate) continue;
        if (v.targetDate.slice(0, 10) >= today) continue;
        const contributing = leaves.filter((l) => l.versionId === v.id && (l.percentComplete ?? 0) < 100);
        if (contributing.length > 0) {
          slippedVersions.push({
            name: v.name,
            targetDate: v.targetDate.slice(0, 10),
            incomplete: contributing.length,
          });
        }
      }

      // P0 nodes that are behind
      const p0Behind = leaves.filter(
        (n) => n.priority === 'P0' && n.healthSignal === 'behind' && (n.percentComplete ?? 0) < 100,
      );

      // Unassigned P0/P1
      const unassignedHigh = leaves.filter(
        (n) =>
          (n.priority === 'P0' || n.priority === 'P1') &&
          (n.assigneeIds?.length ?? 0) === 0 &&
          (n.percentComplete ?? 0) < 100,
      );

      // Overdue leaves (dueDate passed, not complete)
      const overdue = leaves.filter(
        (n) => n.dueDate != null && n.dueDate < today && (n.percentComplete ?? 0) < 100,
      );

      const totalAlerts =
        slippedMilestones.length +
        slippedVersions.length +
        p0Behind.length +
        unassignedHigh.length +
        overdue.length;

      if (totalAlerts === 0) {
        return toolResult(`No alerts for "${data.map.name}" — all clear.`);
      }

      const lines: string[] = [];
      lines.push(`# 🚨 ${data.map.name} — ${totalAlerts} alert(s)`);
      lines.push('');

      if (slippedMilestones.length > 0) {
        lines.push(`## Milestones past target (${slippedMilestones.length})`);
        for (const m of slippedMilestones) {
          lines.push(`- **${m.name}** — was due ${m.targetDate}, ${m.incomplete} incomplete leaf(s)`);
        }
        lines.push('');
      }
      if (slippedVersions.length > 0) {
        lines.push(`## Versions past target (${slippedVersions.length})`);
        for (const v of slippedVersions) {
          lines.push(`- **${v.name}** — was due ${v.targetDate}, ${v.incomplete} incomplete leaf(s)`);
        }
        lines.push('');
      }
      if (p0Behind.length > 0) {
        lines.push(`## P0 behind (${p0Behind.length})`);
        for (const n of p0Behind.slice(0, 20)) {
          lines.push(`- 🔴 **${n.text}**${n.dueDate ? ` (due ${n.dueDate})` : ''}`);
        }
        lines.push('');
      }
      if (overdue.length > 0) {
        lines.push(`## Overdue (${overdue.length})`);
        for (const n of overdue.slice(0, 20)) {
          lines.push(`- **${n.text}** — due ${n.dueDate}, ${n.percentComplete ?? 0}% done`);
        }
        if (overdue.length > 20) lines.push(`- _… and ${overdue.length - 20} more_`);
        lines.push('');
      }
      if (unassignedHigh.length > 0) {
        lines.push(`## Unassigned high-priority (${unassignedHigh.length})`);
        for (const n of unassignedHigh.slice(0, 20)) {
          lines.push(`- [${n.priority}] **${n.text}**`);
        }
        if (unassignedHigh.length > 20) lines.push(`- _… and ${unassignedHigh.length - 20} more_`);
      }

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'scope_simulate',
  'What-if simulation: apply a list of patches (remove/add/update nodes) to the map in-memory and return before/after totals + planned finish dates. Use to evaluate "what if we cut this feature?" or "what if we add 5 more days?". No persistence.',
  {
    mapId: z.string().describe('The map ID'),
    patches: z
      .array(
        z.union([
          z.object({
            action: z.literal('remove'),
            nodeId: z.string(),
          }),
          z.object({
            action: z.literal('add'),
            parentId: z.string(),
            text: z.string(),
            effortEstimate: z.number(),
            dueDate: z.string().nullable().optional(),
          }),
          z.object({
            action: z.literal('update'),
            nodeId: z.string(),
            effortEstimate: z.number().nullable().optional(),
            startDate: z.string().nullable().optional(),
            dueDate: z.string().nullable().optional(),
            percentComplete: z.number().nullable().optional(),
          }),
        ]),
      )
      .min(1)
      .describe('List of patches to apply in-memory'),
  },
  async ({ mapId, patches }) => {
    try {
      const { before, after } = await api.simulateMap(mapId, patches);
      const data = await api.getMap(mapId);
      const unit = data.map.effortUnit ?? 'units';

      const fmtDelta = (b: number, a: number) => {
        const d = a - b;
        const sign = d > 0 ? '+' : d < 0 ? '' : '±';
        return `${sign}${d.toFixed(2)}`;
      };
      const fmtDateDelta = (b: string | null, a: string | null) => {
        if (!b || !a) return 'n/a';
        const ms = new Date(a).getTime() - new Date(b).getTime();
        const days = Math.round(ms / 86_400_000);
        if (days === 0) return 'no change';
        return `${days > 0 ? '+' : ''}${days} days`;
      };

      const lines: string[] = [];
      lines.push(`Scope simulation — ${patches.length} patch(es)`);
      lines.push('');
      for (const p of patches) {
        if (p.action === 'remove') lines.push(`  - remove ${p.nodeId}`);
        else if (p.action === 'add') lines.push(`  + add "${p.text}" (${p.effortEstimate} ${unit}) under ${p.parentId}`);
        else lines.push(`  ~ update ${p.nodeId}: ${JSON.stringify({ effortEstimate: p.effortEstimate, percentComplete: p.percentComplete, startDate: p.startDate, dueDate: p.dueDate })}`);
      }
      lines.push('');
      lines.push('                    | before     after      Δ');
      lines.push('--------------------|-----------|----------|--------');
      lines.push(`Leaves              | ${String(before.leafCount).padStart(9)} ${String(after.leafCount).padStart(9)}  ${fmtDelta(before.leafCount, after.leafCount)}`);
      lines.push(`Total scope (${unit})    | ${before.totalScope.toFixed(2).padStart(9)} ${after.totalScope.toFixed(2).padStart(9)}  ${fmtDelta(before.totalScope, after.totalScope)} ${unit}`);
      lines.push(`Remaining (${unit})       | ${before.totalRemaining.toFixed(2).padStart(9)} ${after.totalRemaining.toFixed(2).padStart(9)}  ${fmtDelta(before.totalRemaining, after.totalRemaining)} ${unit}`);
      lines.push(`Done (${unit})            | ${before.totalDone.toFixed(2).padStart(9)} ${after.totalDone.toFixed(2).padStart(9)}  ${fmtDelta(before.totalDone, after.totalDone)} ${unit}`);
      lines.push(`Progress (%)        | ${before.weightedProgress.toFixed(1).padStart(9)} ${after.weightedProgress.toFixed(1).padStart(9)}  ${fmtDelta(before.weightedProgress, after.weightedProgress)} pts`);
      lines.push(`No-estimate leaves  | ${String(before.noEstimateCount).padStart(9)} ${String(after.noEstimateCount).padStart(9)}  ${fmtDelta(before.noEstimateCount, after.noEstimateCount)}`);
      lines.push('');
      lines.push(`Planned finish:`);
      lines.push(`  before:  ${before.plannedFinishDate ?? '(none)'}`);
      lines.push(`  after:   ${after.plannedFinishDate ?? '(none)'}`);
      lines.push(`  shift:   ${fmtDateDelta(before.plannedFinishDate, after.plannedFinishDate)}`);

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'status_digest',
  'Generate a markdown status digest for a map: what was done, what is in progress, what is behind/at-risk, what changed recently, and scope flow over the window. Combines current map state with the change_events log. Useful for standups, weekly reviews, or feeding into a narrative AI summary.',
  {
    mapId: z.string().describe('The map ID'),
    sinceDays: z.number().int().min(1).max(90).default(7).describe('Look-back window in days'),
  },
  async ({ mapId, sinceDays }) => {
    try {
      const data = await api.getMap(mapId);
      const leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
      const inProgressIds = new Set(
        (data.map.statusWorkflow ?? [])
          .filter((s) => s.category === 'in_progress')
          .map((s) => s.id),
      );

      // Current state buckets
      const inProgress = leaves.filter(
        (n) => n.status != null && inProgressIds.has(n.status) && (n.percentComplete ?? 0) < 100,
      );
      const behind = leaves.filter(
        (n) => n.healthSignal === 'behind' && (n.percentComplete ?? 0) < 100,
      );
      const atRisk = leaves.filter(
        (n) => n.healthSignal === 'at_risk' && (n.percentComplete ?? 0) < 100,
      );

      // Change-log driven sections
      const { events } = await api.getChangeHistory(mapId, { sinceDays, limit: 1000 });

      // Just-completed: percentComplete crossed to 100 in window
      const completedNodeIds = new Set<string>();
      for (const e of events) {
        if (
          e.eventType === 'node.field_changed' &&
          e.fieldName === 'percentComplete' &&
          Number(e.newValue ?? 0) >= 100 &&
          e.nodeId
        ) {
          completedNodeIds.add(e.nodeId);
        }
      }
      const justCompleted = leaves.filter((n) => completedNodeIds.has(n.id));

      // Recently changed nodes (any field_changed in window, excluding completion which we show separately)
      const changedNodeIds = new Set<string>();
      for (const e of events) {
        if (e.eventType === 'node.field_changed' && e.nodeId && !completedNodeIds.has(e.nodeId)) {
          changedNodeIds.add(e.nodeId);
        }
      }
      const recentlyChanged = data.nodes.filter((n) => changedNodeIds.has(n.id)).slice(0, 15);

      // Scope flow (lightweight, like burnup totals only)
      let scopeAdded = 0;
      let scopeRemoved = 0;
      let completedEffort = 0;
      const estimateById = new Map<string, number>();
      for (const l of leaves) estimateById.set(l.id, l.effortEstimate ?? 0);
      for (const e of events) {
        if (e.eventType === 'node.created') {
          const nv = e.newValue as { effortEstimate?: number | null } | null;
          scopeAdded += nv?.effortEstimate ?? 0;
        } else if (e.eventType === 'node.deleted') {
          const ov = e.oldValue as { effortEstimate?: number | null; isLeaf?: boolean } | null;
          if (ov?.isLeaf) scopeRemoved += ov.effortEstimate ?? 0;
        } else if (e.eventType === 'node.field_changed' && e.fieldName === 'effortEstimate') {
          const delta = Number(e.newValue ?? 0) - Number(e.oldValue ?? 0);
          if (delta > 0) scopeAdded += delta;
          else scopeRemoved += -delta;
        } else if (e.eventType === 'node.field_changed' && e.fieldName === 'percentComplete') {
          const delta = Number(e.newValue ?? 0) - Number(e.oldValue ?? 0);
          const est = e.nodeId ? (estimateById.get(e.nodeId) ?? 0) : 0;
          if (est > 0) completedEffort += est * (delta / 100);
        }
      }

      const unit = data.map.effortUnit ?? 'units';
      const fmtNode = (n: typeof leaves[number]) => {
        const bits: string[] = [`**${n.text}**`];
        if (n.priority) bits.push(`[${n.priority}]`);
        if (n.dueDate) bits.push(`(due ${n.dueDate})`);
        return bits.join(' ');
      };

      const lines: string[] = [];
      lines.push(`# Status digest — ${data.map.name}`);
      lines.push(`*Window: last ${sinceDays} days*`);
      lines.push('');

      lines.push(`## Done in window (${justCompleted.length})`);
      if (justCompleted.length === 0) {
        lines.push('_Nothing completed in the window._');
      } else {
        for (const n of justCompleted) lines.push(`- ${fmtNode(n)}`);
      }
      lines.push('');

      lines.push(`## In progress now (${inProgress.length})`);
      if (inProgress.length === 0) {
        lines.push('_Nothing in progress._');
      } else {
        for (const n of inProgress.slice(0, 15)) {
          lines.push(`- ${fmtNode(n)} — ${n.percentComplete ?? 0}%`);
        }
        if (inProgress.length > 15) lines.push(`- _… and ${inProgress.length - 15} more_`);
      }
      lines.push('');

      lines.push(`## Behind (${behind.length}) / At risk (${atRisk.length})`);
      if (behind.length === 0 && atRisk.length === 0) {
        lines.push('_All work on track._');
      } else {
        for (const n of behind.slice(0, 10)) lines.push(`- 🔴 ${fmtNode(n)}`);
        for (const n of atRisk.slice(0, 10)) lines.push(`- 🟡 ${fmtNode(n)}`);
      }
      lines.push('');

      lines.push(`## Recently changed (${recentlyChanged.length})`);
      if (recentlyChanged.length === 0) {
        lines.push('_No field changes in the window._');
      } else {
        for (const n of recentlyChanged) lines.push(`- ${fmtNode(n)}`);
      }
      lines.push('');

      lines.push(`## Scope flow`);
      const netScope = scopeAdded - scopeRemoved;
      lines.push(`- Scope added: +${scopeAdded.toFixed(2)} ${unit}`);
      lines.push(`- Scope removed: -${scopeRemoved.toFixed(2)} ${unit}`);
      lines.push(`- Net change: ${netScope >= 0 ? '+' : ''}${netScope.toFixed(2)} ${unit}`);
      lines.push(`- Effort completed: ${completedEffort.toFixed(2)} ${unit}`);

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'burnup',
  'Burnup / scope-creep detector over a time window. Reports current scope and completed effort, plus the flow through the window: scope added, scope removed, effort completed — per day and in total. Flags when scope is growing faster than completion. Uses change_events, so only shows flow since the change-history feature was deployed.',
  {
    mapId: z.string().describe('The map ID'),
    sinceDays: z.number().int().min(1).max(365).default(14).describe('Look-back window in days'),
    showDaily: z.boolean().default(true).describe('Include the daily breakdown table'),
  },
  async ({ mapId, sinceDays, showDaily }) => {
    try {
      const data = await api.getMap(mapId);
      const leaves = data.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);

      // Current cumulative totals
      let currentScope = 0;
      let currentCompleted = 0;
      const estimateById = new Map<string, number>();
      for (const l of leaves) {
        const est = l.effortEstimate ?? 0;
        const prog = l.percentComplete ?? 0;
        currentScope += est;
        currentCompleted += est * (prog / 100);
        estimateById.set(l.id, est);
      }

      const { events: rawEvents } = await api.getChangeHistory(mapId, {
        sinceDays,
        limit: 1000,
      });
      // getChangeHistory returns desc — walk ascending for intuitive daily flow.
      const eventsAsc = [...rawEvents].reverse();

      type Bucket = { scopeAdded: number; scopeRemoved: number; completed: number; eventCount: number };
      const buckets = new Map<string, Bucket>();
      const bump = (day: string, key: keyof Bucket, val: number) => {
        let b = buckets.get(day);
        if (!b) {
          b = { scopeAdded: 0, scopeRemoved: 0, completed: 0, eventCount: 0 };
          buckets.set(day, b);
        }
        b[key] += val;
      };

      for (const e of eventsAsc) {
        const day = e.createdAt.slice(0, 10);
        bump(day, 'eventCount', 1);

        if (e.eventType === 'node.created') {
          const nv = e.newValue as { effortEstimate?: number | null } | null;
          const est = nv?.effortEstimate ?? 0;
          if (est > 0) bump(day, 'scopeAdded', est);
        } else if (e.eventType === 'node.deleted') {
          const ov = e.oldValue as {
            effortEstimate?: number | null;
            percentComplete?: number | null;
            isLeaf?: boolean;
          } | null;
          if (ov?.isLeaf && ov.effortEstimate != null) {
            bump(day, 'scopeRemoved', ov.effortEstimate);
          }
        } else if (e.eventType === 'node.field_changed') {
          if (e.fieldName === 'effortEstimate') {
            const oldEst = Number(e.oldValue ?? 0);
            const newEst = Number(e.newValue ?? 0);
            const delta = newEst - oldEst;
            if (delta > 0) bump(day, 'scopeAdded', delta);
            else if (delta < 0) bump(day, 'scopeRemoved', -delta);
          } else if (e.fieldName === 'percentComplete') {
            const oldProg = Number(e.oldValue ?? 0);
            const newProg = Number(e.newValue ?? 0);
            const deltaProg = newProg - oldProg;
            // Use current estimate as a proxy — for v1, cross-time estimate
            // drift is rare enough to ignore.
            const est = e.nodeId ? (estimateById.get(e.nodeId) ?? 0) : 0;
            if (est > 0) bump(day, 'completed', est * (deltaProg / 100));
          }
        }
      }

      let totalScopeAdded = 0;
      let totalScopeRemoved = 0;
      let totalCompleted = 0;
      for (const b of buckets.values()) {
        totalScopeAdded += b.scopeAdded;
        totalScopeRemoved += b.scopeRemoved;
        totalCompleted += b.completed;
      }
      const netScope = totalScopeAdded - totalScopeRemoved;

      const unit = data.map.effortUnit ?? 'units';
      const pct = currentScope > 0 ? (currentCompleted / currentScope) * 100 : 0;

      const lines: string[] = [];
      lines.push(`Burnup — ${sinceDays} day window`);
      lines.push('');
      lines.push(`Current scope:     ${currentScope.toFixed(2)} ${unit}`);
      lines.push(`Current completed: ${currentCompleted.toFixed(2)} ${unit} (${pct.toFixed(1)}%)`);
      lines.push('');
      lines.push(`## Flow through window`);
      lines.push(`Scope added:       +${totalScopeAdded.toFixed(2)} ${unit}`);
      lines.push(`Scope removed:     -${totalScopeRemoved.toFixed(2)} ${unit}`);
      lines.push(`Net scope change:  ${netScope >= 0 ? '+' : ''}${netScope.toFixed(2)} ${unit}`);
      lines.push(`Effort completed:  ${totalCompleted.toFixed(2)} ${unit}`);
      lines.push('');

      const addRate = totalScopeAdded / sinceDays;
      const completionRate = totalCompleted / sinceDays;
      lines.push(`Scope-add rate:    ${addRate.toFixed(2)} ${unit}/day`);
      lines.push(`Completion rate:   ${completionRate.toFixed(2)} ${unit}/day`);

      if (totalScopeAdded > 0 || totalCompleted > 0) {
        if (totalScopeAdded === 0 && totalCompleted > 0) {
          lines.push(`✓ All flow was completion — no new scope added`);
        } else if (totalScopeAdded > 0 && totalCompleted >= totalScopeAdded) {
          lines.push(`✓ Completion keeping pace with scope growth (${(totalCompleted / totalScopeAdded).toFixed(2)}x)`);
        } else if (totalScopeAdded > 0 && totalCompleted < totalScopeAdded) {
          lines.push(
            `⚠ Scope growing faster than completion (${(totalCompleted / totalScopeAdded).toFixed(2)}x) — possible scope creep`,
          );
        }
      }

      if (showDaily) {
        lines.push('');
        lines.push(`## Daily detail`);
        const sortedDays = [...buckets.keys()].sort();
        if (sortedDays.length === 0) {
          lines.push(`(no change events in the last ${sinceDays} days)`);
        } else {
          lines.push('day         |  +scope  -scope | completed | events');
          lines.push('------------|----------------:|----------:|-------:');
          for (const d of sortedDays) {
            const b = buckets.get(d)!;
            lines.push(
              `${d}  | ${('+' + b.scopeAdded.toFixed(2)).padStart(7)} ${('-' + b.scopeRemoved.toFixed(2)).padStart(7)} | ${b.completed.toFixed(2).padStart(9)} | ${String(b.eventCount).padStart(6)}`,
            );
          }
        }
      }

      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'change_history',
  'Read the append-only change log for a map. Returns recent node mutations: creations, deletions, moves, and field changes (estimate, progress, status, priority, dates, assignees, version/milestone/cycle). Filter by node, event type, field name, or a time window. Use this for "what changed since last review?" digests, audit trails, or to feed burnup trend lines. Requires change-events to have been recorded — only events since the feature shipped are present.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().optional().describe('Scope to a single node'),
    eventType: z
      .enum(['node.created', 'node.deleted', 'node.moved', 'node.field_changed'])
      .optional()
      .describe('Filter by event type'),
    fieldName: z
      .string()
      .optional()
      .describe('Filter by field name (only meaningful with eventType=node.field_changed)'),
    sinceDays: z.number().int().min(1).optional().describe('Only events from the last N days'),
    limit: z.number().int().min(1).max(1000).default(100).describe('Max events to return'),
  },
  async ({ mapId, nodeId, eventType, fieldName, sinceDays, limit }) => {
    try {
      const result = await api.getChangeHistory(mapId, {
        nodeId,
        eventType,
        fieldName,
        sinceDays,
        limit,
      });

      if (result.events.length === 0) {
        return toolResult(
          `No change events found${nodeId ? ` for node ${nodeId}` : ''}${sinceDays ? ` in the last ${sinceDays} days` : ''}.`,
        );
      }

      // Resolve node text from the current map for nicer output. Best-effort
      // — deleted nodes won't be in the current map, so fall back to the id.
      const data = await api.getMap(mapId).catch(() => null);
      const nodeTextById = new Map<string, string>();
      if (data) {
        for (const n of data.nodes) nodeTextById.set(n.id, n.text);
      }

      const fmtValue = (v: unknown): string => {
        if (v == null) return '∅';
        if (typeof v === 'string') return JSON.stringify(v);
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return JSON.stringify(v);
      };

      const lines: string[] = [];
      lines.push(`Change history — ${result.events.length} event(s)`);
      lines.push('');
      for (const e of result.events) {
        const when = e.createdAt.slice(0, 19).replace('T', ' ');
        const nodeLabel = e.nodeId
          ? `${nodeTextById.get(e.nodeId) ?? '(deleted)'} [${e.nodeId.slice(0, 8)}]`
          : '(no node)';
        if (e.eventType === 'node.field_changed') {
          lines.push(
            `${when}  ${e.fieldName}: ${fmtValue(e.oldValue)} → ${fmtValue(e.newValue)}  — ${nodeLabel}`,
          );
        } else if (e.eventType === 'node.created') {
          const newVal = e.newValue as { text?: string } | null;
          lines.push(`${when}  created: "${newVal?.text ?? ''}"  — ${nodeLabel}`);
        } else if (e.eventType === 'node.deleted') {
          const oldVal = e.oldValue as { text?: string } | null;
          lines.push(`${when}  deleted: "${oldVal?.text ?? ''}"  — ${e.nodeId?.slice(0, 8) ?? ''}`);
        } else if (e.eventType === 'node.moved') {
          const oldVal = e.oldValue as { parentId?: string } | null;
          const newVal = e.newValue as { parentId?: string } | null;
          lines.push(
            `${when}  moved: parent ${oldVal?.parentId?.slice(0, 8) ?? '∅'} → ${newVal?.parentId?.slice(0, 8) ?? '∅'}  — ${nodeLabel}`,
          );
        }
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'set_progress',
  'Set percent complete on a leaf node',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    percent: z.number().min(0).max(100).describe('Percent complete (0-100)'),
  },
  async ({ mapId, nodeId, percent }) => {
    try {
      const err = await assertLeafNode(mapId, nodeId, 'set progress');
      if (err) return toolResult(err);
      await api.updateNode(mapId, nodeId, { percentComplete: percent });
      return toolResult(`Set progress on ${nodeId} to ${percent}%.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'set_status',
  'Set status on a node. Returns a WIP limit warning if moving the node into an in_progress status pushes the map over its configured wipLimit (see update_map).',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    status: z.string().describe('Status value (must match map\'s status workflow)'),
  },
  async ({ mapId, nodeId, status }) => {
    try {
      const mapData = await api.getMap(mapId);
      const workflow = mapData.map.statusWorkflow ?? [];
      const match = workflow.find(
        (s) => s.id === status || s.name.toLowerCase() === status.toLowerCase(),
      );
      if (!match) {
        const valid = workflow.map((s) => `${s.id} (${s.name})`).join(', ');
        return toolError(
          `Invalid status "${status}". Valid statuses: ${valid || 'none defined'}`,
        );
      }
      await api.updateNode(mapId, nodeId, { status: match.id });

      // ── Soft WIP limit check ──
      // Only relevant when moving a leaf node into an in_progress status.
      const lines: string[] = [`Set status on ${nodeId} to "${match.name}" (${match.id}).`];
      const wipLimit = mapData.map.wipLimit ?? null;
      if (wipLimit != null && match.category === 'in_progress') {
        // Re-fetch to include the just-applied status change.
        const fresh = await api.getMap(mapId);
        const inProgressIds = new Set(
          (fresh.map.statusWorkflow ?? [])
            .filter((s) => s.category === 'in_progress')
            .map((s) => s.id),
        );
        const inProgressNodes = fresh.nodes.filter(
          (n) =>
            n.status != null &&
            inProgressIds.has(n.status) &&
            (n.childrenIds?.length ?? 0) === 0,
        );
        if (inProgressNodes.length > wipLimit) {
          lines.push('');
          lines.push(
            `⚠ WIP LIMIT WARNING: ${inProgressNodes.length} tasks are now in progress (limit: ${wipLimit}).`,
          );
          lines.push('Currently in progress:');
          for (const n of inProgressNodes.slice(0, 10)) {
            const marker = n.id === nodeId ? ' (just added)' : '';
            lines.push(`  - ${n.id} ${n.text}${marker}`);
          }
          if (inProgressNodes.length > 10) {
            lines.push(`  … and ${inProgressNodes.length - 10} more`);
          }
          lines.push('Consider finishing one before starting another.');
        }
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'get_wip_status',
  'Report how many leaf nodes are currently in an in_progress status, list them, and compare against the map\'s wipLimit (set via update_map).',
  {
    mapId: z.string().describe('The map ID'),
  },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      const wipLimit = data.map.wipLimit ?? null;
      const inProgressIds = new Set(
        (data.map.statusWorkflow ?? [])
          .filter((s) => s.category === 'in_progress')
          .map((s) => s.id),
      );
      const inProgressNodes = data.nodes.filter(
        (n) =>
          n.status != null &&
          inProgressIds.has(n.status) &&
          (n.childrenIds?.length ?? 0) === 0,
      );
      const lines: string[] = [];
      if (wipLimit == null) {
        lines.push(`WIP limit: not set (unlimited).`);
      } else {
        const over = inProgressNodes.length > wipLimit;
        lines.push(
          `WIP: ${inProgressNodes.length} / ${wipLimit}${over ? ' ⚠ OVER LIMIT' : ''}`,
        );
      }
      if (inProgressNodes.length === 0) {
        lines.push('No tasks currently in progress.');
      } else {
        lines.push('In progress:');
        for (const n of inProgressNodes) {
          lines.push(`  - ${n.id} ${n.text}`);
        }
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'set_priority',
  'Set priority on a node',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).describe('Priority level'),
  },
  async ({ mapId, nodeId, priority }) => {
    try {
      await api.updateNode(mapId, nodeId, { priority });
      return toolResult(`Set priority on ${nodeId} to ${priority}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'add_dependency',
  'Add a dependency between two nodes ("fromNode depends on toNode")',
  {
    mapId: z.string().describe('The map ID'),
    fromNodeId: z.string().describe('The dependent node (downstream)'),
    toNodeId: z.string().describe('The dependency target (upstream)'),
    type: z.enum(['FS', 'SS', 'FF', 'SF']).describe('Dependency type: FS=Finish-to-Start, SS=Start-to-Start, FF=Finish-to-Finish, SF=Start-to-Finish'),
  },
  async ({ mapId, fromNodeId, toNodeId, type }) => {
    try {
      // Self-reference check
      if (fromNodeId === toNodeId) {
        return toolError('A node cannot depend on itself.');
      }

      const mapData = await api.getMap(mapId);
      const node = mapData.nodes.find((n) => n.id === fromNodeId);
      if (!node) {
        return toolResult(`Error: Node ${fromNodeId} not found in map ${mapId}.`);
      }

      const targetNode = mapData.nodes.find((n) => n.id === toNodeId);
      if (!targetNode) {
        return toolResult(`Error: Target node ${toNodeId} not found in map ${mapId}.`);
      }

      const existingDeps = node.dependencies ?? [];
      const alreadyExists = existingDeps.some(
        (d) => d.targetNodeId === toNodeId && d.type === type,
      );
      if (alreadyExists) {
        return toolResult(`Dependency already exists: ${fromNodeId} -> ${toNodeId} (${type}).`);
      }

      // Circular dependency check: can toNodeId reach fromNodeId via existing deps?
      const visited = new Set<string>();
      const stack: string[] = [toNodeId];
      const nodeIndex = new Map(mapData.nodes.map((n) => [n.id, n]));
      let circular = false;
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === fromNodeId) {
          circular = true;
          break;
        }
        if (visited.has(current)) continue;
        visited.add(current);
        const currentNode = nodeIndex.get(current);
        if (currentNode) {
          for (const dep of currentNode.dependencies) {
            stack.push(dep.targetNodeId);
          }
        }
      }
      if (circular) {
        return toolError(
          `Adding dependency ${fromNodeId} -> ${toNodeId} would create a circular dependency.`,
        );
      }

      const newDeps = [...existingDeps, { targetNodeId: toNodeId, type, lag: 0 }];
      await api.updateNode(mapId, fromNodeId, { dependencies: newDeps });
      return toolResult(`Added dependency: ${fromNodeId} depends on ${toNodeId} (${type}).`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'remove_dependency',
  'Remove a dependency from a node',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node that has the dependency'),
    targetNodeId: z.string().describe('The dependency target to remove'),
  },
  async ({ mapId, nodeId, targetNodeId }) => {
    try {
      const mapData = await api.getMap(mapId);
      const node = mapData.nodes.find((n) => n.id === nodeId);
      if (!node) {
        return toolResult(`Error: Node ${nodeId} not found in map ${mapId}.`);
      }

      const existingDeps = node.dependencies ?? [];
      const newDeps = existingDeps.filter((d) => d.targetNodeId !== targetNodeId);

      if (newDeps.length === existingDeps.length) {
        return toolResult(`No dependency found from ${nodeId} to ${targetNodeId}.`);
      }

      await api.updateNode(mapId, nodeId, { dependencies: newDeps });
      return toolResult(`Removed dependency from ${nodeId} to ${targetNodeId}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Version tools ──────────────────────────────────────────────

server.tool(
  'list_versions',
  'List all versions for a workspace',
  {
    workspaceId: z.string().describe('The workspace ID'),
  },
  async ({ workspaceId }) => {
    try {
      const res = await api.listVersions(workspaceId);
      if (res.length === 0) return toolResult('No versions found.');
      const lines = res.map((v) =>
        `- ${v.name} (id: ${v.id}) [${v.status}]${v.targetDate ? ` target: ${v.targetDate}` : ''}`,
      );
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_version',
  'Create a new version/release',
  {
    workspaceId: z.string().describe('The workspace ID'),
    name: z.string().describe('Version name (e.g. "V1", "2.0")'),
    description: z.string().optional().describe('Version description'),
    targetDate: z.string().optional().describe('Target release date (ISO 8601)'),
  },
  async ({ workspaceId, name, description, targetDate }) => {
    try {
      const version = await api.createVersion(workspaceId, name, description, targetDate);
      return toolResult(`Created version "${name}" (id: ${version.id}).`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Milestone tools ────────────────────────────────────────────

server.tool(
  'list_milestones',
  'List all milestones for a workspace, optionally filtered by version',
  {
    workspaceId: z.string().describe('The workspace ID'),
    versionId: z.string().optional().describe('Filter by version ID'),
  },
  async ({ workspaceId, versionId }) => {
    try {
      const res = await api.listMilestones(workspaceId, versionId);
      if (res.length === 0) return toolResult('No milestones found.');
      const lines = res.map((m) =>
        `- ${m.name} (id: ${m.id}) [${m.status}]${m.versionId ? ` version: ${m.versionId}` : ''}${m.targetDate ? ` target: ${m.targetDate}` : ''}`,
      );
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_milestone',
  'Create a new milestone within a version',
  {
    workspaceId: z.string().describe('The workspace ID'),
    name: z.string().describe('Milestone name'),
    versionId: z.string().optional().describe('Version ID this milestone belongs to'),
    description: z.string().optional().describe('Milestone description'),
    targetDate: z.string().optional().describe('Target date (ISO 8601)'),
  },
  async ({ workspaceId, name, versionId, description, targetDate }) => {
    try {
      const milestone = await api.createMilestone(workspaceId, name, versionId, description, targetDate);
      return toolResult(`Created milestone "${name}" (id: ${milestone.id}).`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Sprint tools ────────────────────────────────────────────────

server.tool(
  'list_cycles',
  'List all sprints/cycles for a workspace',
  {
    workspaceId: z.string().describe('The workspace ID'),
  },
  async ({ workspaceId }) => {
    try {
      const cycles = await api.listCycles(workspaceId);
      if (cycles.length === 0) return toolResult('No sprints found.');
      const lines = cycles.map((c) =>
        `- ${c.name} (id: ${c.id}) [${c.status}] ${c.startDate} to ${c.endDate}${c.versionId ? ` version: ${c.versionId}` : ''}`,
      );
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_cycle',
  'Create a new sprint/cycle, optionally within a version',
  {
    workspaceId: z.string().describe('The workspace ID'),
    name: z.string().describe('Sprint name'),
    startDate: z.string().describe('Start date (ISO 8601)'),
    endDate: z.string().describe('End date (ISO 8601)'),
    versionId: z.string().optional().describe('Version ID this sprint belongs to'),
  },
  async ({ workspaceId, name, startDate, endDate, versionId }) => {
    try {
      const cycle = await api.createCycle(workspaceId, name, startDate, endDate, versionId);
      return toolResult(`Created sprint "${name}" (id: ${cycle.id}) from ${startDate} to ${endDate}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'assign_to_sprint',
  'Assign a node to a sprint',
  {
    cycleId: z.string().describe('The sprint/cycle ID'),
    nodeId: z.string().describe('The node ID to assign'),
  },
  async ({ cycleId, nodeId }) => {
    try {
      await api.assignNodeToCycle(cycleId, nodeId);
      return toolResult(`Assigned node ${nodeId} to sprint ${cycleId}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'unassign_from_sprint',
  'Remove a node from its sprint',
  {
    cycleId: z.string().describe('The sprint/cycle ID'),
    nodeId: z.string().describe('The node ID to unassign'),
  },
  async ({ cycleId, nodeId }) => {
    try {
      await api.unassignNodeFromCycle(cycleId, nodeId);
      return toolResult(`Unassigned node ${nodeId} from sprint ${cycleId}.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_assign_to_sprint',
  'Assign multiple nodes to a sprint in a single call',
  {
    cycleId: z.string().describe('The sprint/cycle ID'),
    nodeIds: z.array(z.string()).describe('Array of node IDs to assign'),
  },
  async ({ cycleId, nodeIds }) => {
    const results: string[] = [];
    for (const nodeId of nodeIds) {
      try {
        await api.assignNodeToCycle(cycleId, nodeId);
        results.push(`${nodeId}: OK`);
      } catch (err) {
        results.push(`${nodeId}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return toolResult(`Assigned ${results.filter(r => r.includes('OK')).length}/${nodeIds.length} nodes to sprint ${cycleId}.\n${results.join('\n')}`);
  },
);

server.tool(
  'assign_to_version',
  'Assign a node to a version, or unassign by passing an empty string',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to assign'),
    versionId: z.string().describe('The version ID to assign to (empty string to unassign)'),
  },
  async ({ mapId, nodeId, versionId }) => {
    try {
      const effectiveVersionId = versionId === '' ? null : versionId;
      await api.updateNode(mapId, nodeId, { versionId: effectiveVersionId });
      if (effectiveVersionId) {
        return toolResult(`Assigned node ${nodeId} to version ${effectiveVersionId}.`);
      } else {
        return toolResult(`Unassigned node ${nodeId} from its version.`);
      }
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_assign_to_version',
  'Assign multiple nodes to a version in a single call',
  {
    mapId: z.string().describe('The map ID'),
    versionId: z.string().describe('The version ID to assign to (empty string to unassign)'),
    nodeIds: z.array(z.string()).describe('Array of node IDs to assign'),
  },
  async ({ mapId, versionId, nodeIds }) => {
    const effectiveVersionId = versionId === '' ? null : versionId;
    const results: string[] = [];
    for (const nodeId of nodeIds) {
      try {
        await api.updateNode(mapId, nodeId, { versionId: effectiveVersionId });
        results.push(`${nodeId}: OK`);
      } catch (err) {
        results.push(`${nodeId}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const action = effectiveVersionId ? `assigned to version ${effectiveVersionId}` : 'unassigned from version';
    return toolResult(`${results.filter(r => r.includes('OK')).length}/${nodeIds.length} nodes ${action}.\n${results.join('\n')}`);
  },
);

server.tool(
  'rollover_sprint',
  'Move incomplete items from one sprint to another',
  {
    fromCycleId: z.string().describe('Source sprint ID'),
    toCycleId: z.string().describe('Target sprint ID'),
  },
  async ({ fromCycleId, toCycleId }) => {
    try {
      const result = await api.rolloverCycle(fromCycleId, toCycleId);
      return toolResult(`Rolled over incomplete items from sprint ${fromCycleId} to ${toCycleId}. Result: ${JSON.stringify(result)}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'update_cycle',
  'Update a sprint/cycle — change its name, dates, status, or version. Use this to activate or complete a sprint.',
  {
    cycleId: z.string().describe('The sprint/cycle ID'),
    name: z.string().optional().describe('New sprint name'),
    startDate: z.string().optional().describe('New start date (ISO 8601)'),
    endDate: z.string().optional().describe('New end date (ISO 8601)'),
    status: z.enum(['planned', 'active', 'completed']).optional().describe('Sprint status'),
    versionId: z.string().nullable().optional().describe('Version ID this sprint belongs to (null to unset)'),
  },
  async ({ cycleId, ...fields }) => {
    try {
      const cleanFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) cleanFields[k] = v;
      }
      if (Object.keys(cleanFields).length === 0) {
        return toolResult('No fields to update.');
      }
      const updated = await api.updateCycle(cycleId, cleanFields as Parameters<typeof api.updateCycle>[1]);
      const parts = Object.entries(cleanFields).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      return toolResult(`Updated sprint "${updated.name}" (id: ${updated.id}): ${parts.join(', ')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── GitHub integration tools ───────────────────────────────────

server.tool(
  'connect_github_repo',
  'Connect a GitHub repository to a workspace. Required before importing issues. Stores the owner, repo, and token for API access.',
  {
    workspaceId: z.string().describe('The workspace ID'),
    owner: z.string().describe('GitHub repo owner (e.g. "danielhaas")'),
    repo: z.string().describe('GitHub repo name (e.g. "mindblown")'),
    token: z.string().describe('GitHub personal access token with repo scope'),
    webhookSecret: z.string().optional().describe('Webhook secret for verifying GitHub webhook payloads'),
  },
  async ({ workspaceId, owner, repo, token, webhookSecret }) => {
    try {
      const result = await api.connectGitHubRepo(workspaceId, owner, repo, token, webhookSecret);
      return toolResult(`Connected GitHub repo ${owner}/${repo} to workspace ${workspaceId} (integration id: ${result.id}).`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'import_github_issues',
  'Import issues from the connected GitHub repo into a map. Creates a FUNCTIONAL mindmap structure (grouped by feature area, NOT by version). GitHub milestones are automatically converted to MindBlown versions and milestones. Do NOT use create_node for GitHub issues — those won\'t be linked. If no repo is connected yet, use connect_github_repo first.',
  {
    mapId: z.string().describe('The map ID to import into'),
    parentNodeId: z.string().optional().describe('Parent node ID to import under (defaults to root node)'),
    includeAll: z.boolean().optional().describe('Import all issues including closed ones (default: open only). Use true for full roadmap import.'),
    owner: z.string().optional().describe('GitHub repo owner — if provided with repo, will auto-connect the repo to the workspace before importing'),
    repo: z.string().optional().describe('GitHub repo name — if provided with owner, will auto-connect the repo to the workspace before importing'),
  },
  async ({ mapId, parentNodeId, includeAll, owner, repo }) => {
    try {
      // If owner/repo provided, auto-connect (or update) the GitHub integration
      if (owner && repo) {
        const mapsForConnect = await api.listMaps();
        const mapForConnect = mapsForConnect.find((m) => m.id === mapId);
        if (!mapForConnect) {
          return toolError(`Map ${mapId} not found.`);
        }
        const token = process.env.GITHUB_TOKEN ?? '';
        if (!token) {
          return toolError('owner/repo provided but GITHUB_TOKEN environment variable is not set. Either set GITHUB_TOKEN or use connect_github_repo to configure the integration first.');
        }
        await api.connectGitHubRepo(mapForConnect.workspaceId, owner, repo, token);
      }

      const maps = await api.listMaps();
      const map = maps.find((m) => m.id === mapId);
      const createdBy = 'mcp-agent';

      const result = await api.importGitHubIssues(mapId, createdBy, parentNodeId, includeAll);
      const lines = [
        `GitHub import into "${map?.name ?? mapId}": ${result.imported} created, ${result.linked} linked to existing nodes by title match, ${result.skipped} skipped (already linked).`,
      ];
      if (result.versions && Object.keys(result.versions).length > 0) {
        lines.push('\nVersions created:');
        for (const [name, versionId] of Object.entries(result.versions)) {
          lines.push(`  - "${name}" → version ${versionId}`);
        }
      }
      if (result.milestones && Object.keys(result.milestones).length > 0) {
        lines.push('\nMilestones created:');
        for (const [name, milestoneId] of Object.entries(result.milestones)) {
          lines.push(`  - "${name}" → milestone ${milestoneId}`);
        }
      }
      if (result.nodes.length > 0) {
        lines.push(`\n${result.nodes.length} nodes created (grouped by functional area).`);
      }
      lines.push('\nAll newly created and newly linked nodes will receive webhook updates.');
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'link_github_issue',
  'Link an existing MindBlown node to a GitHub issue. After linking, the node will auto-sync with GitHub via webhooks.',
  {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to link'),
    owner: z.string().describe('GitHub repo owner (e.g. "danielhaas")'),
    repo: z.string().describe('GitHub repo name (e.g. "mindblown")'),
    issueNumber: z.number().describe('GitHub issue number'),
  },
  async ({ mapId, nodeId, owner, repo, issueNumber }) => {
    try {
      // Check for duplicate: does this node already have this issue linked?
      const mapData = await api.getMap(mapId);
      const node = mapData.nodes.find((n) => n.id === nodeId);
      if (!node) {
        return toolError(`Node ${nodeId} not found in map ${mapId}.`);
      }
      const externalId = `${owner}/${repo}#${issueNumber}`;
      const existing = node.externalLinks?.find(
        (l) => l.provider === 'github' && l.externalId === externalId,
      );
      if (existing) {
        return toolError(`Node ${nodeId} is already linked to ${externalId}. No duplicate created.`);
      }

      await api.linkGitHubIssue(mapId, nodeId, owner, repo, issueNumber);
      return toolResult(`Linked node ${nodeId} to ${owner}/${repo}#${issueNumber}. The node will now sync with GitHub.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'github_sync_overview',
  'Three-way diff between a MindBlown map and its connected GitHub repo: which nodes are linked to issues (synced), which leaf nodes have no GitHub link yet (onlyInMindBlown), and which repo issues are not yet linked to any node in the map (onlyInGitHub). Use this to audit the sync state before bulk operations or to find gaps worth promoting/linking. Requires the map to have a GitHub repo connected.',
  {
    mapId: z.string().describe('The map ID'),
    includeClosed: z.boolean().optional().describe('Include closed GitHub issues in the overview. Default: open only.'),
    format: z.enum(['summary', 'full']).optional().describe('summary (default): return just the counts. full: return counts plus every item in each bucket.'),
  },
  async ({ mapId, includeClosed, format }) => {
    try {
      const overview = await api.getGitHubSyncOverview(mapId, includeClosed ?? false);
      const lines: string[] = [];
      lines.push(
        `GitHub sync status for ${overview.repo} (${overview.includeClosed ? 'open + closed' : 'open only'}):`,
      );
      lines.push(
        `  synced: ${overview.counts.synced}, only in MindBlown: ${overview.counts.onlyInMindBlown}, only in GitHub: ${overview.counts.onlyInGitHub}`,
      );
      if (format === 'full') {
        if (overview.synced.length > 0) {
          lines.push(`\nSynced (${overview.synced.length}):`);
          for (const s of overview.synced) {
            lines.push(`  - ${s.externalId} [${s.issueState}] → node ${s.nodeId} "${s.text}"`);
          }
        }
        if (overview.onlyInMindBlown.length > 0) {
          lines.push(`\nOnly in MindBlown — leaf nodes with no GitHub link (${overview.onlyInMindBlown.length}):`);
          for (const n of overview.onlyInMindBlown) {
            lines.push(`  - ${n.nodeId} "${n.text}"`);
          }
        }
        if (overview.onlyInGitHub.length > 0) {
          lines.push(`\nOnly in GitHub — issues not linked to any node (${overview.onlyInGitHub.length}):`);
          for (const i of overview.onlyInGitHub) {
            lines.push(`  - #${i.issueNumber} [${i.state}] ${i.title}`);
          }
        }
      } else {
        lines.push(
          '\nCall again with format="full" to see every item in each bucket.',
        );
      }
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_github_issue_from_node',
  'Promote an existing MindBlown node to a new GitHub issue. Creates a fresh GitHub issue using the node\'s text (title), description (body), tags and priority (labels), then attaches the resulting externalLink to the node so future edits sync bidirectionally. Use this when you brainstormed a node in the mindmap and want to publish it as a real GitHub issue. Requires the map to have a GitHub repo connected (via connect_github_repo or the settings UI). Refuses if the node is already linked to any GitHub issue — unlink first if you really want a second one.',
  {
    mapId: z.string().describe('The map ID the node belongs to'),
    nodeId: z.string().describe('The node ID to promote to a GitHub issue'),
  },
  async ({ mapId, nodeId }) => {
    try {
      // Guard against creating a duplicate issue for an already-linked node.
      const mapData = await api.getMap(mapId);
      const node = mapData.nodes.find((n) => n.id === nodeId);
      if (!node) {
        return toolError(`Node ${nodeId} not found in map ${mapId}.`);
      }
      const existing = node.externalLinks?.find((l) => l.provider === 'github');
      if (existing) {
        return toolError(
          `Node ${nodeId} is already linked to GitHub issue ${existing.externalId} (${existing.url}). Refusing to create a second issue for the same node. Unlink first if that's really what you want.`,
        );
      }

      const result = await api.createGitHubIssueFromNode(mapId, nodeId);
      const link = result.node.externalLinks.find((l) => l.provider === 'github');
      return toolResult(
        `Created GitHub issue #${result.issue.number} ("${result.issue.title}") and linked it to node ${nodeId}. URL: ${result.issue.html_url}${link ? ` — externalId: ${link.externalId}` : ''}. The node will now sync with GitHub on future edits.`,
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'bulk_link_github_issue',
  'Link multiple nodes to GitHub issues in a single call. Supports a default owner/repo to avoid repetition.',
  {
    mapId: z.string().describe('The map ID'),
    owner: z.string().optional().describe('Default GitHub repo owner (used when link omits owner)'),
    repo: z.string().optional().describe('Default GitHub repo name (used when link omits repo)'),
    links: z.array(z.object({
      nodeId: z.string().describe('The node ID to link'),
      owner: z.string().optional().describe('GitHub repo owner (overrides default)'),
      repo: z.string().optional().describe('GitHub repo name (overrides default)'),
      issueNumber: z.number().describe('GitHub issue number'),
    })).describe('Array of node-to-issue links'),
  },
  async ({ mapId, owner: defaultOwner, repo: defaultRepo, links }) => {
    const results: string[] = [];
    for (const link of links) {
      const owner = link.owner ?? defaultOwner;
      const repo = link.repo ?? defaultRepo;
      if (!owner || !repo) {
        results.push(`${link.nodeId} → #${link.issueNumber}: FAILED — owner and repo are required`);
        continue;
      }
      try {
        await api.linkGitHubIssue(mapId, link.nodeId, owner, repo, link.issueNumber);
        results.push(`${link.nodeId} → ${owner}/${repo}#${link.issueNumber}: OK`);
      } catch (err) {
        results.push(`${link.nodeId} → #${link.issueNumber}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return toolResult(`Linked ${results.filter(r => r.includes('OK')).length}/${links.length} issues.\n${results.join('\n')}`);
  },
);

// ── Utility tools ───────────────────────────────────────────────

server.tool(
  'search_nodes',
  'Search nodes by text across a map, with optional structured filters',
  {
    mapId: z.string().describe('The map ID'),
    query: z.string().describe('Search text (case-insensitive substring match)'),
    status: z.string().optional().describe('Filter by status (exact match)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority'),
    tag: z.string().optional().describe('Filter by tag (nodes must include this tag)'),
  },
  async ({ mapId, query, status, priority, tag }) => {
    try {
      const data = await api.getMap(mapId);
      const lowerQ = query.toLowerCase();
      let matches = data.nodes.filter(
        (n) =>
          n.text.toLowerCase().includes(lowerQ) ||
          (n.description?.toLowerCase().includes(lowerQ) ?? false),
      );

      // Apply structured filters
      if (status) {
        matches = matches.filter((n) => n.status === status);
      }
      if (priority) {
        matches = matches.filter((n) => n.priority === priority);
      }
      if (tag) {
        matches = matches.filter((n) => n.tags.includes(tag));
      }

      if (matches.length === 0) {
        const filters = [status && `status=${status}`, priority && `priority=${priority}`, tag && `tag=${tag}`].filter(Boolean);
        const filterStr = filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';
        return toolResult(`No nodes matching "${query}"${filterStr} found in map ${mapId}.`);
      }

      const lines = matches.map((n) => {
        const health = n.healthSignal === 'on_track' ? '[OK]' : n.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
        const progress = Math.round(n.computedProgress);
        const links = n.externalLinks?.length > 0 ? ' ' + n.externalLinks.map((l) => `[${l.externalId}]`).join(' ') : '';
        return `- "${n.text}" (id: ${n.id}) — ${progress}% ${health}${n.status ? ` [${n.status}]` : ''}${n.priority ? ` ${n.priority}` : ''}${links}`;
      });

      return toolResult(`Found ${matches.length} node(s) matching "${query}":\n${lines.join('\n')}`);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'get_schedule',
  'Get computed schedule and critical path for a map',
  {
    mapId: z.string().describe('The map ID'),
  },
  async ({ mapId }) => {
    try {
      const scheduleData = await api.getSchedule(mapId);
      const mapData = await api.getMap(mapId);
      return toolResult(formatScheduleReport(mapData, scheduleData));
    } catch (err) {
      return toolError(err);
    }
  },
);

// ════════════════════════════════════════════════════════════════
//  RESOURCES
// ════════════════════════════════════════════════════════════════

// Static resource: list all maps
server.resource(
  'maps-list',
  'mindblown://maps',
  { description: 'List of all maps with summary stats', mimeType: 'text/markdown' },
  async (uri) => {
    try {
      const maps = await api.listMaps();
      const lines = ['# MindBlown Maps\n'];
      if (maps.length === 0) {
        lines.push('No maps found.');
      } else {
        for (const m of maps) {
          const health = m.healthSignal === 'on_track' ? 'On Track' : m.healthSignal === 'at_risk' ? 'At Risk' : 'Behind';
          lines.push(`## ${m.name}`);
          lines.push(`- **ID:** ${m.id}`);
          lines.push(`- **Progress:** ${Math.round(m.computedProgress)}%`);
          lines.push(`- **Health:** ${health}`);
          lines.push(`- **Effort unit:** ${m.effortUnit ?? 'hours'}`);
          lines.push(`- **Updated:** ${m.updatedAt}`);
          lines.push('');
        }
      }
      return { contents: [{ uri: uri.href, text: lines.join('\n'), mimeType: 'text/markdown' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error loading maps: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

// Template resources using ResourceTemplate

server.resource(
  'map-tree',
  new ResourceTemplate('mindblown://maps/{mapId}', { list: undefined }),
  { description: 'Full map tree as formatted text with status, progress, effort', mimeType: 'text/markdown' },
  async (uri, variables) => {
    try {
      const mapId = variables.mapId as string;
      const data = await api.getMap(mapId);
      return { contents: [{ uri: uri.href, text: formatMapTree(data), mimeType: 'text/markdown' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

server.resource(
  'map-health',
  new ResourceTemplate('mindblown://maps/{mapId}/health', { list: undefined }),
  { description: 'Health report: at-risk and behind nodes with reasons', mimeType: 'text/markdown' },
  async (uri, variables) => {
    try {
      const mapId = variables.mapId as string;
      const data = await api.getMap(mapId);
      return { contents: [{ uri: uri.href, text: formatHealthReport(data), mimeType: 'text/markdown' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

server.resource(
  'map-schedule',
  new ResourceTemplate('mindblown://maps/{mapId}/schedule', { list: undefined }),
  { description: 'Schedule with critical path and projected dates', mimeType: 'text/markdown' },
  async (uri, variables) => {
    try {
      const mapId = variables.mapId as string;
      const mapData = await api.getMap(mapId);
      const scheduleData = await api.getSchedule(mapId);
      return { contents: [{ uri: uri.href, text: formatScheduleReport(mapData, scheduleData), mimeType: 'text/markdown' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

server.resource(
  'map-sprints',
  new ResourceTemplate('mindblown://maps/{mapId}/sprints', { list: undefined }),
  { description: 'Sprint overview with progress per sprint', mimeType: 'text/markdown' },
  async (uri, variables) => {
    try {
      const mapId = variables.mapId as string;
      const mapData = await api.getMap(mapId);
      return { contents: [{ uri: uri.href, text: await formatSprintOverview(mapData), mimeType: 'text/markdown' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

server.resource(
  'node-detail',
  new ResourceTemplate('mindblown://nodes/{nodeId}', { list: undefined }),
  { description: 'Single node with all properties and computed fields', mimeType: 'text/markdown' },
  async (uri, variables) => {
    try {
      const nodeId = variables.nodeId as string;
      const maps = await api.listMaps();
      for (const m of maps) {
        const data = await api.getMap(m.id);
        const node = data.nodes.find((n) => n.id === nodeId);
        if (node) {
          return { contents: [{ uri: uri.href, text: formatNodeDetail(node, data), mimeType: 'text/markdown' }] };
        }
      }
      return { contents: [{ uri: uri.href, text: `Node ${nodeId} not found.`, mimeType: 'text/plain' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] };
    }
  },
);

// ════════════════════════════════════════════════════════════════
//  PROMPTS
// ════════════════════════════════════════════════════════════════

server.prompt(
  'project_status',
  'Summarize the current status of this project',
  { mapId: z.string().describe('The map ID to summarize') },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      const tree = formatMapTree(data);
      const health = formatHealthReport(data);

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please summarize the current status of this project.\n\n## Project Tree\n\n${tree}\n\n## Health Report\n\n${health}\n\nProvide a concise executive summary covering:\n1. Overall progress and health\n2. Key areas that are on track\n3. Areas of concern (at-risk or behind)\n4. Recommended next actions`,
          },
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `Error loading project data: ${msg}` },
        }],
      };
    }
  },
);

server.prompt(
  'sprint_review',
  'Review the current sprint progress',
  { cycleId: z.string().describe('The sprint/cycle ID to review') },
  async ({ cycleId }) => {
    try {
      const cycleData = await api.getCycle(cycleId);
      const { cycle, nodes, progress, totalNodes, completedNodes } = cycleData;

      const completed = nodes.filter((n) => n.percentComplete === 100);
      const inProgress = nodes.filter((n) => (n.percentComplete ?? 0) > 0 && (n.percentComplete ?? 0) < 100);
      const notStarted = nodes.filter((n) => !n.percentComplete || n.percentComplete === 0);
      const blocked = nodes.filter((n) => n.healthSignal === 'behind');

      let text = `Please review this sprint.\n\n`;
      text += `## Sprint: ${cycle.name}\n`;
      text += `- **Period:** ${cycle.startDate} to ${cycle.endDate}\n`;
      text += `- **Status:** ${cycle.status}\n`;
      text += `- **Progress:** ${Math.round(progress * 100)}%\n`;
      text += `- **Nodes:** ${completedNodes}/${totalNodes} completed\n\n`;

      text += `## Completed (${completed.length})\n`;
      for (const n of completed) {
        text += `- ${n.text} (${n.computedEffort} effort)\n`;
      }

      text += `\n## In Progress (${inProgress.length})\n`;
      for (const n of inProgress) {
        text += `- ${n.text} — ${n.percentComplete}% (${n.computedEffort} effort)\n`;
      }

      text += `\n## Not Started (${notStarted.length})\n`;
      for (const n of notStarted) {
        text += `- ${n.text} (${n.computedEffort} effort)\n`;
      }

      if (blocked.length > 0) {
        text += `\n## Blocked/Behind (${blocked.length})\n`;
        for (const n of blocked) {
          text += `- ${n.text} — ${n.healthSignal}\n`;
        }
      }

      text += `\nProvide a sprint review covering:\n1. Sprint velocity and completion rate\n2. What went well\n3. What's at risk of not completing\n4. Blockers to address\n5. Recommendations for the next sprint`;

      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Error loading sprint: ${msg}` } }],
      };
    }
  },
);

server.prompt(
  'estimate_tasks',
  'Suggest effort estimates for unestimated tasks',
  { mapId: z.string().describe('The map ID') },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      const leafNodes = data.nodes.filter((n) => n.childrenIds.length === 0);
      const unestimated = leafNodes.filter((n) => n.effortEstimate === null || n.effortEstimate === undefined);
      const estimated = leafNodes.filter((n) => n.effortEstimate !== null && n.effortEstimate !== undefined);

      let text = `Please suggest effort estimates for the unestimated tasks in this project.\n\n`;
      text += `**Project:** ${data.map.name}\n`;
      text += `**Effort unit:** ${data.map.effortUnit ?? 'hours'}\n\n`;

      if (estimated.length > 0) {
        text += `## Already Estimated (for reference)\n`;
        for (const n of estimated) {
          text += `- ${n.text}: ${n.effortEstimate} ${data.map.effortUnit ?? 'hours'}${n.status ? ` [${n.status}]` : ''}\n`;
        }
        text += '\n';
      }

      text += `## Unestimated Tasks (${unestimated.length})\n`;
      if (unestimated.length === 0) {
        text += 'All leaf tasks are estimated!\n';
      } else {
        for (const n of unestimated) {
          const parent = data.nodes.find((p) => p.id === n.parentId);
          text += `- **${n.text}** (id: ${n.id})`;
          if (parent) text += ` — under "${parent.text}"`;
          if (n.description) text += `\n  Description: ${n.description}`;
          text += '\n';
        }
      }

      text += `\nFor each unestimated task, suggest an effort estimate in ${data.map.effortUnit ?? 'hours'} with brief reasoning. Consider the complexity relative to already-estimated tasks.`;

      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Error: ${msg}` } }],
      };
    }
  },
);

server.prompt(
  'identify_risks',
  'Identify current project risks',
  { mapId: z.string().describe('The map ID') },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      const health = formatHealthReport(data);

      // Dependency bottlenecks
      const dependencyCount: Record<string, number> = {};
      for (const n of data.nodes) {
        for (const dep of n.dependencies ?? []) {
          dependencyCount[dep.targetNodeId] = (dependencyCount[dep.targetNodeId] ?? 0) + 1;
        }
      }

      const bottlenecks = Object.entries(dependencyCount)
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a);

      // Overdue
      const now = new Date().toISOString().split('T')[0];
      const overdue = data.nodes.filter(
        (n) => n.dueDate && n.dueDate < now && (n.percentComplete ?? 0) < 100,
      );

      let text = `Please identify and analyze the current risks in this project.\n\n`;
      text += `## Health Report\n\n${health}\n\n`;

      if (bottlenecks.length > 0) {
        text += `## Dependency Bottlenecks\n`;
        text += `These nodes block multiple other tasks:\n`;
        for (const [nodeId, count] of bottlenecks) {
          const node = data.nodes.find((n) => n.id === nodeId);
          text += `- **${node?.text ?? nodeId}** — blocks ${count} other task(s), ${Math.round(node?.computedProgress ?? 0)}% complete\n`;
        }
        text += '\n';
      }

      if (overdue.length > 0) {
        text += `## Overdue Items\n`;
        for (const n of overdue) {
          text += `- **${n.text}** — due ${n.dueDate}, ${Math.round(n.computedProgress ?? 0)}% complete\n`;
        }
        text += '\n';
      }

      text += `Analyze these risks and provide:\n1. Severity ranking of each risk\n2. Impact assessment\n3. Recommended mitigation actions\n4. Priority order for addressing them`;

      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Error: ${msg}` } }],
      };
    }
  },
);

server.prompt(
  'daily_standup',
  'Generate a daily standup update',
  { mapId: z.string().describe('The map ID') },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentlyUpdated = data.nodes.filter((n) => n.updatedAt > oneDayAgo);
      const inProgress = data.nodes.filter(
        (n) => (n.percentComplete ?? 0) > 0 && (n.percentComplete ?? 0) < 100,
      );
      const blocked = data.nodes.filter((n) => n.healthSignal === 'behind');

      let text = `Generate a daily standup update for this project.\n\n`;
      text += `**Project:** ${data.map.name}\n\n`;

      text += `## Recently Changed (last 24h)\n`;
      if (recentlyUpdated.length === 0) {
        text += 'No changes in the last 24 hours.\n';
      } else {
        for (const n of recentlyUpdated) {
          text += `- ${n.text} — ${Math.round(n.computedProgress)}%${n.status ? ` [${n.status}]` : ''}\n`;
        }
      }

      text += `\n## Currently In Progress\n`;
      if (inProgress.length === 0) {
        text += 'Nothing currently in progress.\n';
      } else {
        for (const n of inProgress) {
          text += `- ${n.text} — ${n.percentComplete}% complete${n.assigneeIds.length > 0 ? ` (assigned)` : ''}\n`;
        }
      }

      text += `\n## Blocked / Behind\n`;
      if (blocked.length === 0) {
        text += 'Nothing currently blocked.\n';
      } else {
        for (const n of blocked) {
          text += `- ${n.text} — ${n.healthSignal}${n.dueDate ? ` (due: ${n.dueDate})` : ''}\n`;
        }
      }

      text += `\nGenerate a concise standup update in this format:\n- **What was done:** (based on recent changes)\n- **What's in progress:** (current work)\n- **Blockers:** (what needs attention)`;

      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Error: ${msg}` } }],
      };
    }
  },
);

// ── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
