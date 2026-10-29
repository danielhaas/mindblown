/**
 * Approval routes (#494) — the "Waiting for approval" rows on the Fleet
 * tab and the phone, and `list_pending_approvals` / `approve_ticket` /
 * `reject_ticket` for agents.
 *
 *   GET  /api/approvals                              — every map the reader can view
 *   GET  /api/maps/:id/approvals                     — one map
 *   GET  /api/fleets/:id/approvals                   — a fleet's maps the reader can view
 *   POST /api/maps/:id/nodes/:nodeId/approve         — { merge?, description? }
 *   POST /api/maps/:id/nodes/:nodeId/reject          — { note?, closeIssue? }
 *
 * Reads need view; each row says whether the reader may decide. A decision
 * needs edit and a place on the map's trusted list, and is refused to a
 * fleet key (services/approvals.ts).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ApproveInput, RejectInput } from '@mindblown/core';
import { approveTicket, listPendingApprovals, rejectTicket } from '../services/approvals.js';
import type { ApprovalError, ApprovalOutcome } from '../services/approvals.js';
import * as nodeDb from '../db/nodes.js';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { syncNodeToGitHub } from './nodes.js';
import { broadcast } from '../ws.js';

const fail = (reply: FastifyReply, e: ApprovalError) => reply.status(e.status).send({ error: { code: e.code, message: e.message } });

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
}

/** Tell open clients, push an edited description to the forge; the body both surfaces return. */
export function announceApproval(out: ApprovalOutcome) {
  broadcast(out.node.mapId, { type: 'node:updated', nodeId: out.node.id, fields: out.changedFields, node: out.node });
  // The approvals list refetches on asks:updated — the row leaves it.
  broadcast(out.node.mapId, { type: 'asks:updated', kind: 'approval', nodeId: out.node.id });
  if (out.changedFields.includes('description')) syncNodeToGitHub(out.node, out.changedFields).catch(() => {});
  return { approval: out.node.approval, writes: out.writes, ok: out.writes.every((w) => w.done) };
}

function sendOutcome(reply: FastifyReply, out: ApprovalOutcome | ApprovalError) {
  return 'status' in out ? fail(reply, out) : reply.send(announceApproval(out));
}

export async function approvalsRoutes(app: FastifyInstance): Promise<void> {
  // View on the map for the list, edit for a decision, :nodeId on that map (#403).
  guardMapRoutes(app, { nodeMapId: nodeDb.getNodeMapId });

  app.get('/api/approvals', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listPendingApprovals(req.userId, {});
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/maps/:id/approvals', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listPendingApprovals(req.userId, { mapId: req.params.id });
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  app.get<{ Params: { id: string } }>('/api/fleets/:id/approvals', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const out = await listPendingApprovals(req.userId, { fleetId: req.params.id });
    return 'status' in out ? fail(reply, out) : reply.send(out);
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: ApproveInput }>('/api/maps/:id/nodes/:nodeId/approve', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const body = (req.body ?? {}) as ApproveInput;
    return sendOutcome(reply, await approveTicket(req.userId, req.params.id, req.params.nodeId, { merge: body.merge, description: body.description }));
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: RejectInput }>('/api/maps/:id/nodes/:nodeId/reject', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const body = (req.body ?? {}) as RejectInput;
    return sendOutcome(reply, await rejectTicket(req.userId, req.params.id, req.params.nodeId, { note: body.note, closeIssue: body.closeIssue === true }));
  });
}
