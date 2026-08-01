/**
 * The naming and configuration rules behind media uploads.
 *
 * Two of these carry real weight rather than being shape checks:
 * `safeFilename` is the only thing standing between a client-supplied
 * string and a path on disk, and it is also what guarantees the stored
 * extension comes from our allowlist — an attacker-chosen `.html` served
 * from the app's own origin would be stored XSS. `mediaBaseUrl` has to
 * produce an absolute URL because the frontend's `isHttpUrl()` refuses
 * relative paths, so a regression there silently stops every uploaded clip
 * from rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  INLINE_MEDIA_TYPES,
  downloadName,
  isDownloadOnly,
  isMediaId,
  isMediaPlaybackPath,
  maxUploadBytes,
  mediaBaseUrl,
  mediaDir,
  mediaUrl,
  newMediaId,
  safeFilename,
} from '../media.js';

const ENV_KEYS = [
  'MEDIA_DIR',
  'MEDIA_MAX_BYTES',
  'MEDIA_PUBLIC_BASE_URL',
  'FRONTEND_URL',
  'PORT',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('safeFilename', () => {
  it('keeps a plain name and forces the extension the MIME type maps to', () => {
    expect(safeFilename('demo.mp4', 'video/mp4')).toBe('demo.mp4');
    // Client extension is ignored — only the accepted type decides.
    expect(safeFilename('demo.txt', 'video/mp4')).toBe('demo.mp4');
    expect(safeFilename('shot.jpeg', 'image/png')).toBe('shot.png');
  });

  it('cannot produce a script-executable extension, whatever the name says', () => {
    // The whole point: files are served from the app's own origin.
    for (const evil of ['x.html', 'x.svg', 'x.js', 'index.html.mp4', 'a.php.mp4']) {
      const out = safeFilename(evil, 'video/mp4');
      expect(out.endsWith('.mp4')).toBe(true);
      // Exactly one dot: nothing downstream can read a second extension.
      expect(out.split('.')).toHaveLength(2);
    }
    expect(safeFilename('index.html.mp4', 'video/mp4')).toBe('index-html.mp4');
  });

  it('strips directory components so the name cannot escape its folder', () => {
    for (const traversal of ['../../etc/passwd', '/etc/passwd', '..\\..\\win.ini', '....//x']) {
      const out = safeFilename(traversal, 'video/mp4');
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out.startsWith('.')).toBe(false);
      // The decisive property: joining it stays inside the parent dir.
      expect(path.join('/srv/media/abc', out)).toMatch(/^\/srv\/media\/abc\/[^/]+$/);
    }
  });

  it('replaces characters that have meaning to a shell, a URL, or a filesystem', () => {
    expect(safeFilename('mein video (final)!.mp4', 'video/mp4')).toBe('mein-video-final.mp4');
    expect(safeFilename('a;rm -rf b.mp4', 'video/mp4')).toBe('a-rm-rf-b.mp4');
    expect(safeFilename('Prüfung Übersicht.mp4', 'video/mp4')).toBe('Pr-fung-bersicht.mp4');
  });

  it('falls back to a placeholder when nothing usable survives', () => {
    expect(safeFilename('', 'video/mp4')).toBe('datei.mp4');
    expect(safeFilename('.mp4', 'video/mp4')).toBe('datei.mp4');
    expect(safeFilename('...', 'video/mp4')).toBe('datei.mp4');
    expect(safeFilename('###', 'video/mp4')).toBe('datei.mp4');
    expect(safeFilename(undefined, 'video/mp4')).toBe('datei.mp4');
  });

  it('caps the stem so a pathological name cannot blow the filesystem limit', () => {
    expect(safeFilename('a'.repeat(500) + '.mp4', 'video/mp4')).toBe('a'.repeat(80) + '.mp4');
  });

  it('covers every inline type', () => {
    for (const [mime, ext] of Object.entries(INLINE_MEDIA_TYPES)) {
      expect(safeFilename('clip', mime)).toBe(`clip.${ext}`);
    }
  });

  // ── Types we accept but will not render ────────────────────────
  //
  // These used to be refused outright, and refusing them was how the
  // "nothing script-executable is ever stored" property was bought. It's
  // now bought by the stored extension instead: `.bin` is
  // application/octet-stream, and — measured — `setHeaders` cannot
  // override a Content-Type that @fastify/static derives from the
  // extension afterwards. So the extension has to carry the guarantee on
  // its own, and these cases are where that is decided.

  it('stores anything outside the inline set under .bin', () => {
    expect(safeFilename('bericht.xlsx', 'application/vnd.ms-excel')).toBe('bericht.xlsx.bin');
    expect(safeFilename('notizen.txt', 'text/plain')).toBe('notizen.txt.bin');
    expect(safeFilename('export.zip', 'application/zip')).toBe('export.zip.bin');
  });

  it('still ends in .bin when the client sent no extension at all', () => {
    expect(safeFilename('README', 'text/plain')).toBe('README.bin');
    expect(safeFilename('', 'application/zip')).toBe('datei.bin');
    expect(safeFilename(undefined, 'application/octet-stream')).toBe('datei.bin');
  });

  it('cannot store a script-executable extension LAST, whatever was uploaded', () => {
    // The decisive property, and the reason `.bin` goes on the end rather
    // than the client's extension being kept as-is: every consumer that
    // decides a content type from a filename reads the last extension.
    for (const [name, mime] of [
      ['evil.html', 'text/html'],
      ['evil.svg', 'image/svg+xml'],
      ['evil.js', 'text/javascript'],
      ['evil.xhtml', 'application/xhtml+xml'],
      ['evil.htm', 'text/html'],
    ] as const) {
      const out = safeFilename(name, mime);
      expect(out.endsWith('.bin')).toBe(true);
      expect(isDownloadOnly(out)).toBe(true);
    }
    expect(safeFilename('evil.html', 'text/html')).toBe('evil.html.bin');
  });

  it('svg is not an inline type — it can script, unlike the other images', () => {
    expect(INLINE_MEDIA_TYPES['image/svg+xml']).toBeUndefined();
  });
});

describe('isDownloadOnly / downloadName', () => {
  it('rebuilds the name a download should land under', () => {
    expect(downloadName('bericht.xlsx.bin')).toBe('bericht.xlsx');
    expect(downloadName('README.bin')).toBe('README');
    expect(downloadName('evil.html.bin')).toBe('evil.html');
  });

  it('leaves an inline file name alone', () => {
    expect(isDownloadOnly('demo.mp4')).toBe(false);
    expect(downloadName('demo.mp4')).toBe('demo.mp4');
  });
});

describe('newMediaId / isMediaId', () => {
  it('mints 160 bits of hex — the id is the entire access control', () => {
    const id = newMediaId();
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(isMediaId(id)).toBe(true);
  });

  it('does not collide across a batch', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newMediaId()));
    expect(ids.size).toBe(500);
  });

  it('rejects anything we did not mint', () => {
    expect(isMediaId('../etc')).toBe(false);
    expect(isMediaId('ABCDEF'.repeat(7))).toBe(false); // uppercase
    expect(isMediaId('a'.repeat(39))).toBe(false);
    expect(isMediaId('a'.repeat(41))).toBe(false);
  });
});

describe('isMediaPlaybackPath', () => {
  const ID = 'a'.repeat(40);

  it('matches a URL we minted, with or without a query string', () => {
    expect(isMediaPlaybackPath(`/api/media/${ID}/demo.mp4`)).toBe(true);
    expect(isMediaPlaybackPath(`/api/media/${ID}/a%20b.mp4`)).toBe(true);
    expect(isMediaPlaybackPath(`/api/media/${ID}/demo.mp4?t=3`)).toBe(true);
  });

  it('refuses anything else under the prefix — this is what keeps a future route private', () => {
    // Each of these would be silently public under a `startsWith` check.
    expect(isMediaPlaybackPath('/api/media/usage')).toBe(false);
    expect(isMediaPlaybackPath(`/api/media/${ID}/meta/raw`)).toBe(false);
    expect(isMediaPlaybackPath('/api/media/')).toBe(false);
    expect(isMediaPlaybackPath('/api/media')).toBe(false);
    expect(isMediaPlaybackPath(`/api/media/${ID}`)).toBe(false);
    expect(isMediaPlaybackPath(`/api/media/${ID}/`)).toBe(false);
  });

  it('refuses an id it did not mint', () => {
    expect(isMediaPlaybackPath('/api/media/../maps/x.mp4')).toBe(false);
    expect(isMediaPlaybackPath(`/api/media/${'A'.repeat(40)}/x.mp4`)).toBe(false);
    expect(isMediaPlaybackPath(`/api/media/${'a'.repeat(39)}/x.mp4`)).toBe(false);
    expect(isMediaPlaybackPath('//api/media/' + ID + '/x.mp4')).toBe(false);
  });
});

describe('mediaDir', () => {
  it('defaults to a gitignored directory beside the server package', () => {
    expect(mediaDir()).toBe(path.resolve('.media'));
  });

  it('honours MEDIA_DIR so production can store outside the checkout', () => {
    process.env.MEDIA_DIR = '/var/lib/mindblown/media';
    expect(mediaDir()).toBe('/var/lib/mindblown/media');
  });
});

describe('maxUploadBytes', () => {
  it('defaults to 100 MB', () => {
    expect(maxUploadBytes()).toBe(100 * 1024 * 1024);
  });

  it('honours an override', () => {
    process.env.MEDIA_MAX_BYTES = '5000000';
    expect(maxUploadBytes()).toBe(5_000_000);
  });

  it('ignores garbage rather than degrading to an unbounded or zero limit', () => {
    for (const bad of ['', 'lots', '-1', '0']) {
      process.env.MEDIA_MAX_BYTES = bad;
      expect(maxUploadBytes()).toBe(100 * 1024 * 1024);
    }
  });
});

describe('mediaBaseUrl / mediaUrl', () => {
  it('uses FRONTEND_URL — the origin Caddy already serves the API from', () => {
    process.env.FRONTEND_URL = 'https://mind.project.li';
    expect(mediaBaseUrl()).toBe('https://mind.project.li');
  });

  it('lets MEDIA_PUBLIC_BASE_URL win for a split-host setup', () => {
    process.env.FRONTEND_URL = 'https://mind.project.li';
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.project.li';
    expect(mediaBaseUrl()).toBe('https://media.project.li');
  });

  it('falls back to the local API port in dev', () => {
    process.env.PORT = '3001';
    expect(mediaBaseUrl()).toBe('http://localhost:3001');
  });

  it('drops trailing slashes so the joined URL has no double slash', () => {
    process.env.FRONTEND_URL = 'https://mind.project.li///';
    expect(mediaUrl('a'.repeat(40), 'demo.mp4')).toBe(
      `https://mind.project.li/api/media/${'a'.repeat(40)}/demo.mp4`,
    );
  });

  it('is absolute — the frontend refuses relative URLs in this field', () => {
    process.env.FRONTEND_URL = 'https://mind.project.li';
    const url = mediaUrl(newMediaId(), 'demo.mp4');
    expect(new URL(url).protocol).toBe('https:');
  });

  it('percent-encodes the filename', () => {
    process.env.FRONTEND_URL = 'https://mind.project.li';
    expect(mediaUrl('b'.repeat(40), 'a b.mp4')).toContain('/a%20b.mp4');
  });
});
