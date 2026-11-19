/**
 * Publish a map's timeline to the workspace's wiki (#637).
 *
 *   GET  /api/maps/:id/wiki          → { wiki: WikiStatus } — the connection (never the token) + the published page
 *   PUT  /api/maps/:id/wiki          → { baseUrl, token?, collectionId } — workspace owner; token omitted = keep
 *   POST /api/maps/:id/wiki/publish  → { tz? } — create the page the first time, update the same one after
 *
 * The export itself (GET /api/maps/:id/export.md) lives in routes/maps.ts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { TimelineOptionError } from '../export/timeline.js';
import {
  publishMapToWiki,
  saveWikiSettings,
  wikiStatus,
  WikiForbiddenError,
  WikiNotConfiguredError,
  WikiPublishError,
  WikiValidationError,
  type WikiSettingsInput,
} from '../services/wikiPublish.js';

const ADMIN = { config: { mapAccess: 'admin' as const } };

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WikiValidationError || err instanceof TimelineOptionError) {
    return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
  }
  if (err instanceof WikiForbiddenError) return reply.status(403).send({ error: { code: 'FORBIDDEN', message: err.message } });
  if (err instanceof WikiNotConfiguredError) return reply.status(409).send({ error: { code: 'WIKI_NOT_CONFIGURED', message: err.message } });
  if (err instanceof WikiPublishError) return reply.status(502).send({ error: { code: 'WIKI_PUBLISH_FAILED', message: err.message } });
  throw err;
}

const notFound = (reply: FastifyReply, id: string) =>
  reply.status(404).send({ error: { code: 'MAP_NOT_FOUND', message: `Map ${id} not found` } });

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app);

  app.get<{ Params: { id: string } }>('/api/maps/:id/wiki', async (req, reply) => {
    const status = await wikiStatus(req.params.id);
    return status ? reply.send({ wiki: status }) : notFound(reply, req.params.id);
  });

  app.put<{ Params: { id: string }; Body: WikiSettingsInput }>('/api/maps/:id/wiki', ADMIN, async (req, reply) => {
    try {
      const status = await saveWikiSettings(req.params.id, (req.body ?? {}) as WikiSettingsInput, req.userId ?? null);
      return status ? reply.send({ wiki: status }) : notFound(reply, req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { tz?: string } }>('/api/maps/:id/wiki/publish', async (req, reply) => {
    try {
      const result = await publishMapToWiki(req.params.id, { userId: req.userId ?? null, timeZone: req.body?.tz });
      return result ? reply.send(result) : notFound(reply, req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
