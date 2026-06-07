/**
 * AI routes — all behind /api/ai/*
 * Protected by the auth middleware registered earlier in the pipeline.
 */

import type { FastifyInstance } from 'fastify';
import { aiEnabled, aiConfig, chatCompletion } from '../ai/client.js';
import { getChatToolSpecs, executeTool, renderTreeForPrompt, renderFocusContext } from '../ai/tools.js';
import { resolveProvider, providerStatus } from '../ai/providers/index.js';
import { anthropicAvailable } from '../ai/providers/anthropic.js';
import type { NormalizedMessage, NormalizedToolCall } from '../ai/providers/types.js';
import { semanticSearch, backfillMapEmbeddings, scheduleEmbedNode } from '../ai/embeddings.js';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { broadcast } from '../ws.js';
import { computeTree, type Node as CoreNode } from '@mindblown/core';

// ── Helpers ──────────────────────────────────────────────────────

/** Walk up from a node to the root, collecting ancestor text labels. */
function ancestorPath(nodeId: string, nodeMap: Map<string, CoreNode>): string[] {
  const path: string[] = [];
  let current = nodeMap.get(nodeId);
  while (current) {
    path.unshift(current.text);
    current = current.parentId ? nodeMap.get(current.parentId) : undefined;
  }
  return path;
}

/** Collect direct children texts for a node. */
function childrenTexts(nodeId: string, nodes: CoreNode[]): string[] {
  return nodes
    .filter((n) => n.parentId === nodeId)
    .map((n) => n.text);
}

/** Collect sibling texts (other children of the same parent). */
function siblingTexts(node: CoreNode, nodes: CoreNode[]): string[] {
  if (!node.parentId) return [];
  return nodes
    .filter((n) => n.parentId === node.parentId && n.id !== node.id)
    .map((n) => n.text);
}

// ── Types ────────────────────────────────────────────────────────

interface BreakdownSuggestion {
  text: string;
  estimate: number | null;
  /** Optional grouped children. When present, the parent is a category and
   * its estimate should be ignored — only leaves carry estimates. Capped at
   * depth 2 (categories → leaves) by the sanitizer. */
  children?: BreakdownSuggestion[];
}

interface BraindumpNode {
  text: string;
  estimate: number | null;
  children: BraindumpNode[];
}

function sanitizeBraindumpTree(value: unknown, depth = 0, maxDepth = 3): BraindumpNode[] {
  if (!Array.isArray(value)) return [];
  if (depth >= maxDepth) return [];
  return value
    .map((raw): BraindumpNode | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const text = typeof r.text === 'string' ? r.text.trim() : '';
      if (!text) return null;
      const estimate =
        typeof r.estimate === 'number' && r.estimate > 0 ? r.estimate : null;
      const children = sanitizeBraindumpTree(r.children, depth + 1, maxDepth);
      return { text, estimate, children };
    })
    .filter((n): n is BraindumpNode => n !== null);
}

/** Like sanitizeBraindumpTree but for the breakdown shape (children optional). */
function sanitizeBreakdownTree(value: unknown, depth = 0, maxDepth = 2): BreakdownSuggestion[] {
  if (!Array.isArray(value)) return [];
  if (depth >= maxDepth) return [];
  return value
    .map((raw): BreakdownSuggestion | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const text = typeof r.text === 'string' ? r.text.trim() : '';
      if (!text) return null;
      const estimate =
        typeof r.estimate === 'number' && r.estimate > 0 ? r.estimate : null;
      const childList = sanitizeBreakdownTree(r.children, depth + 1, maxDepth);
      const node: BreakdownSuggestion = { text, estimate };
      if (childList.length > 0) node.children = childList;
      return node;
    })
    .filter((n): n is BreakdownSuggestion => n !== null);
}

