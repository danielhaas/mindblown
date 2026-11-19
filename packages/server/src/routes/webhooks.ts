/**
 * Outgoing webhooks — subscribe a URL to a map's (or its whole
 * workspace's) events. Delivery, signing and retries: services/webhooks.
 *
 *   GET    /api/maps/:id/webhooks             → the map's subscriptions + its workspace's
 *   POST   /api/maps/:id/webhooks             → { url, events?, scope?: 'map'|'workspace', description?, secret? }
 *                                               201 with the secret — shown this once
 *   PATCH  /api/maps/:id/webhooks/:webhookId  → { url?, events?, active?, description? }
 *   DELETE /api/maps/:id/webhooks/:webhookId
 *   POST   /api/maps/:id/webhooks/:webhookId/ping → one signed `ping` now, no retries
 *
 * Every route needs admin on the map (#403 guard): a subscription sends
 * the map's activity to a URL of the caller's choosing. A workspace-wide
 * one also needs the workspace owner (it hears maps the caller may not
 * see) — the service checks that.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import {
  createWebhook,
  deleteWebhook,
  getWebhookForMap,
  listWebhooks,
  pingWebhook,
  updateWebhook,
  WebhookForbiddenError,
  WebhookValidationError,
  type CreateWebhookInput,
} from '../services/webhooks.js';

const ADMIN = { config: { mapAccess: 'admin' as const } };

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WebhookValidationError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
  if (err instanceof WebhookForbiddenError) return reply.status(403).send({ error: { code: 'FORBIDDEN', message: err.message } });
  throw err;
}

const notFound = (reply: FastifyReply, id: string) =>
  reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Webhook ${id} not found` } });

type One = { Params: { id: string; webhookId: string } };

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app);

  app.get<{ Params: { id: string } }>('/api/maps/:id/webhooks', ADMIN, async (req, reply) => {
    return reply.send({ webhooks: await listWebhooks(req.params.id) });
  });

  app.post<{ Params: { id: string }; Body: CreateWebhookInput }>('/api/maps/:id/webhooks', ADMIN, async (req, reply) => {
    try {
      const sub = await createWebhook(req.params.id, (req.body ?? {}) as CreateWebhookInput, req.userId ?? null);
      return reply.status(201).send({ webhook: sub });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<One & { Body: Record<string, unknown> }>('/api/maps/:id/webhooks/:webhookId', ADMIN, async (req, reply) => {
    const sub = await getWebhookForMap(req.params.id, req.params.webhookId);
    if (!sub) return notFound(reply, req.params.webhookId);
    try {
      const updated = await updateWebhook(sub, req.body ?? {}, req.userId ?? null);
      return updated ? reply.send({ webhook: updated }) : notFound(reply, req.params.webhookId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<One>('/api/maps/:id/webhooks/:webhookId', ADMIN, async (req, reply) => {
    const sub = await getWebhookForMap(req.params.id, req.params.webhookId);
    if (!sub) return notFound(reply, req.params.webhookId);
    try {
      await deleteWebhook(sub, req.userId ?? null);
      return reply.send({ deleted: true, id: sub.id });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<One>('/api/maps/:id/webhooks/:webhookId/ping', ADMIN, async (req, reply) => {
    const sub = await getWebhookForMap(req.params.id, req.params.webhookId);
    if (!sub) return notFound(reply, req.params.webhookId);
    const result = await pingWebhook(sub.id, req.params.id);
    return result ? reply.send({ delivered: result.ok, status: result.status, error: result.error }) : notFound(reply, req.params.webhookId);
  });
}
