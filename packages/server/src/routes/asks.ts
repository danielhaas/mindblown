/**
 * Asks inbox routes — `/leidang-asks` in the browser. Keyed by fleet since
 * #479; the map routes forward to the map's fleet and see that map's asks.
 *
 *   PUT  /api/maps/:id/asks                 — the collector's push for one map (orchestrator, every tick)
 *   GET  /api/maps/:id/asks                 — the map's inbox (?status=&hint=&answerer=&since=&limit=)
 *   POST /api/maps/:id/asks/:askId/answer   — answered | later | delegate (writes like apply)
 *   POST /api/maps/:id/asks/worker-ack      — the fleet delivered the worker notes
 *
 *   PUT  /api/fleets/:id/asks               — a fleet-wide collector's push (items carry map_id)
 *   GET  /api/fleets/:id/asks               — the fleet's inbox, every map the reader can view
 *   POST /api/fleets/:id/asks/:askId/answer — ?mapId= picks the map when two share an ask id
 *   POST /api/fleets/:id/asks/worker-ack
 *
 * Auth: a signed-in user (session or API key). On the map routes push,
 * answer and ack need edit on the map — the answer writes nodes and
 * GitHub; the push is the orchestrator's own API key, the same one that
 * writes the knobs. A push for a map without a fleet is a 409.
 * On the fleet routes the read follows the fleet read rule (asks on maps
 * the reader can't view are left out; fleet-level asks need a reader of
 * every map). Push and ack need the fleet owner or edit on every map of the
 * fleet; an answer needs edit on the ask's map, or that for a fleet-level ask.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseAskDocument } from '@mindblown/core';
import type { AskAnswerInput, AskStatus } from '@mindblown/core';
import * as asksDb from '../db/asks.js';
import * as fleetEntityDb from '../db/fleets.js';
import * as permDb from '../db/permissions.js';
import { answerAsk, AskNotFoundError, AskValidationError } from '../services/asks.js';
import { fleetInbox, mapInbox, resolveFleetAnswer } from '../services/asksInbox.js';
import { authorizeTickPush } from '../services/fleetTelemetry.js';
import { syncNodeToGitHub } from './nodes.js';
import { broadcast } from '../ws.js';

/** 135 items × ~2 kB today; room for the whole backlog, not for abuse. */
const PUSH_BODY_LIMIT = 4 * 1024 * 1024;
const STATUSES = new Set<string>(['open', 'answered', 'later', 'delegated', 'all']);

type ListQuery = { status?: string; hint?: string; answerer?: string; since?: string; limit?: string };

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
}

const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

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

/** Same query rules for both inbox reads; null = the 400 was sent. */
function parseList(q: ListQuery, reply: FastifyReply): asksDb.AskListFilters | null {
  if (q.status !== undefined && !STATUSES.has(q.status)) {
    fail(reply, 400, 'VALIDATION_ERROR', 'status must be open | answered | later | delegated | all');
    return null;
  }
  const lim = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;
  return {
    status: (q.status as AskStatus | 'all' | undefined) ?? 'open',
    hint: q.hint,
    answerer: q.answerer,
    since: q.since,
    limit: lim !== undefined && Number.isFinite(lim) && lim > 0 ? lim : undefined,
  };
}

async function broadcastFleetMaps(fleetId: string, event: Record<string, unknown>): Promise<void> {
  for (const m of await fleetEntityDb.listFleetMaps(fleetId)) broadcast(m.id, event);
}

async function sendAnswer(reply: FastifyReply, key: asksDb.AskKey, body: AskAnswerInput, userId: string | null) {
  try {
    const out = await answerAsk(key, body, userId);
    if (out.node) {
      broadcast(out.node.mapId, { type: 'node:updated', nodeId: out.node.id, fields: out.changedFields, node: out.node });
      syncNodeToGitHub(out.node, out.changedFields).catch(() => {});
    }
    const event = { type: 'asks:updated', kind: 'answer', askId: key.askId, status: out.row.status };
    if (key.mapId) broadcast(key.mapId, event);
    else await broadcastFleetMaps(key.fleetId, event);
    return reply.send({ ask: out.row, plan: out.plan, ok: out.ok, node: out.node ? { id: out.node.id, status: out.node.status } : null });
  } catch (err) {
    if (err instanceof AskNotFoundError) return fail(reply, 404, 'ASK_NOT_FOUND', err.message);
    if (err instanceof AskValidationError) return fail(reply, 400, 'VALIDATION_ERROR', err.message);
    throw err;
  }
}

function askIdsOf(body: { askIds?: unknown } | undefined): string[] {
  return Array.isArray(body?.askIds) ? body.askIds.filter((x): x is string => typeof x === 'string') : [];
}

