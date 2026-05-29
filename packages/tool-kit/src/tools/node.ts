import { z } from 'zod';
import { defineTool } from '../spec.js';

export const createNodeTool = defineTool({
  name: 'create_node',
  description: 'Create a new node (task/idea) in a map under a parent node',
  schema: {
    mapId: z.string().describe('The map ID'),
    parentId: z.string().describe('Parent node ID to create under'),
    text: z.string().describe('Node title/label'),
    effortEstimate: z.number().optional().describe('Effort estimate (leaf nodes only)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority level'),
    status: z.string().optional().describe("Status (must match map's status workflow)"),
    dueDate: z.string().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().optional().describe('Start date (ISO 8601)'),
    versionId: z.string().optional().describe('Version ID to assign this node to'),
  },
  handler: async (backend, { mapId, parentId, text, ...fields }) => {
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) cleanFields[k] = v;
    }
    const node = await backend.createNode(mapId, parentId, text, cleanFields);
    return `Created node "${text}" (id: ${node.id}) under parent ${parentId}`;
  },
});

export const updateNodeTool = defineTool({
  name: 'update_node',
  description: 'Update any field on a node',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to update'),
    text: z.string().optional().describe('New title/label'),
    description: z.string().optional().describe('Rich text description'),
    effortEstimate: z.number().nullable().optional().describe('Effort estimate'),
    percentComplete: z.number().nullable().optional().describe('Percent complete (0-100)'),
    status: z.string().nullable().optional().describe('Status'),
    blockedReason: z
      .string()
      .nullable()
      .optional()
      .describe('Why this node is blocked (e.g. "waiting on legal"). null/empty to clear.'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable().optional().describe('Priority'),
    dueDate: z.string().nullable().optional().describe('Due date (ISO 8601)'),
    startDate: z.string().nullable().optional().describe('Start date (ISO 8601)'),
    tags: z.array(z.string()).optional().describe('Tags'),
    assigneeIds: z.array(z.string()).optional().describe('Assignee user IDs'),
    versionId: z.string().nullable().optional().describe('Version ID (null to unassign)'),
  },
  handler: async (backend, { mapId, nodeId, ...fields }) => {
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) cleanFields[k] = v;
    }
    if (Object.keys(cleanFields).length === 0) return 'No fields to update.';
    await backend.updateNode(mapId, nodeId, cleanFields);
    return `Updated node ${nodeId}: ${Object.keys(cleanFields).join(', ')}`;
  },
});

export const deleteNodeTool = defineTool({
  name: 'delete_node',
  description: 'Delete a node and all its descendants',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to delete'),
  },
  handler: async (backend, { mapId, nodeId }) => {
    await backend.deleteNode(mapId, nodeId);
    return `Deleted node ${nodeId} and its descendants.`;
  },
});

export const moveNodeTool = defineTool({
  name: 'move_node',
  description: 'Move a node to a new parent',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodeId: z.string().describe('The node ID to move'),
    newParentId: z.string().describe('The new parent node ID'),
    index: z.number().optional().describe('Position among siblings (0-based)'),
  },
  handler: async (backend, { mapId, nodeId, newParentId, index }) => {
    await backend.moveNode(mapId, nodeId, newParentId, index);
    return `Moved node ${nodeId} under parent ${newParentId}${index !== undefined ? ` at position ${index}` : ''}.`;
  },
});

export const searchNodesTool = defineTool({
  name: 'search_nodes',
  description:
    'Search nodes by text across a map, with optional structured filters. Pass an empty string or "*" as query to match all nodes and filter by status/priority/tag only.',
  schema: {
    mapId: z.string().describe('The map ID'),
    query: z
      .string()
      .describe('Search text (case-insensitive substring match). Empty string or "*" matches all nodes.'),
    status: z.string().optional().describe('Filter by status (exact match)'),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority'),
    tag: z.string().optional().describe('Filter by tag (nodes must include this tag)'),
  },
  handler: async (backend, { mapId, query, status, priority, tag }) => {
    const data = await backend.getMap(mapId);
    const trimmedQ = query.trim();
    const matchAll = trimmedQ === '' || trimmedQ === '*';
    const lowerQ = trimmedQ.toLowerCase();
    let matches = matchAll
      ? data.nodes.slice()
      : data.nodes.filter(
          (n) =>
            n.text.toLowerCase().includes(lowerQ) ||
            (n.description?.toLowerCase().includes(lowerQ) ?? false),
        );
    if (status) matches = matches.filter((n) => n.status === status);
    if (priority) matches = matches.filter((n) => n.priority === priority);
    if (tag) matches = matches.filter((n) => n.tags.includes(tag));

    if (matches.length === 0) {
      const filters = [
        status && `status=${status}`,
        priority && `priority=${priority}`,
        tag && `tag=${tag}`,
      ].filter(Boolean);
      const filterStr = filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';
      const subject = matchAll ? 'nodes' : `nodes matching "${query}"`;
      return `No ${subject}${filterStr} found in map ${mapId}.`;
    }

    const lines = matches.map((n) => {
      const health =
        n.healthSignal === 'on_track' ? '[OK]' : n.healthSignal === 'at_risk' ? '[AT RISK]' : '[BEHIND]';
      const progress = Math.round(n.computedProgress);
      const links = n.externalLinks?.length > 0
        ? ' ' + n.externalLinks.map((l) => `[${l.externalId}]`).join(' ')
        : '';
      return `- "${n.text}" (id: ${n.id}) — ${progress}% ${health}${n.status ? ` [${n.status}]` : ''}${n.priority ? ` ${n.priority}` : ''}${links}`;
    });

    return `Found ${matches.length} node(s) matching "${query}":\n${lines.join('\n')}`;
  },
});

export const nodeTools = [createNodeTool, updateNodeTool, deleteNodeTool, moveNodeTool, searchNodesTool];
