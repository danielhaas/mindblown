/**
 * The repo webhook of a workspace's forge binding (#386):
 *
 *   GET  /api/integrations/forge/webhook?workspaceId=  → what to configure + whether the repo has it
 *   POST /api/integrations/forge/webhook { workspaceId } → create / re-arm it (generates the secret if none)
 *
 * Same gate as binding the repo: a MindBlown admin, the workspace owner or
 * a map admin of the workspace. A GitHub App binding has the App's webhook
 * and is not handled here. The secret never leaves the server.
 */

import type { FastifyInstance } from 'fastify';
import { getForgeIntegration } from '../lib/githubContext.js';
import {
  NO_PUBLIC_URL_REASON,
  publicWebhookUrl,
  readForgeWebhook,
  setUpWebhookAfterBind,
  WEBHOOK_EVENTS,
} from '../lib/forgeWebhook.js';
import { canManageWorkspaceForge } from './auth-gitea.js';

type AuthedRequest = { userId?: string; authSource?: 'jwt' | 'api-key' };

export async function forgeWebhookRoutes(app: FastifyInstance): Promise<void> {
  /** The workspace's forge row, or the reply already sent. */
  async function bindingFor(req: AuthedRequest, workspaceId: string | undefined, reply: import('fastify').FastifyReply) {
    if (!workspaceId) {
      reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'workspaceId is required' } });
      return null;
    }
    if (!(await canManageWorkspaceForge(req, workspaceId))) {
      reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only a workspace or MindBlown admin may manage the forge webhook' } });
      return null;
    }
    const row = await getForgeIntegration(workspaceId);
    if (!row) {
      reply.status(404).send({ error: { code: 'NOT_CONNECTED', message: 'No forge connected to this workspace' } });
      return null;
    }
    return row;
  }

  app.get('/api/integrations/forge/webhook', async (req, reply) => {
    const row = await bindingFor(req as AuthedRequest, (req.query as { workspaceId?: string }).workspaceId, reply);
    if (!row) return reply;
    const url = publicWebhookUrl();
    const base = {
      kind: row.provider,
      repo: `${row.config.owner}/${row.config.repo}`,
      url,
      contentType: 'application/json',
      events: WEBHOOK_EVENTS[row.provider === 'gitea' ? 'gitea' : 'github'],
      secretStored: !!row.config.webhookSecret,
      hook: null,
    };
    if (!url) return reply.send({ ...base, readError: NO_PUBLIC_URL_REASON });
    try {
      return reply.send({ ...base, ...(await readForgeWebhook(row, url)) });
    } catch (err) {
      // Listing hooks needs repo admin; without it the instructions still help.
      return reply.send({ ...base, readError: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/integrations/forge/webhook', async (req, reply) => {
    const row = await bindingFor(req as AuthedRequest, ((req.body ?? {}) as { workspaceId?: string }).workspaceId, reply);
    if (!row) return reply;
    // 200 with `status: 'failed'` + reason/hint: the forge refusing is an
    // answer the dialog shows, not an error of this route.
    return reply.send(await setUpWebhookAfterBind(row));
  });
}
