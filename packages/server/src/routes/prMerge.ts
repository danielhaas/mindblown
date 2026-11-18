/**
 * A person merges a fleet PR through MindBlown (services/prMerge.ts).
 *
 *   GET  /api/maps/:id/nodes/:nodeId/pr        — pr_summary (view)
 *   POST /api/maps/:id/nodes/:nodeId/pr/merge  — merge_pr { expectedHeadSha, method? } (edit; a person on the trusted list)
 *   GET  /api/prs/waiting                      — prs_waiting, every map the reader can view
 *   GET  /api/maps/:id/prs/waiting             — one map
 *   GET  /api/fleets/:id/prs/waiting           — a fleet's maps the reader can view
 *
 * The merge takes a person's API key — Tracer, the voice avatar, calls it
 * with one after the person said yes. A fleet key is refused in the
 * service (users.kind), never by auth source.
 *
 * A refusal (head moved, CI red, conflicts …) is a 409 carrying
 * `{ merged: false, code, message }` so a client reads it like a result.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as nodeDb from '../db/nodes.js';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { mergePr, prSummary, prsWaiting, type PrMergeError } from '../services/prMerge.js';
import type { MergeMethod } from '@mindblown/integrations';

const fail = (reply: FastifyReply, e: PrMergeError) => reply.status(e.status).send({ error: { code: e.code, message: e.message } });
const unauthorized = (reply: FastifyReply) => reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });

export async function prMergeRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app, { nodeMapId: nodeDb.getNodeMapId });

  app.get<{ Params: { id: string; nodeId: string } }>('/api/maps/:id/nodes/:nodeId/pr', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await prSummary(req.params.id, req.params.nodeId);
    return 'code' in out ? fail(reply, out) : reply.send(out);
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: { expectedHeadSha?: unknown; method?: unknown } }>(
    '/api/maps/:id/nodes/:nodeId/pr/merge',
    async (req, reply) => {
      if (!req.userId) return unauthorized(reply);
      const body = req.body ?? {};
      const out = await mergePr(req.userId, req.params.id, req.params.nodeId, {
        expectedHeadSha: typeof body.expectedHeadSha === 'string' ? body.expectedHeadSha.trim() : '',
        method: typeof body.method === 'string' ? (body.method as MergeMethod) : undefined,
      });
      if ('merged' in out) {
        // A refusal also carries the usual `error` envelope, so a client that only reads errors sees why.
        return out.merged ? reply.send(out) : reply.status(409).send({ ...out, error: { code: out.code, message: out.message } });
      }
      return fail(reply, out);
    },
  );

  app.get('/api/prs/waiting', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await prsWaiting(req.userId, {});
    return 'code' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/maps/:id/prs/waiting', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await prsWaiting(req.userId, { mapId: req.params.id });
    return 'code' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id/prs/waiting', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await prsWaiting(req.userId, { fleetId: req.params.id });
    return 'code' in out ? fail(reply, out) : reply.send(out);
  });
}
