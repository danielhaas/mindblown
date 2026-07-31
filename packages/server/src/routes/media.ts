/**
 * File uploads (#286) — `POST /api/media` to store, `GET /api/media/*` to
 * play back.
 *
 * The design notes live in `lib/media.ts`; the short version is that the
 * upload is authenticated, the download is a capability URL, and the
 * bytes land outside the checkout so a deploy can't sweep them away.
 */

import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  ALLOWED_MEDIA_TYPES,
  MEDIA_ROUTE_PREFIX,
  maxUploadBytes,
  mediaDir,
  mediaUrl,
  newMediaId,
  safeFilename,
} from '../lib/media.js';

export interface UploadedMedia {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const root = mediaDir();
  const limit = maxUploadBytes();

  await mkdir(root, { recursive: true });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: limit,
      files: 1,
      // The upload carries no text fields; refusing them keeps the parser
      // from buffering anything a caller tacks on.
      fields: 0,
    },
  });

  // Playback. Unauthenticated by design — `middleware/auth.ts` skips
  // GET/HEAD under this prefix, and the 160-bit id in the path is what
  // stands in for a credential.
  await app.register(fastifyStatic, {
    root,
    prefix: `${MEDIA_ROUTE_PREFIX}/`,
    index: false,
    list: false,
    // A file's URL contains its id and neither ever changes, so cache for
    // a year. Set through the plugin's own options rather than
    // `setHeaders`: @fastify/static writes Cache-Control itself, after the
    // hook has run, so a value set there is silently overwritten — it was,
    // with `max-age=0`, until this was measured against a live server.
    maxAge: 31_536_000_000,
    immutable: true,
    // Stored names are minted by `safeFilename`, so the extension — and
    // therefore the Content-Type — is always one of the allowlist's.
    // `nosniff` closes the gap where a browser would second-guess that
    // from the bytes and treat, say, an mp4 full of markup as HTML on our
    // own origin.
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });

  app.post('/api/media', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }

    const part = await req.file();
    if (!part) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'No file in request' },
      });
    }

    const contentType = (part.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (!(contentType in ALLOWED_MEDIA_TYPES)) {
      // Drain the body, otherwise the client sees a connection reset
      // instead of our 415 while it is still writing.
      part.file.resume();
      return reply.status(415).send({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Dateityp ${contentType || 'unbekannt'} wird nicht unterstützt`,
          supported: Object.keys(ALLOWED_MEDIA_TYPES),
        },
      });
    }

    const id = newMediaId();
    const filename = safeFilename(part.filename, contentType);
    const dir = path.join(root, id);
    const dest = path.join(dir, filename);

    await mkdir(dir, { recursive: true });
    try {
      await pipeline(part.file, createWriteStream(dest));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }

    // @fastify/multipart enforces the ceiling by truncating the stream, not
    // by throwing — without this check an oversized upload would be stored
    // silently corrupted at exactly `limit` bytes.
    if (part.file.truncated) {
      await rm(dir, { recursive: true, force: true });
      return reply.status(413).send({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `Datei überschreitet das Limit von ${Math.floor(limit / (1024 * 1024))} MB`,
          maxBytes: limit,
        },
      });
    }

    const result: UploadedMedia = {
      id,
      url: mediaUrl(id, filename),
      filename,
      contentType,
      size: part.file.bytesRead,
    };
    return reply.status(201).send(result);
  });
}
