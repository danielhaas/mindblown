/**
 * Personal leave (#664) — the signed-in person's own days off:
 *
 *   GET    /api/me/leave       — { leave: LeaveRange[] }
 *   POST   /api/me/leave       — { startDate, endDate, note? } → the new range
 *   DELETE /api/me/leave/:id   — remove one of your ranges
 *
 * The scheduler applies them on every map whose work the person does (the
 * map's `workers`, or the node's assignee). Fleet service users do no human
 * work, so they have no leave.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { validateLeaveInput } from '@mindblown/core';
import * as leaveDb from '../db/leave.js';
import { isFleetUser } from '../db/fleets.js';

const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

export async function leaveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/leave', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    return reply.send({ leave: await leaveDb.listLeave(req.userId) });
  });

  app.post<{ Body: { startDate?: unknown; endDate?: unknown; note?: unknown } }>('/api/me/leave', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    if (await isFleetUser(req.userId)) return fail(reply, 403, 'FORBIDDEN', 'Fleet users take no leave');
    const body = req.body ?? {};
    const error = validateLeaveInput(body);
    if (error) return fail(reply, 400, 'VALIDATION_ERROR', error);
    const leave = await leaveDb.addLeave(req.userId, {
      startDate: body.startDate as string,
      endDate: body.endDate as string,
      note: (body.note as string | null | undefined) ?? null,
    });
    return reply.status(201).send(leave);
  });

  app.delete<{ Params: { id: string } }>('/api/me/leave/:id', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !(await leaveDb.removeLeave(req.userId, req.params.id))) {
      return fail(reply, 404, 'NOT_FOUND', `Leave ${req.params.id} not found`);
    }
    return reply.status(204).send();
  });
}