export async function asksRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { id: string } }>('/api/maps/:id/asks', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const doc = parseAskDocument(req.body);
    if (!doc) {
      return fail(reply, 400, 'VALIDATION_ERROR', 'Body must be a leidang-asks-collect document: { meta, items[] } with id + question per item');
    }
    if (doc.meta.map_id && doc.meta.map_id !== req.params.id) {
      return fail(reply, 400, 'VALIDATION_ERROR', `Document is for map ${doc.meta.map_id}, not ${req.params.id}`);
    }
    const fleetId = await fleetEntityDb.getMapFleetId(req.params.id);
    if (!fleetId) {
      return fail(reply, 409, 'NO_FLEET', `Map ${req.params.id} is not connected to a fleet. Connect it first (map Settings → Fleet, or update_map fleetId), then push again.`);
    }
    // Through a map route every item belongs to that map.
    const result = await asksDb.replaceAsks(fleetId, req.params.id, doc.items.map((ask) => ({ ask, mapId: req.params.id })), doc.meta);
    broadcast(req.params.id, { type: 'asks:updated', kind: 'push', pushedAt: result.pushedAt });
    return reply.send({ ...result, fleetId });
  });

  app.get<{ Params: { id: string }; Querystring: ListQuery }>('/api/maps/:id/asks', async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'view'))) return;
    const filters = parseList(req.query, reply);
    if (!filters) return;
    return reply.send(await mapInbox(req.userId!, req.params.id, filters));
  });

  app.post<{ Params: { id: string; askId: string }; Body: AskAnswerInput }>('/api/maps/:id/asks/:askId/answer', async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const fleetId = await fleetEntityDb.getMapFleetId(req.params.id);
    if (!fleetId) return fail(reply, 404, 'ASK_NOT_FOUND', `Ask ${req.params.askId} not found`);
    return sendAnswer(reply, { fleetId, mapId: req.params.id, askId: req.params.askId }, (req.body ?? {}) as AskAnswerInput, req.userId ?? null);
  });

  app.post<{ Params: { id: string }; Body: { askIds?: unknown } }>('/api/maps/:id/asks/worker-ack', async (req, reply) => {
    if (!(await requirePermission(req, reply, req.params.id, 'edit'))) return;
    const ids = askIdsOf(req.body);
    if (ids.length === 0) return fail(reply, 400, 'VALIDATION_ERROR', 'askIds[] required');
    const fleetId = await fleetEntityDb.getMapFleetId(req.params.id);
    const cleared = fleetId ? await asksDb.clearWorkerPending(fleetId, req.params.id, ids) : 0;
    if (cleared > 0) broadcast(req.params.id, { type: 'asks:updated', kind: 'worker-ack', cleared });
    return reply.send({ cleared });
  });

  // ── Fleet routes (#479) ─────────────────────────────────────────

  app.put<{ Params: { id: string } }>('/api/fleets/:id/asks', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    // The orchestrator writes every project's inbox: owner, or edit on all of them.
    const denied = await authorizeTickPush(req.userId, req.params.id);
    if (denied) return fail(reply, denied.status, denied.code, denied.message);
    const doc = parseAskDocument(req.body);
    if (!doc) {
      return fail(reply, 400, 'VALIDATION_ERROR', 'Body must be a leidang-asks-collect document: { meta, items[] } with id + question per item (map_id per item, none for a fleet-level ask)');
    }
    const connected = new Set((await fleetEntityDb.listFleetMaps(req.params.id)).map((m) => m.id));
    const stray = [...new Set(doc.items.map((a) => a.map_id).filter((m): m is string => !!m && !connected.has(m)))];
    if (stray.length > 0) return fail(reply, 400, 'VALIDATION_ERROR', `Items name maps not connected to this fleet: ${stray.join(', ')}`);
    const result = await asksDb.replaceAsks(req.params.id, null, doc.items.map((ask) => ({ ask, mapId: ask.map_id ?? null })), doc.meta);
    await broadcastFleetMaps(req.params.id, { type: 'asks:updated', kind: 'push', pushedAt: result.pushedAt });
    return reply.send({ ...result, fleetId: req.params.id });
  });

  app.get<{ Params: { id: string }; Querystring: ListQuery }>('/api/fleets/:id/asks', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const filters = parseList(req.query, reply);
    if (!filters) return;
    const out = await fleetInbox(req.userId, req.params.id, filters);
    return 'status' in out ? fail(reply, out.status, out.code, out.message) : reply.send(out);
  });

  app.post<{ Params: { id: string; askId: string }; Querystring: { mapId?: string }; Body: AskAnswerInput }>(
    '/api/fleets/:id/asks/:askId/answer',
    async (req, reply) => {
      if (!req.userId) return unauthorized(reply);
      const key = await resolveFleetAnswer(req.userId, req.params.id, req.params.askId, req.query.mapId);
      if ('status' in key) return fail(reply, key.status, key.code, key.message);
      return sendAnswer(reply, key, (req.body ?? {}) as AskAnswerInput, req.userId);
    },
  );

  app.post<{ Params: { id: string }; Body: { askIds?: unknown } }>('/api/fleets/:id/asks/worker-ack', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const denied = await authorizeTickPush(req.userId, req.params.id);
    if (denied) return fail(reply, denied.status, denied.code, denied.message);
    const ids = askIdsOf(req.body);
    if (ids.length === 0) return fail(reply, 400, 'VALIDATION_ERROR', 'askIds[] required');
    const cleared = await asksDb.clearWorkerPending(req.params.id, null, ids);
    if (cleared > 0) await broadcastFleetMaps(req.params.id, { type: 'asks:updated', kind: 'worker-ack', cleared });
    return reply.send({ cleared });
  });
}
