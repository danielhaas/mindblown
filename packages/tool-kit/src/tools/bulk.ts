import { z } from 'zod';
import { defineTool } from '../spec.js';

const VALID_NODE_FIELDS = new Set([
  'text',
  'description',
  'effortEstimate',
  'percentComplete',
  'status',
  'blockedReason',
  'priority',
  'dueDate',
  'startDate',
  'tags',
  'assigneeIds',
  'priorityRank',
]);

/**
 * Accept either the explicit {nodeId, fields: {...}} shape or the flat
 * {nodeId, ...fields} shape — `bulk_set_*` siblings use the flat form, so
 * this keeps `bulk_update_nodes` consistent with them without breaking
 * callers that already use the explicit shape. See GitHub issue #41.
 */
function normalizeBulkUpdateItem(
  raw: unknown,
): { nodeId: string; fields: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'update must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const nodeId = obj.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    return { error: 'missing string nodeId' };
  }
  // Explicit shape
  if (obj.fields && typeof obj.fields === 'object' && Object.keys(obj).length <= 2) {
    return { nodeId, fields: obj.fields as Record<string, unknown> };
  }
  // Flat shape — pull out nodeId, treat the rest as fields
  const { nodeId: _omit, ...flat } = obj;
  return { nodeId, fields: flat };
}

