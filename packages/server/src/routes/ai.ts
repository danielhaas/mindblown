/**
 * AI routes — all behind /api/ai/*
 * Protected by the auth middleware registered earlier in the pipeline.
 */

import type { FastifyInstance } from 'fastify';
import { aiEnabled, aiConfig, chatCompletion } from '../ai/client.js';
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
}
