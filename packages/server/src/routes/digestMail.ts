/**
 * The daily mail's switch (#597, services/digestMail.ts):
 *
 *   GET /api/me/digest-mail  — { enabled }
 *   PUT /api/me/digest-mail  — { enabled: boolean }
 *
 * The signed-in person's own setting. Fleet service users get no mail, so
 * they have no switch.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as digestDb from '../db/digestMails.js';
import { isFleetUser } from '../db/fleets.js';

const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

export async function digestMailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/digest-mail', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    if (await isFleetUser(req.userId)) return fail(reply, 403, 'FORBIDDEN', 'Fleet users get no daily mail');
    return reply.send({ enabled: await digestDb.getDigestMailEnabled(req.userId) });
  });

  app.put<{ Body: { enabled?: unknown } }>('/api/me/digest-mail', async (req, reply) => {
    if (!req.userId) return fail(reply, 401, 'UNAUTHORIZED', 'Not authenticated');
    if (await isFleetUser(req.userId)) return fail(reply, 403, 'FORBIDDEN', 'Fleet users get no daily mail');
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return fail(reply, 400, 'VALIDATION_ERROR', 'enabled must be a boolean');
    await digestDb.setDigestMailEnabled(req.userId, enabled);
    return reply.send({ enabled });
  });
}