export const bulkUpdateNodesTool = defineTool({
  name: 'bulk_update_nodes',
  description:
    'Update multiple nodes at once. Each update is {nodeId, ...fields} OR {nodeId, fields: {...}} — both shapes are accepted. Valid fields: text, description, effortEstimate, percentComplete, status, blockedReason, priority, dueDate, startDate, tags, assigneeIds.',
  schema: {
    mapId: z.string().describe('The map ID'),
    updates: z
      .array(z.record(z.unknown()))
      .describe(
        'Array of updates. Each item is either {nodeId, ...fields} (flat) or {nodeId, fields: {...}} (nested).',
      ),
  },
  handler: async (backend, { mapId, updates }) => {
    const results: string[] = [];
    for (const raw of updates) {
      const norm = normalizeBulkUpdateItem(raw);
      if ('error' in norm) {
        results.push(`  <malformed>: FAILED — ${norm.error}`);
        continue;
      }
      const { nodeId, fields } = norm;
      const unknownFields = Object.keys(fields).filter((k) => !VALID_NODE_FIELDS.has(k));
      if (unknownFields.length > 0) {
        results.push(`  ${nodeId}: FAILED — unknown field(s): ${unknownFields.join(', ')}`);
        continue;
      }
      if (Object.keys(fields).length === 0) {
        results.push(`  ${nodeId}: FAILED — no fields to update`);
        continue;
      }
      try {
        await backend.updateNode(mapId, nodeId, fields);
        results.push(`  ${nodeId}: updated ${Object.keys(fields).join(', ')}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`  ${nodeId}: FAILED — ${msg}`);
      }
    }
    return `Bulk update results:\n${results.join('\n')}`;
  },
});

export const bulkCreateNodesTool = defineTool({
  name: 'bulk_create_nodes',
  description:
    'Create multiple nodes in a single batch. Nodes are created sequentially so earlier nodes can be parents of later ones. Use tempId to reference a node created earlier in the same batch as a parentId.',
  schema: {
    mapId: z.string().describe('The map ID'),
    nodes: z
      .array(
        z.object({
          tempId: z
            .string()
            .optional()
            .describe('Temporary ID for this node, so later nodes in the batch can reference it as parentId'),
          parentId: z
            .string()
            .describe('Parent node ID (can be a real ID or a tempId from an earlier node in this batch)'),
          text: z.string().describe('Node title/label'),
          effortEstimate: z.number().optional().describe('Effort estimate (leaf nodes only)'),
          priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority level'),
          status: z.string().optional().describe("Status (must match map's status workflow)"),
          dueDate: z.string().optional().describe('Due date (ISO 8601)'),
          startDate: z.string().optional().describe('Start date (ISO 8601)'),
        }),
      )
      .describe('Array of node definitions to create, processed in order'),
  },
  handler: async (backend, { mapId, nodes }) => {
    const tempIdMap = new Map<string, string>();
    const results: string[] = [];
    let created = 0;

    for (let i = 0; i < nodes.length; i++) {
      const { tempId, parentId, text, ...fields } = nodes[i];
      try {
        const resolvedParentId = tempIdMap.get(parentId) ?? parentId;
        const cleanFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined) cleanFields[k] = v;
        }
        const node = await backend.createNode(mapId, resolvedParentId, text, cleanFields);
        created++;
        if (tempId) tempIdMap.set(tempId, node.id);
        results.push(`  ${tempId ?? `[${i}]`}: "${text}" created (id: ${node.id}) under ${resolvedParentId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`  ${tempId ?? `[${i}]`}: "${text}" FAILED — ${msg}`);
      }
    }
    return `Bulk create results (${created}/${nodes.length} created):\n${results.join('\n')}`;
  },
});

export const bulkSetEstimateTool = defineTool({
  name: 'bulk_set_estimate',
  description: 'Set effort estimates on multiple leaf nodes at once',
  schema: {
    mapId: z.string().describe('The map ID'),
    estimates: z
      .array(
        z.object({
          nodeId: z.string().describe('Node ID'),
          estimate: z.number().min(0).describe('Effort estimate (must be >= 0)'),
        }),
      )
      .describe('Array of {nodeId, estimate} pairs'),
  },
  handler: async (backend, { mapId, estimates }) => {
    const mapData = await backend.getMap(mapId);
    const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n] as const));
    const results: string[] = [];
    for (const { nodeId, estimate } of estimates) {
      try {
        const node = nodeMap.get(nodeId);
        if (!node) {
          results.push(`  ${nodeId}: FAILED — Node not found in map ${mapId}`);
          continue;
        }
        if (node.childrenIds.length > 0) {
          results.push(
            `  ${nodeId}: SKIPPED — Cannot set estimate on a parent node. Estimates are auto-computed from child nodes.`,
          );
          continue;
        }
        await backend.updateNode(mapId, nodeId, { effortEstimate: estimate });
        results.push(`  ${nodeId}: estimate = ${estimate}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`  ${nodeId}: FAILED — ${msg}`);
      }
    }
    return `Bulk set_estimate results (${estimates.length} nodes):\n${results.join('\n')}`;
  },
});

export const bulkSetProgressTool = defineTool({
  name: 'bulk_set_progress',
  description: 'Set percent complete on multiple leaf nodes at once',
  schema: {
    mapId: z.string().describe('The map ID'),
    updates: z
      .array(
        z.object({
          nodeId: z.string().describe('Node ID'),
          percent: z.number().min(0).max(100).describe('Percent complete (0-100)'),
        }),
      )
      .describe('Array of {nodeId, percent} pairs'),
  },
  handler: async (backend, { mapId, updates }) => {
    const mapData = await backend.getMap(mapId);
    const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n] as const));
    const results: string[] = [];
    for (const { nodeId, percent } of updates) {
      try {
        const node = nodeMap.get(nodeId);
        if (!node) {
          results.push(`  ${nodeId}: FAILED — Node not found in map ${mapId}`);
          continue;
        }
        if (node.childrenIds.length > 0) {
          results.push(
            `  ${nodeId}: SKIPPED — Cannot set progress on a parent node. Progress is auto-computed from child nodes.`,
          );
          continue;
        }
        await backend.updateNode(mapId, nodeId, { percentComplete: percent });
        results.push(`  ${nodeId}: progress = ${percent}%`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`  ${nodeId}: FAILED — ${msg}`);
      }
    }
    return `Bulk set_progress results (${updates.length} nodes):\n${results.join('\n')}`;
  },
});

export const bulkTools = [bulkUpdateNodesTool, bulkCreateNodesTool, bulkSetEstimateTool, bulkSetProgressTool];
