/**
 * Asks inbox routes — `/leidang-asks` in the browser.
 *
 *   PUT  /api/maps/:id/asks                 — the collector's push (orchestrator, every tick)
 *   GET  /api/maps/:id/asks                 — the inbox (?status=&hint=&answerer=&since=&limit=)
 *   POST /api/maps/:id/asks/:askId/answer   — answered | later | delegate (writes like apply)
 *   POST /api/maps/:id/asks/worker-ack      — the fleet delivered the worker notes
 *
 * Auth: a signed-in user (session or API key). Push, answer and ack need
 * edit on the map — the answer writes nodes and GitHub; the push is the
 * orchestrator's own API key, the same one that writes the knobs.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { countAsks, parseAskDocument, sortAsks } from '@mindblown/core';
import type { AskAnswerInput, AskStatus } from '@mindblown/core';
import * as asksDb from '../db/asks.js';
import * as permDb from '../db/permissions.js';
import { answerAsk, AskNotFoundError, AskValidationError } from '../services/asks.js';
import { syncNodeToGitHub } from './nodes.js';
import { broadcast } from '../ws.js';

/** 135 items × ~2 kB today; room for the whole backlog, not for abuse. */
const PUSH_BODY_LIMIT = 4 * 1024 * 1024;
const STATUSES = new Set<string>(['open', 'answered', 'later', 'delegated', 'all']);

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
}

async function requirePermission(
  req: { userId?: string },
  reply: FastifyReply,
  mapId: string,
  level: 'view' | 'edit',
): Promise<boolean> {
  if (!req.userId) {
    unauthorized(reply);
    return false;
  }
  const perm = await permDb.getPermission(mapId, req.userId);
  if (!permDb.hasPermission(perm, level)) {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: `${level === 'edit' ? 'Edit' : 'View'} access required` } });
    return false;
  }
  return true;
}

export async function asksRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { id: string } }>('/api/maps/:id/asks', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const doc = parseAskDocument(req.body);
    if (!doc) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Body must be a leidang-asks-collect document: { meta, items[] } with id + question per item' },
      });
    }
    if (doc.meta.map_id && doc.meta.map_id !== req.params.id) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Document is for map ${doc.meta.map_id}, not ${req.params.id}` },
      });
    }
    let result;
    try {
      result = await asksDb.replaceAsks(req.params.id, doc.items, doc.meta);
    } catch (err) {
      if ((err as { code?: string }).code === '23503') {
        return reply.status(404).send({ error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.id} not found` } });
      }
      throw err;
    }
    broadcast(req.params.id, { type: 'asks:updated', kind: 'push', pushedAt: result.pushedAt });
    return reply.send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; hint?: string; answerer?: string; since?: string; limit?: string } }>(
    '/api/maps/:id/asks',
    async (req, reply) => {
      if (!(await requirePermission(req, reply, req.params.id, 'view'))) return;
      const { status, hint, answerer, since, limit } = req.query;
      if (status !== undefined && !STATUSES.has(status)) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'status must be open | answered | later | delegated | all' } });
      }
      const lim = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
      const [rows, push] = await Promise.all([
        asksDb.listAsks(req.params.id, {
          status: (status as AskStatus | 'all' | undefined) ?? 'open',
          hint,
          answerer,
          since,
          limit: lim !== undefined && Number.isFinite(lim) && lim > 0 ? lim : undefined,
        }),
        asksDb.getPushMeta(req.params.id),
      ]);
      const items = sortAsks(rows);
      return reply.send({
        items,
        counts: countAsks(items),
        pushedAt: push?.pushedAt ?? null,
        meta: push?.meta ?? null,
        now: new Date().toISOString(),
      });
    },
  );

  app.post<{ Params: { id: string; askId: string }; Body: AskAnswerInput }>('/api/maps/:id/asks/:askId/answer', async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const body = (req.body ?? {}) as AskAnswerInput;
    try {
      const out = await answerAsk(req.params.id, req.params.askId, body, req.userId ?? null);
      if (out.node) {
        broadcast(req.params.id, { type: 'node:updated', nodeId: out.node.id, fields: out.changedFields, node: out.node });
        syncNodeToGitHub(out.node, out.changedFields).catch(() => {});
      }
      broadcast(req.params.id, { type: 'asks:updated', kind: 'answer', askId: req.params.askId, status: out.row.status });
      return reply.send({ ask: out.row, plan: out.plan, ok: out.ok, node: out.node ? { id: out.node.id, status: out.node.status } : null });
    } catch (err) {
      if (err instanceof AskNotFoundError) {
        return reply.status(404).send({ error: { code: 'ASK_NOT_FOUND', message: err.message } });
      }
      if (err instanceof AskValidationError) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: { askIds?: unknown } }>('/api/maps/:id/asks/worker-ack', async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const ids = Array.isArray(req.body?.askIds) ? req.body.askIds.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'askIds[] required' } });
    }
    const cleared = await asksDb.clearWorkerPending(req.params.id, ids);
    if (cleared > 0) broadcast(req.params.id, { type: 'asks:updated', kind: 'worker-ack', cleared });
    return reply.send({ cleared });
  });
}
