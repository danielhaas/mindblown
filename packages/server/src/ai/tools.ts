/**
 * OpenAI function-calling tool list + executor for the in-app AI chat.
 *
 * Tool specs come from @mindblown/tool-kit so the MCP server and the in-app
 * chat share a single source of truth. The chat exposes a RESTRICTED subset —
 * a 14B-Q4 model handles a short tool list much better than the full 50+.
 */

import type OpenAI from 'openai';
import type { ToolSpec } from '@mindblown/tool-kit';
import { allTools as sharedTools, specToOpenAiTool } from '@mindblown/tool-kit';
import type { Node as CoreNode } from '@mindblown/core';
import { createChatBackend } from './backend.js';

// ── Tool exposure policy ──────────────────────────────────────

/**
 * Subset of tool names exposed to the chat model. Keep this small — the 14B
 * model drifts when it has too many options, and most management workflows
 * only need create/update/search plus bulk variants.
 */
const CHAT_TOOL_NAMES = new Set<string>([
  'get_map',
  'search_nodes',
  'create_node',
  'update_node',
  'move_node',
  'delete_node',
  'bulk_create_nodes',
  'bulk_update_nodes',
  'bulk_set_estimate',
  'bulk_set_progress',
]);

const chatSpecs: ToolSpec[] = sharedTools.filter((s) => CHAT_TOOL_NAMES.has(s.name));
const specByName = new Map<string, ToolSpec>(chatSpecs.map((s) => [s.name, s]));

export const CHAT_TOOLS: OpenAI.ChatCompletionTool[] = chatSpecs.map(
  (s) => specToOpenAiTool(s) as unknown as OpenAI.ChatCompletionTool,
);

// ── Tool executor ──────────────────────────────────────────────

interface ToolContext {
  userId: string;
  mapId: string;
}

/**
 * Execute a tool call and return the result as a human-readable string.
 * Errors from the backend are caught and returned inline so the chat loop
 * can keep going.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const spec = specByName.get(name);
  if (!spec) return `Error: Unknown tool "${name}"`;

  // The model sometimes omits mapId; inject it from the chat context.
  const enrichedArgs = { mapId: ctx.mapId, ...args };

  const backend = createChatBackend(ctx.userId);
  try {
    return await spec.handler(backend, enrichedArgs);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── System-prompt helpers (used by routes/ai.ts) ───────────────

interface TreeNodeSummary {
  id: string;
  text: string;
  status: string | null;
  estimate: number | null;
  progress: number | null;
  children: TreeNodeSummary[];
}

function buildTreeSummary(nodes: CoreNode[]): TreeNodeSummary[] {
  const byParent = new Map<string | null, CoreNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }

  function build(parentId: string | null): TreeNodeSummary[] {
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
 * Limits to maxNodes to keep the prompt under ~4K chars for 14B models.
 */
export function renderTreeForPrompt(nodes: CoreNode[], maxNodes = 30): string {
  const tree = buildTreeSummary(nodes);
  const lines: string[] = [];
  let count = 0;

  function walk(items: TreeNodeSummary[], depth: number) {
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
