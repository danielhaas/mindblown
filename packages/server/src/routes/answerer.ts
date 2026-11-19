/**
 * The signed-in person's answerer name — the name their asks are filed
 * under on the Questions card (core answererName). Null = first name.
 *
 *   GET /api/me/answerer-name   — { answererName, effective }
 *   PUT /api/me/answerer-name   — { answererName: string | null } → same
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { validateAnswererName } from '@mindblown/core';
import * as answererDb from '../db/answerer.js';

const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

export async function answererRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/answerer-name', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    const s = await answererDb.getAnswerer(req.userId);
    return s ? reply.send(s) : fail(reply, 404, 'USER_NOT_FOUND', 'User not found');
  });

  app.put<{ Body: { answererName?: unknown } }>('/api/me/answerer-name', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    const body = req.body ?? {};
    if (!('answererName' in body)) return fail(reply, 400, 'VALIDATION_ERROR', 'answererName is required (null clears it)');
    const error = validateAnswererName(body.answererName);
    if (error) return fail(reply, 400, 'VALIDATION_ERROR', error);
    const s = await answererDb.setAnswerer(req.userId, (body.answererName as string | null) ?? null);
    return s ? reply.send(s) : fail(reply, 404, 'USER_NOT_FOUND', 'User not found');
  });
}