// ── Routes ───────────────────────────────────────────────────────

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // Catch-all only if NO provider is configured. Individual endpoints below
  // gate themselves to Ollama when they specifically need it (embeddings,
  // legacy JSON-mode endpoints) — the chat endpoint works against either
  // backend via the provider resolver.
  const anyProviderAvailable = aiEnabled || anthropicAvailable;
  if (!anyProviderAvailable) {
    app.all('/api/ai/*', async (_req, reply) => {
      return reply.status(503).send({
        error: {
          code: 'AI_NOT_CONFIGURED',
          message: 'AI features require ANTHROPIC_API_KEY or AI_BASE_URL',
        },
      });
    });
    return;
  }

  // Helper for endpoints that specifically require the Ollama backend
  // (embeddings + legacy JSON-mode chat completions live there today).
  const requireOllama = (
    reply: import('fastify').FastifyReply,
  ): boolean => {
    if (aiEnabled) return true;
    reply.status(503).send({
      error: {
        code: 'AI_NOT_CONFIGURED',
        message: 'This endpoint requires the local AI backend (set AI_BASE_URL)',
      },
    });
    return false;
  };

  // ── Config / health ────────────────────────────────────────────
  app.get('/api/ai/config', async () => {
    const status = await providerStatus();
    return { ...aiConfig(), ...status };
  });

  // ── Ping — quick round-trip to the LLM to verify connectivity ─
  app.get('/api/ai/ping', async (_req, reply) => {
    if (!requireOllama(reply)) return;
    try {
      const t0 = Date.now();
      const result = await chatCompletion({
        messages: [{ role: 'user', content: 'Respond with exactly: pong' }],
        maxTokens: 16,
        temperature: 0,
      });
      return {
        status: 'ok',
        model: aiConfig().model,
        latencyMs: Date.now() - t0,
        response: result.trim(),
      };
    } catch (err: any) {
      return reply.status(502).send({
        error: { code: 'AI_UNREACHABLE', message: err.message },
      });
    }
  });

  // ── POST /api/ai/breakdown — suggest child tasks for a node ────
  //
  // Request:  { mapId, nodeId, count?: number, hint?: string }
  // Response: { suggestions: Array<{ text, estimate }> }
  //
  // The caller can then accept (POST /api/ai/breakdown/accept) to
  // actually create the nodes, or discard. This keeps the LLM call
  // separate from the write so the user can preview.

  app.post('/api/ai/breakdown', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as {
      mapId: string;
      nodeId: string;
      count?: number;
      hint?: string;
    };

    if (!body.mapId || !body.nodeId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and nodeId are required' },
      });
    }

    // Fetch the map + all nodes for context
    const mapDetail = await mapDb.getMap(body.mapId);
    if (!mapDetail) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    const nodeMap = new Map(mapDetail.nodes.map((n) => [n.id, n]));
    const targetNode = nodeMap.get(body.nodeId);
    if (!targetNode) {
      return reply.status(404).send({
        error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
      });
    }

    const count = Math.min(body.count ?? 5, 15);
    const path = ancestorPath(body.nodeId, nodeMap);
    const existingChildren = childrenTexts(body.nodeId, mapDetail.nodes);
    const siblings = siblingTexts(targetNode, mapDetail.nodes);
    const effortUnit = mapDetail.map.effortUnit ?? 'days';

    // Build prompt — supports either a flat list (≤6 tasks) or a 2-level
    // tree (categories → tasks) when the breakdown would otherwise produce
    // too many siblings to read at a glance.
    const systemPrompt = `You are a project planning assistant. You help break down work items into smaller, actionable subtasks.

Rules:
- Return ONLY a JSON object: {"tasks": [{"text": "...", "estimate": <number or null>, "children": [...]}]}
- Each "text" should be a concise, actionable work item (imperative mood, no numbering)
- Estimates are in ${effortUnit}. Use null if you can't estimate confidently.
- Leaf tasks should be small enough to complete in 1-3 ${effortUnit}
- **Grouping:** if the breakdown would produce more than 6 sibling tasks, group
  them under 2-4 category nodes. A category has descriptive text (e.g.
  "Backend", "Frontend"), no estimate (use null), and a non-empty "children"
  array of leaf tasks. Categories are at most one level deep — leaves under
  a category must NOT have their own "children".
- If 6 or fewer tasks would result, return them flat — no "children" arrays.
- Don't duplicate existing children or siblings
- No preamble, no markdown, no explanation — just the JSON`;

    let userPrompt = `Break down this work item into ${count} subtasks.

Project: ${mapDetail.map.name}
Path: ${path.join(' → ')}
Node to break down: "${targetNode.text}"`;

    if (targetNode.description) {
      userPrompt += `\nDescription: ${targetNode.description}`;
    }
    if (existingChildren.length > 0) {
      userPrompt += `\nExisting children (don't duplicate): ${existingChildren.join(', ')}`;
    }
    if (siblings.length > 0) {
      userPrompt += `\nSiblings (for context on scope/granularity): ${siblings.join(', ')}`;
    }
    if (body.hint) {
      userPrompt += `\nAdditional context: ${body.hint}`;
    }

    try {
      const raw = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5,
        maxTokens: 2048,
        jsonSchema: { name: 'breakdown' },
      });

      // Parse — handle models that wrap JSON in markdown fences
      const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as { tasks: unknown };

      const suggestions = sanitizeBreakdownTree(parsed.tasks, 0, 2);
      if (suggestions.length === 0) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model did not return a valid tasks array' },
        });
      }

      // Honor the requested `count` as a total-leaf budget rather than a
      // top-level cap: with grouping enabled, "count = 10" means up to 10
      // leaf tasks across the categories, not 10 categories.
      let leafBudget = count;
      const trimmed: BreakdownSuggestion[] = [];
      for (const node of suggestions) {
        if (leafBudget <= 0) break;
        if (node.children && node.children.length > 0) {
          const room = Math.min(node.children.length, leafBudget);
          trimmed.push({ ...node, children: node.children.slice(0, room) });
          leafBudget -= room;
        } else {
          trimmed.push(node);
          leafBudget -= 1;
        }
      }

      return { suggestions: trimmed };
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model returned invalid JSON' },
        });
      }
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/breakdown/accept — create the suggested nodes ──
  //
  // Request:  { mapId, parentId, tasks: Array<{ text, estimate }> }
  // Response: { created: CoreNode[] }

  app.post('/api/ai/breakdown/accept', async (req, reply) => {
    const body = req.body as {
      mapId: string;
      parentId: string;
      tasks: BreakdownSuggestion[];
    };

    if (!body.mapId || !body.parentId || !Array.isArray(body.tasks) || body.tasks.length === 0) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId, parentId, and non-empty tasks array required' },
      });
    }

    const userId = (req as any).userId ?? 'system';
    const created: CoreNode[] = [];

    // Recursively create — categories first, then their leaves. Categories
    // get no estimate (parents auto-compute from children's rollup).
    async function createBranch(
      parentId: string,
      items: BreakdownSuggestion[],
    ): Promise<void> {
      for (const item of items) {
        const hasChildren = !!item.children && item.children.length > 0;
        const node = await nodeDb.createNode({
          mapId: body.mapId,
          parentId,
          text: item.text,
          createdBy: userId,
          effortEstimate: hasChildren ? undefined : (item.estimate ?? undefined),
        });
        created.push(node);
        broadcast(body.mapId, { type: 'node:created', node });
        scheduleEmbedNode(node.id);
        if (hasChildren) await createBranch(node.id, item.children!);
      }
    }

    try {
      await createBranch(body.parentId, body.tasks);
      return reply.status(201).send({ created });
    } catch (err: any) {
      return reply.status(500).send({
        error: { code: 'CREATE_FAILED', message: err.message },
      });
    }
  });

  // ── POST /api/ai/chat — conversational chat with tool use ──────
  //
  // Request:  { mapId, messages: ChatMessage[] }
  // Response: SSE stream of { type: 'delta'|'tool_call'|'tool_result'|'done'|'error', ... }
  //
  // Provider-agnostic: a ChatProvider (Ollama or Anthropic) handles the
  // model-specific bits and emits normalized events; this loop translates
  // them into SSE, executes tool calls, and feeds results back as the
  // next-turn input. MAX_STEPS bounds runaway loops.

  const MAX_STEPS = 6;
  // No provider event for this long → assume upstream is wedged, abort.
  // Generous because qwen2.5:14b on Ollama can take ~90s for tool-heavy turns.
  const TURN_WATCHDOG_MS = 120_000;
  // Idle SSE comment cadence — keeps reverse-proxy connections alive while
  // we wait on a non-streaming upstream (e.g. Ollama returning a whole
  // completion in one shot). Comments are ignored by EventSource.
  const HEARTBEAT_MS = 10_000;

  app.post('/api/ai/chat', async (req, reply) => {
    const body = req.body as {
      mapId: string;
      messages: Array<{
        role: string;
        content: string;
        toolCalls?: Array<{
          id?: string;
          name: string;
          args?: Record<string, unknown>;
          result?: unknown;
        }>;
      }>;
      selectedNodeId?: string | null;
    };

    if (!body.mapId || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and non-empty messages array required' },
      });
    }

    const userId = (req as any).userId ?? 'system';

    // Set up SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Connection state. Once the client disconnects (or we wrote `done`/`error`
    // and ended the response) further writes would EPIPE; guard the helper.
    let clientGone = false;
    const send = (event: string, data: unknown) => {
      if (clientGone || reply.raw.destroyed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientGone = true;
      }
    };
    const heartbeat = setInterval(() => {
      if (clientGone || reply.raw.destroyed) return;
      try {
        reply.raw.write(`: hb\n\n`);
      } catch {
        clientGone = true;
      }
    }, HEARTBEAT_MS);

    // Per-request abort: fires on client disconnect OR watchdog timeout. We
    // record the *reason* in a closure variable so the catch block below can
    // distinguish "user closed the panel" from "upstream wedged" and either
    // exit silently or surface AI_TIMEOUT to the (still-watching) user.
    type AbortReason = 'client_disconnect' | 'timeout' | null;
    let abortReason: AbortReason = null;
    const controller = new AbortController();
    const onClientClose = () => {
      clientGone = true;
      if (!controller.signal.aborted) {
        abortReason = 'client_disconnect';
        controller.abort();
      }
    };
    reply.raw.on('close', onClientClose);

    try {
      const provider = await resolveProvider();

      // Pre-load the map tree so the model already has all node IDs
      const mapDetail = await mapDb.getMap(body.mapId);
      if (!mapDetail) {
        send('error', { message: 'Map not found' });
        reply.raw.end();
        return;
      }

      const rootNode = mapDetail.nodes.find((n) => n.parentId === null);
      const treeText = renderTreeForPrompt(mapDetail.nodes);

      const rootId = rootNode?.id ?? '';
      // Focus context: when the user has a node selected, give the model a
      // tighter view (path + subtree) so deictic phrases like "this" / "here"
      // resolve. Falls through to the full-tree render if nothing is selected
      // or the ID was stale.
      const focusBlock =
        body.selectedNodeId && body.selectedNodeId.length > 0
          ? renderFocusContext(mapDetail.nodes, body.selectedNodeId)
          : null;

      const focusParentLine = focusBlock
        ? `When the user says "this" or "here", they mean the focused node above. Use its id as parentId for "add a child" requests unless told otherwise.`
        : `When the user says "add X" without a parent, use parentId "${rootId}".`;

      // Tell the model to recover from typos with whatever search tool it
      // has. Anthropic gets semantic_search; Ollama only sees search_nodes
      // (the local 14B model drifts when both are exposed at once).
      const typoRecoveryHint =
        provider.name === 'anthropic'
          ? `If the user names a node that doesn't appear in the tree above, treat it as a possible typo or paraphrase — try search_nodes (substring) or semantic_search (meaning) before assuming they meant something literal. E.g. "rename the lawyer node" on a map with no "lawyer" likely means "layer". When still unsure after one search, ask one short clarifying question instead of guessing.`
          : `If the user names a node that doesn't appear in the tree above, treat it as a possible typo — try search_nodes with the closest substring before assuming they meant something literal. E.g. "rename the lawyer node" on a map with no "lawyer" likely means "layer". When still unsure, ask one short clarifying question instead of guessing.`;

      const systemPrompt = `You manage a project mindmap. Reply ONLY in English.

mapId = "${body.mapId}"

The root node is "${rootNode?.text ?? 'Root'}" with id "${rootId}".
${focusBlock ? `\n${focusBlock}\n` : ''}${focusParentLine}

Current nodes:
${treeText}

Rules:
1. Only use IDs shown in [id:...] above. Never invent an ID.
2. For move_node: "source" is the node being moved, "destination" is where it goes.
3. One tool call per message. Confirm what you did in one short English sentence.
4. You cannot delete nodes.
5. ${typoRecoveryHint}`;

      // Round-trip prior turns' tool calls + results so the model can see
      // what it actually did — without these blocks it second-guesses its
      // own prose and re-executes completed actions.
      const messages: NormalizedMessage[] = [];
      for (let mIdx = 0; mIdx < body.messages.length; mIdx++) {
        const m = body.messages[mIdx];
        if (m.role !== 'assistant') {
          messages.push({ role: 'user' as const, content: m.content });
          continue;
        }
        // Drop tool calls without results — Anthropic rejects an unmatched tool_use block.
        const completed = (m.toolCalls ?? []).filter((tc) => tc.result !== undefined);
        const toolCalls: NormalizedToolCall[] = completed.map((tc, i) => ({
          id: tc.id ?? `prior-${mIdx}-${i}`,
          name: tc.name,
          args: tc.args ?? {},
        }));
        messages.push({ role: 'assistant' as const, content: m.content, toolCalls });
        for (let i = 0; i < completed.length; i++) {
          const tc = completed[i];
          messages.push({
            role: 'tool' as const,
            toolCallId: toolCalls[i].id,
            toolName: tc.name,
            content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result),
          });
        }
      }

      let hitStepLimit = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        let assistantText = '';
        let firstToolCall: NormalizedToolCall | null = null;

        // Watchdog: trip if the provider goes silent for too long. Reset on
        // every event we receive. With Ollama's non-streaming runTurn the
        // *only* event arrival is the end of the upstream completion, so the
        // watchdog effectively caps total turn time; with Anthropic streaming
        // the deltas arrive in milliseconds and the watchdog never trips.
        let watchdog: NodeJS.Timeout | null = null;
        const armWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (!controller.signal.aborted) {
              abortReason = 'timeout';
              controller.abort();
            }
          }, TURN_WATCHDOG_MS);
        };
        armWatchdog();

        try {
          for await (const ev of provider.runTurn({
            systemPrompt,
            messages,
            tools: getChatToolSpecs(provider.name),
            signal: controller.signal,
          })) {
            armWatchdog();
            if (ev.type === 'text_delta') {
              assistantText += ev.text;
              send('delta', { content: ev.text });
            } else if (ev.type === 'tool_call') {
              // Only the first tool call per turn \u2014 keeps both providers
              // consistent and matches the legacy 14B-stable behavior.
              if (!firstToolCall) firstToolCall = ev.toolCall;
            }
          }
        } finally {
          if (watchdog) clearTimeout(watchdog);
        }

        // Append the assistant turn so the next provider call sees the history.
        messages.push({
          role: 'assistant',
          content: assistantText,
          toolCalls: firstToolCall ? [firstToolCall] : [],
        });

        if (!firstToolCall) break;

        // If this was the final allowed iteration and the model still wants
        // to call tools, we'll execute this one but mark that we ran out of
        // room to let it summarise \u2014 surface that to the UI as step_limit.
        if (step === MAX_STEPS - 1) hitStepLimit = true;

        send('tool_call', {
          id: firstToolCall.id,
          name: firstToolCall.name,
          args: firstToolCall.args,
        });

        let result: string;
        try {
          result = await executeTool(firstToolCall.name, firstToolCall.args, {
            userId,
            mapId: body.mapId,
          });
        } catch (err: any) {
          result = `Error: ${err.message}`;
        }

        send('tool_result', {
          id: firstToolCall.id,
          name: firstToolCall.name,
          result,
        });

        messages.push({
          role: 'tool',
          toolCallId: firstToolCall.id,
          toolName: firstToolCall.name,
          content: result,
        });

        if (clientGone) break;
      }

      if (hitStepLimit) send('step_limit', { maxSteps: MAX_STEPS });
      send('done', {});
    } catch (err: any) {
      if (abortReason === 'client_disconnect') {
        // Client is gone, no one's listening \u2014 just unwind silently.
      } else if (abortReason === 'timeout') {
        send('error', {
          code: 'AI_TIMEOUT',
          message: `The AI took too long to respond (waited ${TURN_WATCHDOG_MS / 1000}s). Try again or simplify the request.`,
        });
      } else {
        send('error', { message: err.message });
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.off('close', onClientClose);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  // ── GET /api/ai/search — semantic node search ─────────────────
  //
  // Query:    ?mapId=...&q=...&limit=10
  // Response: { matches: Array<{ nodeId, text, score }> }
  //
  // Uses cosine similarity over pre-computed node embeddings. Nodes
  // without an embedding are silently skipped — run /embeddings/backfill
  // first if coverage matters.

  app.get('/api/ai/search', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const query = req.query as { mapId?: string; q?: string; limit?: string };
    if (!query.mapId || !query.q?.trim()) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and q query params required' },
      });
    }
    const limit = query.limit ? parseInt(query.limit, 10) : 10;
    try {
      const matches = await semanticSearch(query.mapId, query.q, Number.isFinite(limit) ? limit : 10);
      return { matches };
    } catch (err: any) {
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/embeddings/backfill — compute missing embeddings ─
  //
  // Walks every node in the given map, embedding any node whose
  // source text has changed (or was never embedded). Idempotent —
  // safe to run repeatedly.

  app.post('/api/ai/embeddings/backfill', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as { mapId: string };
    if (!body.mapId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId required' },
      });
    }
    try {
      const result = await backfillMapEmbeddings(body.mapId);
      return result;
    } catch (err: any) {
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/braindump — prose → nested tree preview ───────
  //
  // Request:  { mapId, parentId, prose, maxDepth? }
  // Response: { tree: BraindumpNode[] }
  //
  // The model receives a blob of freeform prose and the current ancestor
  // path and returns a hierarchical JSON tree. Users preview and edit
  // before committing via /accept — same split as /breakdown.

  app.post('/api/ai/braindump', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as {
      mapId: string;
      parentId: string;
      prose: string;
      maxDepth?: number;
    };

    if (!body.mapId || !body.parentId || !body.prose?.trim()) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId, parentId, and non-empty prose are required' },
      });
    }

    const mapDetail = await mapDb.getMap(body.mapId);
    if (!mapDetail) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    const nodeMap = new Map(mapDetail.nodes.map((n) => [n.id, n]));
    const parentNode = nodeMap.get(body.parentId);
    if (!parentNode) {
      return reply.status(404).send({
        error: { code: 'NODE_NOT_FOUND', message: `Parent ${body.parentId} not found` },
      });
    }

    // Clamp depth: 1 = flat list, 3 = realistic upper bound for a 14B model
    const maxDepth = Math.max(1, Math.min(body.maxDepth ?? 3, 3));
    const path = ancestorPath(body.parentId, nodeMap);
    const existingChildren = childrenTexts(body.parentId, mapDetail.nodes);
    const effortUnit = mapDetail.map.effortUnit ?? 'days';

    const systemPrompt = `You are a project planning assistant. Convert a brain-dump of prose into a structured tree of tasks that will be attached under an existing parent node.

Rules:
- Return ONLY a JSON object: {"tree": [{"text": "...", "estimate": <number or null>, "children": [...]}]}
- Group related ideas under parent nodes where the prose implies structure; otherwise return a flat list
- Keep text concise and imperative ("Add rate limiting", not "We should add rate limiting")
- Strip numbering, bullets, and preamble
- Maximum nesting depth: ${maxDepth}
- Estimates are in ${effortUnit}. Use null when you can't estimate confidently
- Do not duplicate any of the existing children listed below
- No preamble, no markdown fences, no explanation — just the JSON`;

    let userPrompt = `Project: ${mapDetail.map.name}
Path: ${path.join(' → ')}
Parent node: "${parentNode.text}"`;

    if (existingChildren.length > 0) {
      userPrompt += `\nExisting children (don't duplicate): ${existingChildren.join(', ')}`;
    }
    userPrompt += `\n\nBrain dump:\n${body.prose.trim()}`;

    try {
      const raw = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        maxTokens: 3072,
        jsonSchema: { name: 'braindump' },
      });

      const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as { tree: unknown };

      const tree = sanitizeBraindumpTree(parsed.tree, 0, maxDepth);
      if (tree.length === 0) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model did not return any usable tasks' },
        });
      }

      return { tree };
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model returned invalid JSON' },
        });
      }
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/estimate — calibrated effort estimate ────────
  //
  // Request:  { mapId, text?, nodeId?, hint? }
  // Response: { estimate, confidence, notes?, samplesUsed, fudgeFactor }
  //
  // Uses the same calibration set as get_estimation_accuracy: completed
  // leaves with both an estimate and an actualEffort. The LLM gets the
  // samples as context and returns a raw estimate; we then scale by the
  // fudge factor so the prediction is in the same calibrated space as
  // completion_forecast's velocity-adjusted dates.

  app.post('/api/ai/estimate', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as {
      mapId: string;
      text?: string;
      nodeId?: string;
      hint?: string;
    };

    if (!body.mapId || (!body.text && !body.nodeId)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and one of text or nodeId required' },
      });
    }

    const mapDetail = await mapDb.getMap(body.mapId);
    if (!mapDetail) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    // Resolve target text — either given directly or pulled from an existing node.
    let targetText = body.text?.trim() ?? '';
    let targetDescription = '';
    let targetContext = '';
    if (body.nodeId) {
      const node = mapDetail.nodes.find((n) => n.id === body.nodeId);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
        });
      }
      if (!targetText) targetText = node.text;
      targetDescription = node.description ?? '';
      const nodeMap = new Map(mapDetail.nodes.map((n) => [n.id, n]));
      targetContext = ancestorPath(body.nodeId, nodeMap).join(' → ');
    }

    if (!targetText) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'No usable text to estimate' },
      });
    }

    // Pull calibration samples: completed leaves with estimate and actual set.
    // Take the 30 most recent by updatedAt so old noisy data doesn't dominate.
    const calibrationLeaves = mapDetail.nodes
      .filter(
        (n) =>
          (n.childrenIds?.length ?? 0) === 0 &&
          n.effortEstimate != null &&
          n.actualEffort != null,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 30);

    const calibEstimate = calibrationLeaves.reduce((s, n) => s + (n.effortEstimate ?? 0), 0);
    const calibActual = calibrationLeaves.reduce((s, n) => s + (n.actualEffort ?? 0), 0);
    const fudgeFactor = calibEstimate > 0 ? calibActual / calibEstimate : 1.0;
    const effortUnit = mapDetail.map.effortUnit ?? 'days';

    const samplesText = calibrationLeaves.length > 0
      ? calibrationLeaves
          .map(
            (n, i) =>
              `${i + 1}. "${n.text}" — estimated ${n.effortEstimate} ${effortUnit}, actual ${n.actualEffort} ${effortUnit}`,
          )
          .join('\n')
      : '(no calibration data yet — give an unscaled best-guess estimate)';

    const systemPrompt = `You are a project estimation assistant. You produce calibrated effort estimates by reasoning from past completed work on the same project.

Rules:
- Return ONLY a JSON object: {"estimate": <number>, "confidence": "low" | "medium" | "high", "notes": "<one short sentence>"}
- The raw estimate you produce should be in ${effortUnit}, in the SAME scale the team uses when planning (not calibrated — the caller applies the fudge factor)
- Confidence is "high" when multiple samples strongly match, "medium" when you're inferring from loose analogies, "low" when calibration data is thin or the task is unusual
- Notes should be one brief sentence justifying the estimate (e.g. "Similar to #3 and #7; added buffer for migration")
- No preamble, no markdown fences, no explanation outside the JSON`;

    let userPrompt = `Project: ${mapDetail.map.name}
Effort unit: ${effortUnit}

Past completed work (planned → actual):
${samplesText}

New item to estimate:
Title: "${targetText}"`;
    if (targetContext) userPrompt += `\nPath: ${targetContext}`;
    if (targetDescription) userPrompt += `\nDescription: ${targetDescription}`;
    if (body.hint) userPrompt += `\nHint: ${body.hint}`;
    userPrompt += '\n\nReturn the JSON.';

    try {
      const raw = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 512,
        jsonSchema: { name: 'estimate' },
      });

      const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        estimate: unknown;
        confidence: unknown;
        notes?: unknown;
      };

      const rawEstimate = typeof parsed.estimate === 'number' ? parsed.estimate : NaN;
      if (!Number.isFinite(rawEstimate) || rawEstimate < 0) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model did not return a usable numeric estimate' },
        });
      }

      const confidence =
        parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : 'low';
      const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : undefined;

      // Apply calibration: the LLM's output is in planning space; multiply by
      // the fudge factor so the caller sees a velocity-corrected estimate.
      const calibratedEstimate = Math.round(rawEstimate * fudgeFactor * 100) / 100;

      return {
        estimate: calibratedEstimate,
        rawEstimate,
        confidence,
        notes,
        samplesUsed: calibrationLeaves.length,
        fudgeFactor: Math.round(fudgeFactor * 100) / 100,
        effortUnit,
      };
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model returned invalid JSON' },
        });
      }
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/braindump/accept — create the proposed tree ───
  //
  // Request:  { mapId, parentId, tree: BraindumpNode[] }
  // Response: { createdCount: number }

  app.post('/api/ai/braindump/accept', async (req, reply) => {
    const body = req.body as {
      mapId: string;
      parentId: string;
      tree: BraindumpNode[];
    };

    if (!body.mapId || !body.parentId || !Array.isArray(body.tree) || body.tree.length === 0) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId, parentId, and non-empty tree required' },
      });
    }

    const userId = (req as any).userId ?? 'system';
    let createdCount = 0;

    async function createSubtree(parentId: string, items: BraindumpNode[]): Promise<void> {
      for (const item of items) {
        const hasChildren = item.children.length > 0;
        const node = await nodeDb.createNode({
          mapId: body.mapId,
          parentId,
          text: item.text,
          createdBy: userId,
          // Only set estimate on leaves — parents auto-compute from children
          effortEstimate: hasChildren ? undefined : (item.estimate ?? undefined),
        });
        createdCount++;
        broadcast(body.mapId, { type: 'node:created', node });
        scheduleEmbedNode(node.id);
        if (hasChildren) await createSubtree(node.id, item.children);
      }
    }

    try {
      await createSubtree(body.parentId, body.tree);
      return reply.status(201).send({ createdCount });
    } catch (err: any) {
      return reply.status(500).send({
        error: { code: 'CREATE_FAILED', message: err.message },
      });
    }
  });

  // ── POST /api/ai/refine_structure — critique a subtree's grouping ──
  //
  // Request:  { mapId, nodeId }
  // Response: { proposals: GroupProposal[], summary: string }
  //
  // Returns *proposals* (group-related siblings under a new category) for
  // an existing subtree. No mutations happen here — the client previews
  // the diff and re-uses bulk_create_nodes + bulk_update_nodes to apply.
  //
  // MVP: only `group` proposals. `move` / `rename` / `split` can layer on
  // later without changing the wire shape (proposals[].kind discriminator).

  app.post('/api/ai/refine_structure', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as { mapId: string; nodeId: string };

    if (!body.mapId || !body.nodeId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId and nodeId are required' },
      });
    }

    const mapDetail = await mapDb.getMap(body.mapId);
    if (!mapDetail) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    const targetNode = mapDetail.nodes.find((n) => n.id === body.nodeId);
    if (!targetNode) {
      return reply.status(404).send({
        error: { code: 'NODE_NOT_FOUND', message: `Node ${body.nodeId} not found` },
      });
    }

    const children = mapDetail.nodes.filter((n) => n.parentId === body.nodeId);
    if (children.length < 4) {
      // Not worth refining a small subtree — return an empty result so the
      // frontend can show "structure looks fine" without an extra LLM call.
      return { proposals: [], summary: 'Subtree is small enough to read at a glance — no grouping suggested.' };
    }

    // Tag each child with a short numeric index — far fewer tokens than
    // UUIDs and easier for the LLM to quote back accurately.
    const tags = new Map<string, number>();
    const idByTag = new Map<number, string>();
    children.forEach((c, i) => {
      const tag = i + 1;
      tags.set(c.id, tag);
      idByTag.set(tag, c.id);
    });

    const childrenList = children
      .map((c) => `  [${tags.get(c.id)}] ${c.text}`)
      .join('\n');

    // When the fanout is wide, the model has a tendency to propose 2-3
    // small "safe" groups and leave the rest. The "Prefer fewer, bigger
    // groups" rule below pushes it to actually consolidate.
    const aggressiveHint =
      children.length >= 20
        ? `\n- This subtree has ${children.length} children — prefer FEWER, LARGER groups (5–8 members each) over many small ones, and aim to cover as many siblings as possible across all groups.`
        : '';

    const systemPrompt = `You are a project structure reviewer. You look at a parent node and its direct children, and you propose groupings when the children would be easier to read with intermediate category nodes.

Rules:
- Return ONLY a JSON object: {"groups": [{"members": [<int tags>], "label": "...", "reason": "..."}], "summary": "..."}
- "members" is a list of integer tags identifying which existing children should be grouped together. Use the [N] tags from the input — do not invent new tags.
- "label" is the proposed category name (concise, descriptive: "Backend", "UX polish", etc.)
- "reason" is one short sentence justifying the grouping
- "summary" is one sentence on the overall structure (e.g. "Looks well-organized" or "Five children are clearly Backend tasks; the rest are unrelated")
- Only propose a group if ≥3 children share an obvious theme — small groups add noise
- A child must not appear in more than one group
- Do NOT propose any groups if the children are already balanced (≤6 total, or each clearly distinct)${aggressiveHint}
- No preamble, no markdown fences, no explanation outside the JSON`;

    const userPrompt = `Project: ${mapDetail.map.name}
Parent: "${targetNode.text}"
Direct children (${children.length}):
${childrenList}

Review the children and propose groupings.`;

    try {
      const raw = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 1024,
        jsonSchema: { name: 'refine_structure' },
      });

      const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        groups?: unknown;
        summary?: unknown;
      };

      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      const proposals: Array<{
        kind: 'group';
        memberIds: string[];
        suggestedLabel: string;
        reason: string;
      }> = [];

      if (Array.isArray(parsed.groups)) {
        const seenMembers = new Set<string>();
        for (const raw of parsed.groups) {
          if (!raw || typeof raw !== 'object') continue;
          const g = raw as Record<string, unknown>;
          const label = typeof g.label === 'string' ? g.label.trim() : '';
          const reason = typeof g.reason === 'string' ? g.reason.trim() : '';
          const memberTags = Array.isArray(g.members) ? g.members : [];
          const memberIds: string[] = [];
          for (const t of memberTags) {
            const tag = typeof t === 'number' ? t : Number(t);
            if (!Number.isInteger(tag)) continue;
            const id = idByTag.get(tag);
            if (!id || seenMembers.has(id)) continue;
            memberIds.push(id);
            seenMembers.add(id);
          }
          // Skip "groups" of fewer than 3 — that's not a meaningful regrouping.
          if (!label || memberIds.length < 3) continue;
          proposals.push({ kind: 'group', memberIds, suggestedLabel: label, reason });
        }
      }

      return { proposals, summary };
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model returned invalid JSON' },
        });
      }
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });

  // ── POST /api/ai/refine_structure/apply — apply accepted proposals ──
  //
  // Request:  { mapId, parentId, proposals: GroupProposal[] }
  // Response: { createdCount, movedCount }
  //
  // For each group proposal: create a new category node under parentId,
  // then reparent each member under the new category. Skips proposals
  // whose members reference unknown nodes (defensive against stale UI
  // state). No rollback — failures abort partway and return what landed.

  app.post('/api/ai/refine_structure/apply', async (req, reply) => {
    const body = req.body as {
      mapId: string;
      parentId: string;
      proposals: Array<{
        kind: 'group';
        memberIds: string[];
        suggestedLabel: string;
      }>;
    };

    if (
      !body.mapId ||
      !body.parentId ||
      !Array.isArray(body.proposals) ||
      body.proposals.length === 0
    ) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'mapId, parentId, and non-empty proposals array required',
        },
      });
    }

    const userId = (req as any).userId ?? 'system';
    let createdCount = 0;
    let movedCount = 0;

    try {
      for (const proposal of body.proposals) {
        if (proposal.kind !== 'group') continue;
        if (!proposal.suggestedLabel || proposal.memberIds.length < 2) continue;

        // 1. Create the category node under parentId.
        const category = await nodeDb.createNode({
          mapId: body.mapId,
          parentId: body.parentId,
          text: proposal.suggestedLabel,
          createdBy: userId,
        });
        createdCount++;
        broadcast(body.mapId, { type: 'node:created', node: category });
        scheduleEmbedNode(category.id);

        // 2. Reparent each member under the new category. moveNode handles
        //    the parent's children_order on both sides — plain updateNode
        //    leaves the old parent dangling.
        for (const memberId of proposal.memberIds) {
          const updated = await nodeDb.moveNode(memberId, category.id);
          if (updated) {
            movedCount++;
            broadcast(body.mapId, {
              type: 'node:updated',
              nodeId: memberId,
              fields: ['parentId'],
              node: updated,
            });
          }
        }
      }

      return reply.status(200).send({ createdCount, movedCount });
    } catch (err: any) {
      return reply.status(500).send({
        error: { code: 'APPLY_FAILED', message: err.message, createdCount, movedCount },
      });
    }
  });

  // ── POST /api/ai/standup — narrated daily standup ──────────────
  //
  // Request:  { mapId, sinceHours? }
  // Response: { narrative, recentlyChanged, inProgress, blocked }
  //
  // Aggregates recently-changed leaves, in-progress leaves, and behind
  // leaves, then asks the LLM to produce a short narrative standup.

  app.post('/api/ai/standup', async (req, reply) => {
    if (!requireOllama(reply)) return;
    const body = req.body as { mapId: string; sinceHours?: number };
    if (!body.mapId) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId is required' },
      });
    }

    const mapDetail = await mapDb.getMap(body.mapId);
    if (!mapDetail) {
      return reply.status(404).send({
        error: { code: 'MAP_NOT_FOUND', message: `Map ${body.mapId} not found` },
      });
    }

    const sinceHours = Math.max(1, Math.min(body.sinceHours ?? 24, 168));
    const cutoffMs = Date.now() - sinceHours * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const computed = computeTree(mapDetail.nodes, mapDetail.map.healthThreshold);
    const leaves = mapDetail.nodes.filter((n) => (n.childrenIds?.length ?? 0) === 0);
    const recentlyChanged = leaves.filter((n) => n.updatedAt > cutoffIso);
    const inProgress = leaves.filter(
      (n) => (n.percentComplete ?? 0) > 0 && (n.percentComplete ?? 0) < 100,
    );
    const blocked = leaves.filter((n) => computed.get(n.id)?.healthSignal === 'behind');

    const fmtLine = (n: typeof leaves[number]) => {
      const pct = Math.round(n.percentComplete ?? 0);
      const status = n.status ? ` [${n.status}]` : '';
      return `- ${n.text} — ${pct}%${status}`;
    };

    const sections: string[] = [];
    sections.push(`Recently changed (last ${sinceHours}h):`);
    sections.push(recentlyChanged.length === 0 ? '  (none)' : recentlyChanged.map(fmtLine).join('\n'));
    sections.push('');
    sections.push('In progress:');
    sections.push(inProgress.length === 0 ? '  (none)' : inProgress.map(fmtLine).join('\n'));
    sections.push('');
    sections.push('Blocked / behind:');
    sections.push(blocked.length === 0 ? '  (none)' : blocked.map(fmtLine).join('\n'));

    const systemPrompt = `You are a project assistant generating a daily standup update. You receive a structured snapshot of work and produce a concise narrative for the team.

Rules:
- Output plain text, NOT JSON or markdown headers
- Three short sections, each one paragraph: "Done:", "In progress:", "Blockers:"
- Be specific — name the items, don't paraphrase generically
- Keep the whole response under 150 words
- If a section has no items, say so in one short sentence
- No preamble, no closing remarks — just the three sections`;

    const userPrompt = `Project: ${mapDetail.map.name}

${sections.join('\n')}

Generate the standup.`;

    try {
      const narrative = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        maxTokens: 600,
      });

      return {
        narrative: narrative.trim(),
        recentlyChanged: recentlyChanged.length,
        inProgress: inProgress.length,
        blocked: blocked.length,
        sinceHours,
      };
    } catch (err: any) {
      return reply.status(502).send({
        error: { code: 'AI_ERROR', message: err.message },
      });
    }
  });
}
