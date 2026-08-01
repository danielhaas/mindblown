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
 * Types the browser is allowed to render in place, and the extension each
 * is stored under.
 *
 * Membership here is a permission, not a filter: these are the files we
 * hand back with their real Content-Type, so a browser will play, show or
 * display them. Everything else is still accepted — see
 * `INLINE_SAFE_FALLBACK` — it just doesn't get that privilege.
 */
export const INLINE_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
});

/**
 * What every other type is stored and served as.
 *
 * The original allowlist existed for one reason: files are served from the
 * same origin as the app, so a stored `.html` or `.svg` would be stored
 * XSS. Refusing unknown types was the cheap way to guarantee that. It is
 * not the only way, and it cost users the ordinary case — a spec, a
 * spreadsheet, an export, a zip.
 *
 * So: anything outside the inline set keeps its (sanitised) extension for
 * the sake of a sensible "save as", but is served as
 * `application/octet-stream` with `Content-Disposition: attachment`. A
 * browser handed those two headers downloads the file; it never parses it,
 * never executes it, and never gives it our origin. That holds regardless
 * of what the bytes contain or what the client claimed the type was, which
 * is a stronger guarantee than an allowlist of MIME strings the client
 * picks.
 */
export const INLINE_SAFE_FALLBACK = 'application/octet-stream';

/** True when we'll hand this type back with its real Content-Type. */
export function isInlineType(mimeType: string): boolean {
  return mimeType in INLINE_MEDIA_TYPES;
}

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

/**
 * Does this request URL address a stored file — the one thing under
 * `/api/media` that is served without a credential?
 *
 * Deliberately narrower than `url.startsWith('/api/media/')`. The auth
 * exemption and the route table would otherwise be two independent
 * things that happen to agree today: a later `GET /api/media/usage`
 * would be silently public, with no test failing. Matching the exact
 * shape of a minted URL — id, then one path segment — means anything
 * else added under the prefix is authenticated by default.
 */
export function isMediaPlaybackPath(url: string): boolean {
  return /^\/api\/media\/[0-9a-f]{40}\/[^/?#]+(?:[?#]|$)/.test(url);
}

const MAX_STEM_LENGTH = 80;

/**
 * Turn a client-supplied filename into one we're willing to put on disk.
 *
 * The name is cosmetic — it's what the browser offers on "save as" and
 * what makes the URL readable — so it is rewritten aggressively rather
 * than validated: directory components dropped, anything outside
 * `[A-Za-z0-9_-]` replaced, length capped.
 *
 * The extension is where the two cases part, and the split is forced by a
 * measured fact: **`setHeaders` cannot override Content-Type.**
 * @fastify/static derives it from the stored extension and writes it after
 * the hook runs — a probe confirmed a stored `evil.html` comes back as
 * `text/html; charset=utf-8` no matter what the hook sets. (The same trap
 * that made `Cache-Control` read `max-age=0` in #286.) So the extension on
 * disk *is* the security boundary; nothing downstream can repair it.
 *
 * Inline types therefore take their extension from our own table, never
 * the client. Everything else is stored as `<name>.<clientext>.bin`: the
 * last extension is `.bin`, which is `application/octet-stream`, and the
 * inner one survives only to rebuild a usable "save as" name in the
 * `Content-Disposition` header — which *can* be set from the hook. A
 * `.html`, `.svg` or `.js` upload thus lands as `…​.html.bin` and is
 * downloaded, never parsed, never given our origin.
 *
 * Dots inside the stem go either way, so an inline file carries exactly
 * one extension. `index.html.mp4` would be served as `video/mp4` by both
 * Caddy and @fastify/static — they read the last extension — but a name
 * that still contains `.html` is one proxy or one content-scanner away
 * from being read the other way round, and `index-html.mp4` costs nothing.
 */
export function safeFilename(original: string | undefined, mimeType: string): string {
  const base = path.basename(original ?? '').trim();
  const clientExt = /\.([A-Za-z0-9]{1,12})$/.exec(base)?.[1]?.toLowerCase();

  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/-+$/, '')
    .slice(0, MAX_STEM_LENGTH);
  const name = cleaned || 'datei';

  const inlineExt = INLINE_MEDIA_TYPES[mimeType];
  if (inlineExt) return `${name}.${inlineExt}`;

  return clientExt ? `${name}.${clientExt}.${DOWNLOAD_EXTENSION}` : `${name}.${DOWNLOAD_EXTENSION}`;
}

/** Extension every non-inline upload is stored under. `.bin` resolves to
 *  `application/octet-stream`, which is the whole point. */
export const DOWNLOAD_EXTENSION = 'bin';

/** True for a file we stored as a forced download. */
export function isDownloadOnly(storedName: string): boolean {
  return storedName.endsWith(`.${DOWNLOAD_EXTENSION}`);
}

/**
 * The name a download should land under — the stored name without the
 * `.bin` we appended, so `bericht.xlsx.bin` saves as `bericht.xlsx` and
 * the user's machine opens it with the right application.
 */
export function downloadName(storedName: string): string {
  return isDownloadOnly(storedName)
    ? storedName.slice(0, -(DOWNLOAD_EXTENSION.length + 1))
    : storedName;
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
