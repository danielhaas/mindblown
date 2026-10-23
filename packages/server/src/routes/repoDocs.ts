/**
 * Repo docs (#550) — the Docs tab and the list_docs / read_doc tools.
 *
 *   GET /api/maps/:id/docs                 → the markdown files on the default branch
 *   GET /api/maps/:id/docs/file?path=      → one of them, as text
 *   GET /api/maps/:id/docs/image?path=     → an image a doc embeds by relative path
 *
 * View on the map (#403). Rules and caching live in services/repoDocs.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { listRepoDocs, readRepoDoc, readRepoImage, RepoDocsError } from '../services/repoDocs.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RepoDocsError) {
    return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

function pathParam(path: string | undefined, reply: FastifyReply): string | null {
  if (!path) {
    reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'path is required' } });
    return null;
  }
  return path;
}

export async function repoDocsRoutes(app: FastifyInstance): Promise<void> {
  guardMapRoutes(app);

  app.get<{ Params: { id: string } }>('/api/maps/:id/docs', async (req, reply) => {
    try {
      return reply.send(await listRepoDocs(req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/maps/:id/docs/file', async (req, reply) => {
    const path = pathParam(req.query.path, reply);
    if (!path) return reply;
    try {
      return reply.send(await readRepoDoc(req.params.id, path));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/maps/:id/docs/image', async (req, reply) => {
    const path = pathParam(req.query.path, reply);
    if (!path) return reply;
    try {
      const img = await readRepoImage(req.params.id, path);
      return reply
        .header('Content-Type', img.contentType)
        // An SVG is a document: opened on its own it must not run script on our origin.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', `"${img.sha}"`)
        .send(Buffer.from(img.bytes));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
