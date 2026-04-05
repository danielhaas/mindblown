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

// ── Server setup ────────────────────────────────────────────────

const server = new McpServer({
  name: 'mindblown',
  version: '0.0.1',
});

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
        return `- ${m.name} (id: ${m.id}) — ${Math.round(m.computedProgress * 100)}% complete ${health}`;
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

server.tool(
  'bulk_update_nodes',
  'Update multiple nodes at once',
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
      await api.updateNode(mapId, nodeId, { status });
      return toolResult(`Set status on ${nodeId} to "${status}".`);
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
      const mapData = await api.getMap(mapId);
      const node = mapData.nodes.find((n) => n.id === fromNodeId);
      if (!node) {
        return toolResult(`Error: Node ${fromNodeId} not found in map ${mapId}.`);
      }

      const existingDeps = node.dependencies ?? [];
      const alreadyExists = existingDeps.some(
        (d) => d.targetNodeId === toNodeId && d.type === type,
      );
      if (alreadyExists) {
        return toolResult(`Dependency already exists: ${fromNodeId} -> ${toNodeId} (${type}).`);
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
        `- ${c.name} (id: ${c.id}) [${c.status}] ${c.startDate} to ${c.endDate}`,
      );
      return toolResult(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  'create_cycle',
  'Create a new sprint/cycle',
  {
    workspaceId: z.string().describe('The workspace ID'),
    name: z.string().describe('Sprint name'),
    startDate: z.string().describe('Start date (ISO 8601)'),
    endDate: z.string().describe('End date (ISO 8601)'),
  },
  async ({ workspaceId, name, startDate, endDate }) => {
    try {
      const cycle = await api.createCycle(workspaceId, name, startDate, endDate);
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
        const progress = Math.round(n.computedProgress * 100);
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
          lines.push(`- **Progress:** ${Math.round(m.computedProgress * 100)}%`);
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
          text += `- **${node?.text ?? nodeId}** — blocks ${count} other task(s), ${Math.round((node?.computedProgress ?? 0) * 100)}% complete\n`;
        }
        text += '\n';
      }

      if (overdue.length > 0) {
        text += `## Overdue Items\n`;
        for (const n of overdue) {
          text += `- **${n.text}** — due ${n.dueDate}, ${Math.round((n.computedProgress ?? 0) * 100)}% complete\n`;
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
          text += `- ${n.text} — ${Math.round(n.computedProgress * 100)}%${n.status ? ` [${n.status}]` : ''}\n`;
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
