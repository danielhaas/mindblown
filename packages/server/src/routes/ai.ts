/**
 * AI routes — all behind /api/ai/*
 * Protected by the auth middleware registered earlier in the pipeline.
 */

import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { aiEnabled, aiConfig, chatCompletion, getClient as getAIClient } from '../ai/client.js';
import { CHAT_TOOLS, executeTool, renderTreeForPrompt } from '../ai/tools.js';
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
      scheduleEmbedNode(node.id);
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
      const systemPrompt = `You manage a project mindmap. Reply ONLY in English.

mapId = "${body.mapId}"

The root node is "${rootNode?.text ?? 'Root'}" with id "${rootId}".
When the user says "add X" without a parent, use parentId "${rootId}".

Current nodes:
${treeText}

Rules:
1. Only use IDs shown in [id:...] above. Never invent an ID.
2. For move_node: "source" is the node being moved, "destination" is where it goes.
3. One tool call per message. Confirm what you did in one short English sentence.
4. You cannot delete nodes.`;

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...body.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ];

      const client = getAIClient();
      const MUTATING_TOOLS = new Set(['create_node', 'update_node', 'move_node', 'delete_node']);
      let mutationDone = false;

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
          // Strip non-English text (qwen2.5 outputs Thai/Chinese despite instructions)
          // Remove any segment that contains non-Latin unicode characters
          const cleaned = msg.content
            .split('\n')
            .filter((line) => !/[\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF]/.test(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (cleaned) {
            send('delta', { content: cleaned });
          }
        }

        // If no tool calls, we're done
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          break;
        }

        // If we already did a mutation and the model is trying to call more tools,
        // stop the loop to prevent duplicates
        if (mutationDone) break;

        // Execute only the FIRST tool call to prevent chaotic multi-tool responses
        const tc = msg.tool_calls[0];

        // Add a sanitized assistant message with only the one tool call we'll execute
        messages.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: [tc],
        } as OpenAI.ChatCompletionMessageParam);
        {
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
            result = await executeTool(fnName, fnArgs, { userId, mapId: body.mapId });
          } catch (err: any) {
            result = `Error: ${err.message}`;
          }

          if (MUTATING_TOOLS.has(fnName)) mutationDone = true;

          send('tool_result', { id: tc.id, name: fnName, result });

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

  // ── GET /api/ai/search — semantic node search ─────────────────
  //
  // Query:    ?mapId=...&q=...&limit=10
  // Response: { matches: Array<{ nodeId, text, score }> }
  //
  // Uses cosine similarity over pre-computed node embeddings. Nodes
  // without an embedding are silently skipped — run /embeddings/backfill
  // first if coverage matters.

  app.get('/api/ai/search', async (req, reply) => {
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
      .sort((a, b) => {
        const au = a.updatedAt instanceof Date ? a.updatedAt.getTime() : Date.parse(a.updatedAt as unknown as string);
        const bu = b.updatedAt instanceof Date ? b.updatedAt.getTime() : Date.parse(b.updatedAt as unknown as string);
        return bu - au;
      })
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

  // ── POST /api/ai/standup — narrated daily standup ──────────────
  //
  // Request:  { mapId, sinceHours? }
  // Response: { narrative, recentlyChanged, inProgress, blocked }
  //
  // Aggregates recently-changed leaves, in-progress leaves, and behind
  // leaves, then asks the LLM to produce a short narrative standup.

  app.post('/api/ai/standup', async (req, reply) => {
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
