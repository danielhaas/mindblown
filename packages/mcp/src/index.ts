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
import { formatMapTree, formatHealthReport, formatScheduleReport, formatSprintOverview, formatNodeDetail } from './formatters.js';

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
- **Versions** are release containers (e.g. "V1", "V2"). Multiple sprints and milestones belong to a version.
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
3. Tag nodes with a version and/or milestone using update_node (set versionId, milestoneId)
4. list_versions / list_milestones to review what's planned for each release

Example: A node "Data Retention Policy" lives under Compliance in the tree (functional), and is tagged with version "V1" and milestone "Kernsystem MVP" (release planning). These are independent dimensions.

**Sprint planning:**
1. create_cycle to define a time-boxed sprint, optionally within a version (set versionId)
2. assign_to_sprint to add tasks to the sprint
3. list_cycles to review sprints and their progress

**Finding problems:** Use the identify_risks or project_status prompts, or read the health resource to see at-risk/behind nodes.

**GitHub integration:** import_github_issues to pull issues from a connected GitHub repo. It creates a FUNCTIONAL mindmap (grouped by feature area, not by version). GitHub milestones are automatically converted to MindBlown versions and milestones. Use link_github_issue to link an existing node to a specific GitHub issue. NEVER use create_node for GitHub issues — those won't be linked and won't sync.

## Important: Mindmap = functional structure, Versions = release planning

The mindmap tree is organized by **functional area** (e.g. "Compliance", "Billing", "Workflows") — this is the WHAT.
Versions, milestones, and sprints are orthogonal metadata on nodes — this is the WHEN and WHY.

- **versionId** on a node = "this ships in V1"
- **milestoneId** on a node = "this contributes to the Kernsystem MVP milestone"
- **cycleId** on a node = "this is being worked on in Sprint 3"

A node can have all three set independently. Never reorganize the tree by version — use these fields instead.

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
  'Get a map\'s full tree structure with computed fields (effort, progress, health)',
  { mapId: z.string().describe('The map ID') },
  async ({ mapId }) => {
    try {
      const data = await api.getMap(mapId);
      return toolResult(formatMapTree(data));
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
  'Set status on a node',
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
      return toolResult(`Set status on ${nodeId} to "${match.name}" (${match.id}).`);
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

// ── GitHub integration tools ───────────────────────────────────

server.tool(
  'import_github_issues',
  'Import issues from the connected GitHub repo into a map. Creates a FUNCTIONAL mindmap structure (grouped by feature area, NOT by version). GitHub milestones are automatically converted to MindBlown versions and milestones. Do NOT use create_node for GitHub issues — those won\'t be linked.',
  {
    mapId: z.string().describe('The map ID to import into'),
    parentNodeId: z.string().optional().describe('Parent node ID to import under (defaults to root node)'),
    includeAll: z.boolean().optional().describe('Import all issues including closed ones (default: open only). Use true for full roadmap import.'),
  },
  async ({ mapId, parentNodeId, includeAll }) => {
    try {
      const maps = await api.listMaps();
      const map = maps.find((m) => m.id === mapId);
      const createdBy = 'mcp-agent';

      const result = await api.importGitHubIssues(mapId, createdBy, parentNodeId, includeAll);
      const lines = [`Imported ${result.imported} GitHub issues into "${map?.name ?? mapId}".`];
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
      lines.push('\nAll imported nodes are linked to GitHub and will receive webhook updates.');
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
      await api.linkGitHubIssue(mapId, nodeId, owner, repo, issueNumber);
      return toolResult(`Linked node ${nodeId} to ${owner}/${repo}#${issueNumber}. The node will now sync with GitHub.`);
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Utility tools ───────────────────────────────────────────────

server.tool(
  'search_nodes',
  'Search nodes by text across a map',
  {
    mapId: z.string().describe('The map ID'),
    query: z.string().describe('Search text (case-insensitive substring match)'),
  },
  async ({ mapId, query }) => {
    try {
      const data = await api.getMap(mapId);
      const lowerQ = query.toLowerCase();
      const matches = data.nodes.filter(
        (n) =>
          n.text.toLowerCase().includes(lowerQ) ||
          (n.description?.toLowerCase().includes(lowerQ) ?? false),
      );

      if (matches.length === 0) {
        return toolResult(`No nodes matching "${query}" found in map ${mapId}.`);
      }

      const lines = matches.map((n) => {
        const health = n.healthSignal === 'on_track' ? '[OK]' : n.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
        const progress = Math.round(n.computedProgress);
        return `- "${n.text}" (id: ${n.id}) — ${progress}% ${health}${n.status ? ` [${n.status}]` : ''}${n.priority ? ` ${n.priority}` : ''}`;
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
