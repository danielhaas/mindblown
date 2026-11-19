/**
 * Repo docs (#550) — the Docs tab and the list_docs / read_doc tools.
 *
 *   GET /api/maps/:id/docs                 → the markdown files on the default branch
 *   GET /api/maps/:id/docs/file?path=      → one of them, as text
 *   GET /api/maps/:id/docs/image?path=     → an image a doc embeds by relative path
 *   POST /api/maps/:id/docs/propose        → branch + commit + PR with an edited doc (#552)
 *
 * Reads need view on the map (#403), the proposal edit. Rules and caching
 * live in services/repoDocs.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardMapRoutes } from '../lib/mapAccess.js';
import { listRepoDocs, proposeRepoDocEdit, proposerName, readRepoDoc, readRepoImage, RepoDocsError } from '../services/repoDocs.js';

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
      const etag = `"${img.sha}"`;
      // no-cache = revalidate every time: an image changed upstream under the
      // same path shows at once, an unchanged one costs a 304.
      if (req.headers['if-none-match'] === etag) return reply.status(304).header('ETag', etag).header('Cache-Control', 'private, no-cache').send();
      return reply
        .header('Content-Type', img.contentType)
        // An SVG is a document: opened on its own it must not run script on our origin.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-cache')
        .header('ETag', etag)
        .send(Buffer.from(img.bytes));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Edit on the map (a POST — the guard's default). The body carries a
  // whole doc, so the limit sits above the 2 MB doc cap plus JSON escaping.
  app.post<{ Params: { id: string }; Body: { path?: unknown; text?: unknown; baseSha?: unknown; message?: unknown } }>(
    '/api/maps/:id/docs/propose',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const { path, text, baseSha, message } = req.body ?? {};
      if (typeof path !== 'string' || !path || typeof text !== 'string' || typeof baseSha !== 'string' || !baseSha || (message !== undefined && typeof message !== 'string')) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'path, text and baseSha are required strings; message is an optional string' } });
      }
      try {
        const res = await proposeRepoDocEdit(req.params.id, { path, text, baseSha, message }, await proposerName(req.userId!));
        return reply.status(201).send(res);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
