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

/** Thrown and caught inside the handler so the `finally` cleanup runs on
 *  the abort path without the abort escaping as a 500. */
class AbortedUpload extends Error {}

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

    // The invariant this code depends on, stated once because it is what
    // a future edit here will break:
    //
    //   **No `await` between the `destroyed` check below and `pipeline()`
    //   attaching to the stream.**
    //
    // Any limit @fastify/multipart enforces — `fields`, `parts`, `files` —
    // is handled by destroying the file stream. A destroyed stream emits
    // neither `end` nor `error`, so a `pipeline()` that attaches to one
    // never settles: the request hangs forever, holding a socket and an
    // fd, and whatever cleanup was supposed to run never does. Every
    // limit is therefore a door to the same failure, and the guard is what
    // turns "hangs forever" into an answer. Eleven text fields ahead of
    // the file is the deterministic way in — the socket test named
    // "answers when the parser kills the file stream" pins exactly that,
    // and removing the guard hangs it every time.
    //
    // `mkdirSync` rather than `await mkdir` is belt-and-braces: the guard
    // already sits after it and covers the same window, so this is not
    // load-bearing on its own. It stays because an `await` on this line is
    // the most natural way for someone to reintroduce the gap without
    // noticing.
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
    let aborted = false;
    try {
      // Not a thrown 500: the stream dying before we could write it is a
      // client-side condition — an abandoned upload, or a request that
      // tripped one of the parser's limits — and a 500 would both page
      // someone and reach the user as a bare "HTTP 500" instead of the
      // app's error shape that `uploadMedia()` knows how to unwrap.
      aborted = part.file.destroyed;
      if (aborted) throw new AbortedUpload();
      await pipeline(part.file, createWriteStream(dest));

      // @fastify/multipart enforces the ceiling by truncating the stream,
      // not by throwing — without this check an oversized upload would be
      // stored silently corrupted at exactly `limit` bytes.
      tooLarge = part.file.truncated;
      stored = !tooLarge;
    } catch (err) {
      if (!(err instanceof AbortedUpload)) throw err;
    } finally {
      // Every exit that isn't a stored file takes its directory with it:
      // the 413, the abort, a thrown pipeline error.
      if (!stored) await rm(dir, { recursive: true, force: true });
    }

    if (aborted) {
      return reply.status(400).send({
        error: { code: 'UPLOAD_ABORTED', message: 'Upload wurde unterbrochen' },
      });
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
