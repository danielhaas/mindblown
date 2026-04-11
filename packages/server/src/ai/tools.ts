/**
 * Tool definitions + executor for the in-app AI chat.
 * Each tool maps to a direct DB operation — no HTTP round-trip.
 */

import type OpenAI from 'openai';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { broadcast } from '../ws.js';
import type { Node as CoreNode } from '@mindblown/core';

// ── Tool definitions (OpenAI function-calling format) ──────────

export const CHAT_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_map',
      description: 'Get the full mindmap tree — all nodes with their IDs, text, parent, children, estimates, status, etc. Call this first to understand the current structure before making changes.',
      parameters: {
        type: 'object',
        properties: {
          mapId: { type: 'string', description: 'The map ID' },
        },
        required: ['mapId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_node',
      description: 'Create a new node (task/idea) under a parent node.',
      parameters: {
        type: 'object',
        properties: {
          mapId: { type: 'string', description: 'The map ID' },
          parentId: { type: 'string', description: 'ID of the parent node to add under' },
          text: { type: 'string', description: 'The node text/title' },
          effortEstimate: { type: 'number', description: 'Effort estimate (optional)' },
        },
        required: ['mapId', 'parentId', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_node',
      description: 'Update fields on an existing node — text, status, effortEstimate, priority, description, etc.',
      parameters: {
        type: 'object',
        properties: {
          mapId: { type: 'string', description: 'The map ID (for broadcasting changes)' },
          nodeId: { type: 'string', description: 'The node ID to update' },
          text: { type: 'string', description: 'New text/title' },
          description: { type: 'string', description: 'New description' },
          status: { type: 'string', description: 'New status (e.g. "todo", "in_progress", "done")' },
          effortEstimate: { type: 'number', description: 'New effort estimate' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Priority level' },
          percentComplete: { type: 'number', description: 'Percent complete (0-100)' },
        },
        required: ['mapId', 'nodeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_node',
      description: 'Move a SOURCE node under a DESTINATION parent node. The source is the node being moved. The destination is where it goes.',
      parameters: {
        type: 'object',
        properties: {
          mapId: { type: 'string', description: 'The map ID' },
          nodeId: { type: 'string', description: 'SOURCE: the ID of the node being moved' },
          newParentId: { type: 'string', description: 'DESTINATION: the ID of the parent node where it should go' },
        },
        required: ['mapId', 'nodeId', 'newParentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_nodes',
      description: 'Search for nodes by text (case-insensitive substring match). Use this to find nodes when the user refers to them by name.',
      parameters: {
        type: 'object',
        properties: {
          mapId: { type: 'string', description: 'The map ID' },
          query: { type: 'string', description: 'Text to search for' },
        },
        required: ['mapId', 'query'],
      },
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────

interface ToolContext {
  userId: string;
  mapId: string; // Always injected server-side so the model doesn't need to pass it
}

/**
 * Execute a tool call and return the result as a string.
 * Also broadcasts changes via WebSocket.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const mapId = (args.mapId as string) || ctx.mapId;

  switch (name) {
    case 'get_map': {
      const data = await mapDb.getMap(mapId);
      if (!data) return JSON.stringify({ error: 'Map not found' });
      // Return a compact tree representation to save tokens
      const tree = buildTreeSummary(data.nodes);
      return JSON.stringify({ map: data.map.name, effortUnit: data.map.effortUnit, nodes: tree });
    }

    case 'create_node': {
      const node = await nodeDb.createNode({
        mapId,
        parentId: args.parentId as string,
        text: args.text as string,
        createdBy: ctx.userId,
        effortEstimate: args.effortEstimate as number | undefined,
      });
      broadcast(mapId, { type: 'node:created', node });
      return JSON.stringify({ created: { id: node.id, text: node.text, parentId: node.parentId } });
    }

    case 'update_node': {
      const { mapId: _m, nodeId, ...fields } = args as Record<string, unknown>;
      const updated = await nodeDb.updateNode(nodeId as string, fields);
      if (!updated) return JSON.stringify({ error: 'Node not found' });
      broadcast(mapId, { type: 'node:updated', nodeId, fields: Object.keys(fields), node: updated });
      return JSON.stringify({ updated: { id: updated.id, text: updated.text, status: updated.status } });
    }

    case 'move_node': {
      const moved = await nodeDb.moveNode(args.nodeId as string, args.newParentId as string);
      if (!moved) return JSON.stringify({ error: 'Node not found' });
      broadcast(mapId, { type: 'node:moved', nodeId: args.nodeId, newParentId: args.newParentId });
      return JSON.stringify({ moved: { id: moved.id, text: moved.text, newParentId: moved.parentId } });
    }

    case 'delete_node': {
      const deletedIds = await nodeDb.deleteNode(args.nodeId as string);
      if (deletedIds.length === 0) return JSON.stringify({ error: 'Node not found' });
      broadcast(mapId, { type: 'node:deleted', nodeId: args.nodeId, deletedIds });
      return JSON.stringify({ deleted: deletedIds.length, ids: deletedIds });
    }

    case 'search_nodes': {
      const data = await mapDb.getMap(mapId);
      if (!data) return JSON.stringify({ error: 'Map not found' });
      const q = (args.query as string).toLowerCase();
      const matches = data.nodes
        .filter((n) => n.text.toLowerCase().includes(q))
        .slice(0, 10)
        .map((n) => ({ id: n.id, text: n.text, parentId: n.parentId, status: n.status }));
      return JSON.stringify({ matches, total: matches.length });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Helpers ────────────────────────────────────────────────────

interface TreeNode {
  id: string;
  text: string;
  status: string | null;
  estimate: number | null;
  progress: number | null;
  children: TreeNode[];
}

function buildTreeSummary(nodes: CoreNode[]): TreeNode[] {
  const byParent = new Map<string | null, CoreNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }

  function build(parentId: string | null): TreeNode[] {
    const children = byParent.get(parentId) ?? [];
    return children.map((n) => ({
      id: n.id,
      text: n.text,
      status: n.status,
      estimate: n.effortEstimate,
      progress: n.percentComplete,
      children: build(n.id),
    }));
  }

  return build(null);
}

/**
 * Render a plain-text tree suitable for injecting into the system prompt.
 * Format: "- NodeText [id:abc123]"
 * Limits to MAX_NODES to keep the prompt under ~4K chars for 14B models.
 */
export function renderTreeForPrompt(nodes: CoreNode[], maxNodes = 30): string {
  const tree = buildTreeSummary(nodes);
  const lines: string[] = [];
  let count = 0;

  function walk(items: TreeNode[], depth: number) {
    for (const n of items) {
      if (count >= maxNodes) return;
      count++;
      lines.push(`${'  '.repeat(depth)}- ${n.text} [${n.id}]`);
      walk(n.children, depth + 1);
    }
  }

  walk(tree, 0);
  if (count >= maxNodes && nodes.length > count) {
    lines.push(`... ${nodes.length - count} more nodes. Use search_nodes to find them.`);
  }
  return lines.join('\n');
}
