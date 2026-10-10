/**
 * The repo webhook of a workspace's forge binding (#386):
 *
 *   GET  /api/integrations/forge/webhook?workspaceId=  → what to configure + whether the repo has it
 *   POST /api/integrations/forge/webhook { workspaceId } → create / re-arm it (generates the secret if none)
 *
 * Same gate as binding the repo: a MindBlown admin, the workspace owner or
 * a map admin of the workspace. A GitHub App binding has the App's webhook
 * and is not handled here.
 */

import type { FastifyInstance } from 'fastify';
import { getForgeIntegration } from '../lib/githubContext.js';
import { ensureForgeWebhook, publicWebhookUrl, readForgeWebhook, WEBHOOK_EVENTS } from '../lib/forgeWebhook.js';
import { canManageWorkspaceForge } from './auth-gitea.js';

type AuthedRequest = { userId?: string; authSource?: 'jwt' | 'api-key' };

export async function forgeWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/integrations/forge/webhook', async (req, reply) => {
    const { workspaceId } = req.query as { workspaceId?: string };
    if (!workspaceId) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'workspaceId is required' } });
    }
    if (!(await canManageWorkspaceForge(req as AuthedRequest, workspaceId))) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only a workspace or MindBlown admin may manage the forge webhook' } });
    }
    const row = await getForgeIntegration(workspaceId);
    if (!row) return reply.status(404).send({ error: { code: 'NOT_CONNECTED', message: 'No forge connected to this workspace' } });
    const url = publicWebhookUrl(req.headers);
    if (!url) return reply.status(500).send({ error: { code: 'NO_PUBLIC_URL', message: 'Set PUBLIC_URL so the forge knows where to deliver' } });

    const base = {
      kind: row.provider,
      repo: `${row.config.owner}/${row.config.repo}`,
      url,
      contentType: 'application/json',
      events: WEBHOOK_EVENTS[row.provider === 'gitea' ? 'gitea' : 'github'],
      secretStored: !!row.config.webhookSecret,
    };
    try {
      return reply.send({ ...base, ...(await readForgeWebhook(row, url)) });
    } catch (err) {
      // Listing hooks needs repo admin; without it the instructions still help.
      return reply.send({ ...base, hook: null, readError: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/integrations/forge/webhook', async (req, reply) => {
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string };
    if (!workspaceId) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'workspaceId is required' } });
    }
    if (!(await canManageWorkspaceForge(req as AuthedRequest, workspaceId))) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only a workspace or MindBlown admin may manage the forge webhook' } });
    }
    const row = await getForgeIntegration(workspaceId);
    if (!row) return reply.status(404).send({ error: { code: 'NOT_CONNECTED', message: 'No forge connected to this workspace' } });
    const url = publicWebhookUrl(req.headers);
    if (!url) return reply.status(500).send({ error: { code: 'NO_PUBLIC_URL', message: 'Set PUBLIC_URL so the forge knows where to deliver' } });

    // 200 with `status: 'failed'` + reason/hint: the forge refusing is an
    // answer the dialog shows, not an error of this route.
    return reply.send(await ensureForgeWebhook(row, url));
  });
}
