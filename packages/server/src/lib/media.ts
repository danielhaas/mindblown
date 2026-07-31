/**
 * Media uploads — configuration and the pure naming rules.
 *
 * The product need is "hang a short clip on a node" (#285 added
 * `verificationVideoUrl`; until now the only way to fill it was to paste a
 * URL to a file someone had rsync'd onto the host by hand).
 *
 * Three decisions are encoded here, and they're the ones worth arguing
 * about:
 *
 * 1. **Files live outside the checkout.** `MEDIA_DIR` defaults to a
 *    gitignored directory next to the server package for local dev, and is
 *    pointed at `/var/lib/mindblown/media` in production. A deploy runs
 *    `git pull && pnpm build`, and the build rewrites
 *    `packages/mindmap/dist` wholesale — anything stored under it would be
 *    gone on the next release.
 *
 * 2. **The URL is the capability.** The path carries 160 bits of
 *    randomness, and `GET /api/media/*` is deliberately unauthenticated
 *    (see `middleware/auth.ts`). A `<video src=…>` cannot send an
 *    `Authorization` header, and the app keeps its JWT in localStorage
 *    rather than a cookie, so authenticated playback would mean either an
 *    expiring signed URL — which rots in the `verification_video_url`
 *    column the moment it expires — or fetching the whole clip as a blob
 *    and losing range requests. Unguessable-URL is the same trade every
 *    chat app makes for its attachment CDN. The operational consequence is
 *    real and belongs in the release note: **anything uploaded is readable
 *    by anyone who has the link**, and mind.project.li is public. Upgrade
 *    path if that stops being acceptable: keep the route, add a
 *    per-request signature, and re-render the src at view time.
 *
 * 3. **The stored extension comes from our allowlist, never from the
 *    client.** The file is served from the same origin as the app, so a
 *    stored `.html` would be stored XSS. Deriving the extension from the
 *    accepted MIME type means the set of things on disk is closed, and
 *    none of them is script-executable in a browsing context.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Accepted upload types → the extension we store them under.
 *
 * Videos are the point; images ride along because a screenshot is the
 * cheap version of a clip and users will try it. PDF is here for spec
 * hand-offs. Everything else is refused rather than stored under a generic
 * extension — see the module note on why the extension set stays closed.
 */
export const ALLOWED_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
});

/** URL prefix the upload response builds on, and the static mount point. */
export const MEDIA_ROUTE_PREFIX = '/api/media';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Upload ceiling in bytes. 100 MB by default: comfortably above a
 * screen-recorded minute at 1080p, well below the ~13 GB free on the
 * production container, and small enough that a mistaken upload of a
 * 4 GB source file fails fast instead of filling the disk.
 */
export function maxUploadBytes(): number {
  const raw = process.env.MEDIA_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * Where uploads are written.
 *
 * The default is relative to the server package (its systemd
 * `WorkingDirectory`), gitignored, so a fresh clone works with no setup.
 * Production sets `MEDIA_DIR=/var/lib/mindblown/media` so the files are
 * outside the checkout entirely and survive a `git pull`, a rebuild, and a
 * re-clone.
 */
export function mediaDir(): string {
  return path.resolve(process.env.MEDIA_DIR ?? '.media');
}

/**
 * Absolute base for the URLs we hand back.
 *
 * It has to be absolute: `verificationVideoUrl` is rendered through
 * `isHttpUrl()` on the frontend, which refuses relative paths (they can't
 * be distinguished from a `javascript:` payload without parsing, and the
 * field is free text). `FRONTEND_URL` is already set in production and
 * points at the same origin Caddy serves the API from, so it is the right
 * default; `MEDIA_PUBLIC_BASE_URL` exists for a split-host setup.
 */
export function mediaBaseUrl(): string {
  const raw =
    process.env.MEDIA_PUBLIC_BASE_URL ??
    process.env.FRONTEND_URL ??
    `http://localhost:${process.env.PORT ?? '3001'}`;
  return raw.replace(/\/+$/, '');
}

/** 160 bits of randomness — the whole of the access control, so not fewer. */
export function newMediaId(): string {
  return randomBytes(20).toString('hex');
}

/** An id we minted, and nothing else. Guards the path we build from it. */
export function isMediaId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

const MAX_STEM_LENGTH = 80;

/**
 * Turn a client-supplied filename into one we're willing to put on disk.
 *
 * The name is cosmetic — it's what the browser offers on "save as" and
 * what makes the URL readable — so it is rewritten aggressively rather
 * than validated: directory components dropped, anything outside
 * `[A-Za-z0-9_-]` replaced, length capped, and the extension replaced with
 * the one our allowlist assigns to the accepted MIME type.
 *
 * Dots inside the stem go too, so the result carries exactly one
 * extension. `index.html.mp4` would be served as `video/mp4` by both Caddy
 * and @fastify/static — they read the last extension — but a name that
 * still contains `.html` is one proxy or one content-scanner away from
 * being read the other way round, and `index-html.mp4` costs nothing.
 */
export function safeFilename(original: string | undefined, mimeType: string): string {
  const ext = ALLOWED_MEDIA_TYPES[mimeType];
  if (!ext) throw new Error(`Unsupported media type: ${mimeType}`);

  const base = path.basename(original ?? '').trim();
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/-+$/, '')
    .slice(0, MAX_STEM_LENGTH);

  return `${cleaned || 'datei'}.${ext}`;
}

/**
 * The public URL for a stored file.
 *
 * Collisions are impossible without deduplicating names, because every
 * upload gets its own directory named after its id — two people uploading
 * `demo.mp4` a second apart keep both the file and the readable name.
 */
export function mediaUrl(id: string, filename: string): string {
  return `${mediaBaseUrl()}${MEDIA_ROUTE_PREFIX}/${id}/${encodeURIComponent(filename)}`;
}
