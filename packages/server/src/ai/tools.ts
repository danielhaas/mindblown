/**
 * Chat tool registry + executor.
 *
 * Two layers:
 *   1. Shared tools from @mindblown/tool-kit — same specs the MCP server uses,
 *      executed via the ToolBackend abstraction.
 *   2. Chat-only "extras" — server-side handlers that don't fit the shared
 *      ToolBackend shape (e.g. semantic search needs the embeddings client).
 *
 * Tools are filtered per provider: the local 14B model gets a small,
 * battle-tested set; Anthropic's claude-opus-4-7 gets the wider planning
 * surface. Each tool tags itself with the providers that should see it.
 */

import { z } from 'zod';
import type OpenAI from 'openai';
import type { ToolSpec } from '@mindblown/tool-kit';
import { allTools as sharedTools, specToOpenAiTool } from '@mindblown/tool-kit';
import { defineTool } from '@mindblown/tool-kit';
import type { Node as CoreNode } from '@mindblown/core';
import { createChatBackend } from './backend.js';
import { semanticSearch } from './embeddings.js';
import type { ProviderName } from './providers/types.js';

// ── Tool exposure policy ──────────────────────────────────────

/**
 * Per-tool provider allowlist. A tool with no entry here is exposed to ALL
 * providers. Add an entry to gate a tool to specific providers (e.g. tools
 * that overload the 14B model's tool-call discrimination).
 */
const PROVIDER_ALLOWLIST: Record<string, ProviderName[]> = {
  // currently no overrides — both providers see the same shared base set
};

/**
 * Names from the shared tool-kit that the chat surface exposes. Keep this
 * small for the local model — it drifts with too many options.
 */
const SHARED_CHAT_TOOL_NAMES = new Set<string>([
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

const sharedChatSpecs: ToolSpec[] = sharedTools.filter((s) =>
  SHARED_CHAT_TOOL_NAMES.has(s.name),
);

// ── Chat-only extras (server-side, not in tool-kit) ───────────

interface ChatExtraContext {
  userId: string;
  mapId: string;
}

interface ChatExtraSpec {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Providers allowed to see this tool. Omit = all providers. */
  providers?: ProviderName[];
  handler: (
    args: Record<string, unknown>,
    ctx: ChatExtraContext,
  ) => Promise<string>;
}

const chatExtras: ChatExtraSpec[] = [
  {
    name: 'semantic_search',
    description:
      'Search the current map by meaning rather than keywords. Use this when "find anything related to X" or when text search misses synonyms / paraphrases. Returns ranked node matches with their IDs.',
    schema: {
      query: z
        .string()
        .min(1)
        .describe('Free-form search query — concept, theme, or topic'),
      limit: z
        .number()
        .int()
        .optional()
        .describe('Max results to return (default 10, max 50)'),
    },
    // Local 14B model is unreliable when text-search and semantic-search
    // tools coexist — it picks at random. Gate to Anthropic only.
    providers: ['anthropic'],
    handler: async (args, ctx) => {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: query is required.';
      const limit =
        typeof args.limit === 'number' && args.limit > 0 ? args.limit : 10;
      const matches = await semanticSearch(ctx.mapId, query, limit);
      if (matches.length === 0) {
        return `No semantic matches for "${query}" — the map may not have embeddings yet.`;
      }
      return matches
        .map(
          (m, i) =>
            `${i + 1}. "${m.text}" [id:${m.nodeId}] — score ${m.score.toFixed(2)}`,
        )
        .join('\n');
    },
  },
];

const extraByName = new Map<string, ChatExtraSpec>(
  chatExtras.map((x) => [x.name, x]),
);

// ── Public surface ────────────────────────────────────────────

/** Specs available to a given provider, after applying the allowlist + extras. */
export function getChatToolSpecs(provider: ProviderName): ToolSpec[] {
  const sharedAllowed = sharedChatSpecs.filter((s) => {
    const allow = PROVIDER_ALLOWLIST[s.name];
    return !allow || allow.includes(provider);
  });
  const extrasAllowed = chatExtras
    .filter((x) => !x.providers || x.providers.includes(provider))
    .map(
      (x): ToolSpec =>
        defineTool({
          name: x.name,
          description: x.description,
          schema: x.schema,
          // The shared ToolSpec handler signature takes a backend; chat extras
          // ignore it. They get dispatched via executeTool below, not via the
          // shared backend, so this handler is never called in practice — but
          // it has to satisfy the type to keep providers honest.
          handler: async () =>
            'Error: chat extra invoked through shared backend (use executeTool)',
        }),
    );
  return [...sharedAllowed, ...extrasAllowed];
}

/** OpenAI-format tool list (legacy callers; new code uses providers + getChatToolSpecs). */
export const CHAT_TOOLS: OpenAI.ChatCompletionTool[] = sharedChatSpecs.map(
  (s) => specToOpenAiTool(s) as unknown as OpenAI.ChatCompletionTool,
);

const sharedSpecByName = new Map<string, ToolSpec>(
  sharedChatSpecs.map((s) => [s.name, s]),
);

interface ToolContext {
  userId: string;
  mapId: string;
}

/**
 * Execute a tool call and return the result as a human-readable string.
 * Dispatches: extras handle themselves; shared specs go through ToolBackend.
 * Errors from either path are caught and returned inline so the chat loop
 * can keep going.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  // Chat extras first — they don't use the shared backend.
  const extra = extraByName.get(name);
  if (extra) {
    try {
      return await extra.handler(args, ctx);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const spec = sharedSpecByName.get(name);
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

/**
 * Render a focused view: the selected node's ancestor path plus its subtree
 * (depth-limited). Used when the chat panel passes selectedNodeId — gives
 * the model enough context to answer "break this down" without re-rendering
 * the whole map.
 */
export function renderFocusContext(
  nodes: CoreNode[],
  focusId: string,
  maxDepth = 2,
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus) return null;

  // Ancestor path
  const path: CoreNode[] = [];
  let cur: CoreNode | undefined = focus;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const pathLine = path.map((n) => `"${n.text}"`).join(' → ');

  // Subtree under focus (cap by depth and a hard count)
  const childrenByParent = new Map<string | null, CoreNode[]>();
  for (const n of nodes) {
    const list = childrenByParent.get(n.parentId) ?? [];
    list.push(n);
    childrenByParent.set(n.parentId, list);
  }
  const subtreeLines: string[] = [];
  let subCount = 0;
  const SUB_CAP = 25;
  function walk(parentId: string, depth: number) {
    if (depth > maxDepth || subCount >= SUB_CAP) return;
    const kids = childrenByParent.get(parentId) ?? [];
    for (const k of kids) {
      if (subCount >= SUB_CAP) return;
      subCount++;
      subtreeLines.push(`${'  '.repeat(depth)}- ${k.text} [${k.id}]`);
      walk(k.id, depth + 1);
    }
  }
  walk(focus.id, 1);

  const out: string[] = [];
  out.push(`Focused node: "${focus.text}" [${focus.id}]`);
  out.push(`Path: ${pathLine}`);
  if (focus.description) out.push(`Description: ${focus.description}`);
  if (subtreeLines.length > 0) {
    out.push('Subtree (use these IDs first when the user says "this" or "here"):');
    out.push(...subtreeLines);
  } else {
    out.push('(leaf — no children)');
  }
  return out.join('\n');
}
