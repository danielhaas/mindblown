/**
 * The reporter's check (services/reporterCheck.ts): an outside reporter
 * checks the deployed fix before their issue closes.
 *
 *   GET  /api/reporter-checks                                      — every map the reader can view
 *   GET  /api/maps/:id/reporter-checks                             — one map
 *   GET  /api/fleets/:id/reporter-checks                           — a fleet's maps the reader can view
 *   POST /api/maps/:id/deployed                                    — the map was deployed: ask the waiting reporters
 *   POST /api/maps/:id/nodes/:nodeId/reporter-check/reopen         — { note } the fix did not do it
 *   POST /api/maps/:id/nodes/:nodeId/reporter-check/close          — close the issue without the reporter
 *
 * `deployed` takes an API key: a project's deploy script calls it. It
 * only asks reporters — it reads no untrusted text. Reopen and close need
 * a web session, like approving (#606): deciding means reading the
 * reporter's reply, and that text can talk to an agent.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ReopenAfterCheckInput } from '@mindblown/core';
import { closeAfterCheck, listReporterChecks, markDeployed, reopenAfterCheck } from '../services/reporterCheck.js';
import type { CheckOutcome } from '../services/reporterCheck.js';
import type { ApprovalError } from '../services/approvals.js';
import * as nodeDb from '../db/nodes.js';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { isAgentRequest } from '../auth.js';
import { broadcast } from '../ws.js';

const fail = (reply: FastifyReply, e: ApprovalError) => reply.status(e.status).send({ error: { code: e.code, message: e.message } });
const unauthorized = (reply: FastifyReply) => reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
const needsSession = (reply: FastifyReply) =>
  reply.status(403).send({
    error: { code: 'CHECK_NEEDS_SESSION', message: "Reopening or closing after the reporter's check needs a web session, not an API key — use the card on the Fleet tab." },
  });

function sendOutcome(reply: FastifyReply, out: CheckOutcome | ApprovalError) {
  if ('status' in out) return fail(reply, out);
  if (out.changedFields.length > 0) broadcast(out.node.mapId, { type: 'node:updated', nodeId: out.node.id, fields: out.changedFields, node: out.node });
  broadcast(out.node.mapId, { type: 'asks:updated', kind: 'reporter-check', nodeId: out.node.id });
  return reply.send({ writes: out.writes, ok: out.writes.every((w) => w.done) });
}

export async function reporterChecksRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app, { nodeMapId: nodeDb.getNodeMapId });

  app.get('/api/reporter-checks', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listReporterChecks(req.userId, {});
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/maps/:id/reporter-checks', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listReporterChecks(req.userId, { mapId: req.params.id });
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id/reporter-checks', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listReporterChecks(req.userId, { fleetId: req.params.id });
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  // Edit on the map (the route guard). No body needed.
  app.post<{ Params: { id: string } }>('/api/maps/:id/deployed', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await markDeployed(req.params.id);
    if (out.asked.length > 0) broadcast(req.params.id, { type: 'asks:updated', kind: 'reporter-check' });
    return reply.send({ ...out, ok: out.failed.length === 0 });
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: ReopenAfterCheckInput }>('/api/maps/:id/nodes/:nodeId/reporter-check/reopen', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    if (isAgentRequest(req)) return needsSession(reply);
    const body = (req.body ?? {}) as ReopenAfterCheckInput;
    return sendOutcome(reply, await reopenAfterCheck(req.userId, req.params.id, req.params.nodeId, { note: body.note }));
  });

  app.post<{ Params: { id: string; nodeId: string } }>('/api/maps/:id/nodes/:nodeId/reporter-check/close', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    if (isAgentRequest(req)) return needsSession(reply);
    return sendOutcome(reply, await closeAfterCheck(req.userId, req.params.id, req.params.nodeId));
  });
}
