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
import { createWriteStream, mkdirSync } from 'node:fs';
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
      // Not `fields: 0`, which is the intuitive setting and a trap.
      // Exceeding a limit makes @fastify/multipart run its cleanup, and
      // cleanup destroys the file stream — with `0`, that fires on the
      // first text part, i.e. before `req.file()` even resolves. The
      // handler then gets a stream that is already destroyed and closed,
      // which emits neither `end` nor `error`, so `pipeline()` never
      // settles: the request hangs forever, holding a socket and an open
      // fd, and leaves a 0-byte file behind. A field bound this route
      // doesn't need is not worth that; these values leave room for the
      // obvious next change (sending a nodeId alongside the file).
      fields: 10,
      fieldSize: 4096,
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
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // A PDF is the one allowlisted type a browser renders as a
      // full-page document. Nothing script-executable comes of it, but a
      // full page under our own hostname is a phishing surface, so it
      // downloads instead. `<img>` / `<video>` subresource loads ignore
      // this header, so images and clips are unaffected.
      if (filePath.endsWith('.pdf')) {
        res.setHeader('Content-Disposition', 'attachment');
      }
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

    // Synchronous on purpose, and the guard below with it. An `await`
    // here yields the event loop, and the thing that can run in that gap
    // is @fastify/multipart's `request.on('close')` cleanup destroying the
    // file stream — after which `pipeline()` waits forever on a stream
    // that will never emit `end` or `error` again.
    //
    // Honest about the evidence: that window was observed once under a
    // standalone abort probe (five of six disconnects left an orphaned
    // directory and a hung request) and independently in review, but it is
    // timing-sensitive enough that neither the test below nor a repeat of
    // the probe reproduces it on demand. So this is not a fix pinned by a
    // failing test — it is a cheap close of a window that provably exists
    // in the same code path as the `fields: 0` hang above, which is
    // reproducible every time. Removing either line costs nothing to keep
    // and reopens something nobody can reliably detect.
    mkdirSync(dir, { recursive: true });

    // Nothing is sent from inside the try block on purpose. `reply.send()`
    // dispatches the response without waiting for the handler to return,
    // so a cleanup in `finally` would race the client: it would be correct
    // and still leave the directory there for anyone — including a test —
    // who looks the moment the 413 arrives. Deciding first and answering
    // afterwards makes "a rejected upload leaves nothing behind" a
    // guarantee rather than a near-certainty.
    let stored = false;
    let tooLarge = false;
    try {
      if (part.file.destroyed) {
        throw new Error('upload stream closed before it could be written');
      }
      await pipeline(part.file, createWriteStream(dest));

      // @fastify/multipart enforces the ceiling by truncating the stream,
      // not by throwing — without this check an oversized upload would be
      // stored silently corrupted at exactly `limit` bytes.
      tooLarge = part.file.truncated;
      stored = !tooLarge;
    } finally {
      // Every exit that isn't a stored file takes its directory with it:
      // the 413, a thrown pipeline error, an aborted connection.
      if (!stored) await rm(dir, { recursive: true, force: true });
    }

    if (tooLarge) {
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
