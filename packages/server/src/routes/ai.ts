/**
 * AI routes — all behind /api/ai/*
 * Protected by the auth middleware registered earlier in the pipeline.
 */

import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { aiEnabled, aiConfig, chatCompletion, getClient as getAIClient } from '../ai/client.js';
import { CHAT_TOOLS, executeTool } from '../ai/tools.js';
import * as nodeDb from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import { broadcast } from '../ws.js';
import type { Node as CoreNode } from '@mindblown/core';

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
}

// ── Routes ───────────────────────────────────────────────────────

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // Gate: if AI is not configured, register a single catch-all that explains why
  if (!aiEnabled) {
    app.all('/api/ai/*', async (_req, reply) => {
      return reply.status(503).send({
        error: { code: 'AI_NOT_CONFIGURED', message: 'AI features require AI_BASE_URL env var' },
      });
    });
    return;
  }

  // ── Config / health ────────────────────────────────────────────
  app.get('/api/ai/config', async () => {
    return aiConfig();
  });

  // ── Ping — quick round-trip to the LLM to verify connectivity ─
  app.get('/api/ai/ping', async (_req, reply) => {
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

    // Build prompt
    const systemPrompt = `You are a project planning assistant. You help break down work items into smaller, actionable subtasks.

Rules:
- Return ONLY a JSON object: {"tasks": [{"text": "...", "estimate": <number or null>}]}
- Each task text should be a concise, actionable work item (imperative mood, no numbering)
- Estimates are in ${effortUnit}. Use null if you can't estimate confidently.
- Tasks should be roughly equal-sized — each small enough to complete in 1-3 ${effortUnit}
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
      const parsed = JSON.parse(cleaned) as { tasks: BreakdownSuggestion[] };

      if (!Array.isArray(parsed.tasks)) {
        return reply.status(502).send({
          error: { code: 'AI_BAD_RESPONSE', message: 'Model did not return a valid tasks array' },
        });
      }

      // Sanitize: clamp estimates, enforce string text
      const suggestions: BreakdownSuggestion[] = parsed.tasks
        .slice(0, count)
        .map((t) => ({
          text: String(t.text).trim(),
          estimate: typeof t.estimate === 'number' && t.estimate > 0 ? t.estimate : null,
        }))
        .filter((t) => t.text.length > 0);

      return { suggestions };
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

    for (const task of body.tasks) {
      const node = await nodeDb.createNode({
        mapId: body.mapId,
        parentId: body.parentId,
        text: task.text,
        createdBy: userId,
        effortEstimate: task.estimate ?? undefined,
      });
      created.push(node);
      broadcast(body.mapId, { type: 'node:created', node });
    }

    return reply.status(201).send({ created });
  });

  // ── POST /api/ai/chat — conversational chat with tool use ──────
  //
  // Request:  { mapId, messages: ChatMessage[] }
  // Response: SSE stream of { type: 'delta'|'tool_call'|'tool_result'|'done'|'error', ... }
  //
  // The endpoint runs a tool-use loop: the model can call tools, we execute
  // them, feed results back, and let the model continue — up to MAX_STEPS
  // iterations to prevent runaway loops on the 14B model.

  const MAX_STEPS = 6;
  const AI_MODEL = process.env.AI_MODEL ?? 'qwen2.5:14b';

  app.post('/api/ai/chat', async (req, reply) => {
    const body = req.body as {
      mapId: string;
      messages: Array<{ role: string; content: string }>;
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

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Build the messages array with system prompt
      const systemPrompt = `You are an AI assistant embedded in MindBlown, a mindmap-based project management tool. You help users manage their project by creating, moving, updating, and deleting nodes in their mindmap.

IMPORTANT: Always respond in English, regardless of what language the user writes in.

Current map ID: ${body.mapId}

Rules:
- Be action-oriented. When the user asks you to do something, DO IT immediately — don't ask clarifying questions unless truly ambiguous (e.g. there are two nodes with the same name).
- Always call get_map FIRST to see the current tree structure and find correct node IDs.
- When referring to nodes, use their exact IDs from get_map — never guess IDs.
- If the user says "add X" without specifying a parent, add it under the root node.
- If the user refers to a node by name, use search_nodes or get_map to find its ID, then act.
- After making changes, briefly confirm what you did in one sentence.
- For questions about the project, use get_map to read the tree and answer based on the data.
- Keep responses concise. No unnecessary questions.`;

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...body.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ];

      const client = getAIClient();

      // Tool-use loop
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await client.chat.completions.create({
          model: AI_MODEL,
          messages,
          tools: CHAT_TOOLS,
          temperature: 0.3,
          max_tokens: 2048,
        });

        const choice = response.choices[0];
        if (!choice) break;

        const msg = choice.message;

        // If the model produced text content, stream it
        if (msg.content) {
          send('delta', { content: msg.content });
        }

        // If no tool calls, we're done
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          break;
        }

        // Add the assistant message (with tool_calls) to history
        messages.push(msg);

        // Execute each tool call
        for (const tc of msg.tool_calls) {
          const fn = (tc as any).function as { name: string; arguments: string };
          const fnName = fn.name;
          let fnArgs: Record<string, unknown>;
          try {
            fnArgs = JSON.parse(fn.arguments);
          } catch {
            fnArgs = {};
          }

          send('tool_call', { id: tc.id, name: fnName, args: fnArgs });

          let result: string;
          try {
            result = await executeTool(fnName, fnArgs, { userId });
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }

          send('tool_result', { id: tc.id, name: fnName, result: JSON.parse(result) });

          // Feed the tool result back to the model
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }

        // If the model said stop (not a tool call), break
        if (choice.finish_reason === 'stop') break;
      }

      send('done', {});
    } catch (err: any) {
      send('error', { message: err.message });
    } finally {
      reply.raw.end();
    }
  });
}
