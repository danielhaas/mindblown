/**
 * Upload + playback route tests (#286).
 *
 * These run against a real Fastify instance with real @fastify/multipart
 * and @fastify/static over a real temp directory — the failure modes worth
 * catching all live in the plumbing (does the ceiling actually stop an
 * oversized file, does a rejected type leave a directory behind, does the
 * stored file come back with the right Content-Type) and a mocked
 * filesystem would test none of them.
 *
 * The auth middleware gets its own block at the bottom, with the DB-backed
 * bits stubbed: the decision that `GET /api/media/*` is public is the one
 * security-relevant choice in this feature, and it must not become public
 * for `POST` by accident.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { mediaRoutes } from '../media.js';

// ── Harness ───────────────────────────────────────────────────────

const BOUNDARY = '----mindblowntest';

/** Hand-rolled multipart body — one file part, which is all the route takes. */
function multipart(opts: {
  filename?: string;
  contentType?: string;
  content: Buffer | string;
  field?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const body = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content);
  const disposition =
    opts.filename === undefined
      ? `form-data; name="${opts.field ?? 'file'}"`
      : `form-data; name="${opts.field ?? 'file'}"; filename="${opts.filename}"`;
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: ${disposition}\r\n` +
      `Content-Type: ${opts.contentType ?? 'video/mp4'}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

let app: FastifyInstance;
let dir: string;
let authedUser: string | undefined;

const ENV_KEYS = ['MEDIA_DIR', 'MEDIA_MAX_BYTES', 'FRONTEND_URL', 'MEDIA_PUBLIC_BASE_URL'] as const;
let savedEnv: Record<string, string | undefined>;

async function build(): Promise<void> {
  app = Fastify();
  // Stand in for registerAuthMiddleware — the route's own 401 is what we
  // exercise here; the middleware itself is covered further down.
  app.addHook('preHandler', async (req) => {
    (req as { userId?: string }).userId = authedUser;
  });
  await app.register(mediaRoutes);
  await app.ready();
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = await mkdtemp(path.join(tmpdir(), 'mindblown-media-'));
  process.env.MEDIA_DIR = dir;
  process.env.FRONTEND_URL = 'https://mind.project.li';
  delete process.env.MEDIA_MAX_BYTES;
  delete process.env.MEDIA_PUBLIC_BASE_URL;
  authedUser = 'user-1';
  await build();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Upload ────────────────────────────────────────────────────────

describe('POST /api/media', () => {
  it('stores the file and returns an absolute URL under its own id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'Mein Clip.mp4', content: 'fake-mp4-bytes' }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.filename).toBe('Mein-Clip.mp4');
    expect(body.contentType).toBe('video/mp4');
    expect(body.size).toBe('fake-mp4-bytes'.length);
    expect(body.url).toBe(`https://mind.project.li/api/media/${body.id}/Mein-Clip.mp4`);

    const stored = await readFile(path.join(dir, body.id, 'Mein-Clip.mp4'), 'utf8');
    expect(stored).toBe('fake-mp4-bytes');
  });

  it('refuses an anonymous upload — only the download side is public', async () => {
    authedUser = undefined;
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'a.mp4', content: 'x' }),
    });

    expect(res.statusCode).toBe(401);
    expect(await readdir(dir)).toEqual([]);
  });

  it('gives two uploads of the same name separate homes', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'demo.mp4', content: 'one' }),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'demo.mp4', content: 'two' }),
    });

    expect(first.json().id).not.toBe(second.json().id);
    expect(await readFile(path.join(dir, first.json().id, 'demo.mp4'), 'utf8')).toBe('one');
    expect(await readFile(path.join(dir, second.json().id, 'demo.mp4'), 'utf8')).toBe('two');
  });

  it('rejects a type outside the allowlist and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({
        filename: 'evil.html',
        contentType: 'text/html',
        content: '<script>alert(1)</script>',
      }),
    });

    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await readdir(dir)).toEqual([]);
  });

  it('accepts a charset-suffixed content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'a.png', contentType: 'IMAGE/PNG; charset=binary', content: 'p' }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().contentType).toBe('image/png');
  });

  it('refuses an oversized file and leaves no truncated remains', async () => {
    process.env.MEDIA_MAX_BYTES = '64';
    await app.close();
    await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: 'big.mp4', content: Buffer.alloc(4096, 0x41) }),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    // The decisive assertion: @fastify/multipart truncates rather than
    // throwing, so without the explicit `truncated` check a 64-byte corrupt
    // file would be sitting here reported as a success.
    expect(await readdir(dir)).toEqual([]);
  });

  it('400s when the request carries no file part', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      payload: Buffer.from(`--${BOUNDARY}--\r\n`),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it('cannot be talked into writing outside the media directory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename: '../../../../tmp/pwned.mp4', content: 'x' }),
    });

    expect(res.statusCode).toBe(201);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{40}$/);
    // basename() drops the whole path, not just the leading `..` — the
    // traversal attempt leaves nothing but the leaf name behind.
    expect(await readdir(path.join(dir, entries[0]))).toEqual(['pwned.mp4']);
  });
});

// ── Playback ──────────────────────────────────────────────────────

describe('GET /api/media/*', () => {
  async function upload(filename: string, content: string, contentType?: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      ...multipart({ filename, content, contentType }),
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; filename: string; url: string };
  }

  it('serves the stored bytes with the allowlisted content type', async () => {
    const up = await upload('demo.mp4', 'fake-mp4-bytes');

    const res = await app.inject({ method: 'GET', url: `/api/media/${up.id}/${up.filename}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('video/mp4');
    expect(res.body).toBe('fake-mp4-bytes');
  });

  it('sends nosniff so the browser cannot re-read the bytes as HTML', async () => {
    const up = await upload('demo.mp4', '<html><script>alert(1)</script></html>');

    const res = await app.inject({ method: 'GET', url: `/api/media/${up.id}/${up.filename}` });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('video/mp4');
  });

  it('caches hard — the id makes the URL immutable', async () => {
    // Regression: this was `max-age=0` for a while. @fastify/static writes
    // Cache-Control after `setHeaders` runs, so setting it in the hook
    // looked correct in the source and did nothing on the wire.
    const up = await upload('demo.mp4', 'x');

    const res = await app.inject({ method: 'GET', url: `/api/media/${up.id}/${up.filename}` });

    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('supports range requests so a clip can be seeked', async () => {
    const up = await upload('demo.mp4', 'abcdefghij');

    const res = await app.inject({
      method: 'GET',
      url: `/api/media/${up.id}/${up.filename}`,
      headers: { range: 'bytes=2-5' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('cdef');
  });

  it('404s an id that was never minted', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/media/${'a'.repeat(40)}/x.mp4` });
    expect(res.statusCode).toBe(404);
  });

  it('does not list the media directory', async () => {
    await upload('demo.mp4', 'x');
    const res = await app.inject({ method: 'GET', url: '/api/media/' });
    expect(res.statusCode).not.toBe(200);
  });

  it('refuses to traverse out of the media root', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/media/../../../etc/passwd' });
    expect(res.statusCode).not.toBe(200);
  });
});

// ── Auth middleware: which side of this feature is public ──────────

describe('auth middleware exemption', () => {
  let guarded: FastifyInstance;

  beforeEach(async () => {
    vi.resetModules();
    // Neither stub is reached by these cases (no Authorization header is
    // sent) — they exist so importing the middleware doesn't drag in
    // jsonwebtoken config or a Postgres connection.
    vi.doMock('../../auth.js', () => ({
      verifyToken: () => ({ userId: 'user-1' }),
    }));
    vi.doMock('../../lib/apiKeys.js', () => ({
      API_KEY_PREFIX: 'mb_',
      validateApiKey: async () => ({ userId: 'user-1' }),
    }));
    const { registerAuthMiddleware } = await import('../../middleware/auth.js');

    guarded = Fastify();
    await registerAuthMiddleware(guarded);
    // Echo routes: they answer 200 only if the middleware let them through
    // without a credential.
    guarded.get('/api/media/:id/:file', async () => ({ ok: true }));
    guarded.post('/api/media', async (req) => ({
      userId: (req as { userId?: string }).userId ?? null,
    }));
    guarded.get('/api/maps', async () => ({ ok: true }));
    await guarded.ready();
  });

  afterEach(async () => {
    await guarded.close();
    vi.doUnmock('../../auth.js');
    vi.doUnmock('../../lib/apiKeys.js');
  });

  it('lets an unauthenticated GET through — a <video> tag cannot send a Bearer header', async () => {
    const res = await guarded.inject({
      method: 'GET',
      url: `/api/media/${'a'.repeat(40)}/demo.mp4`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not extend that exemption to POST — the token still gets resolved', async () => {
    // A credential-less request reaches the handler either way (the
    // middleware lets anonymous callers through and routes do their own
    // 401), so absence of a userId proves nothing. A *valid* token does:
    // it can only end up on the request if the auth handler actually ran,
    // which is exactly what widening the exemption to POST would skip.
    const res = await guarded.inject({
      method: 'POST',
      url: '/api/media',
      payload: {},
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(res.json().userId).toBe('user-1');
  });

  it('rejects a bad token on POST instead of silently ignoring it', async () => {
    vi.resetModules();
    vi.doMock('../../auth.js', () => ({
      verifyToken: () => {
        throw new Error('bad token');
      },
    }));
    vi.doMock('../../lib/apiKeys.js', () => ({
      API_KEY_PREFIX: 'mb_',
      validateApiKey: async () => null,
    }));
    const { registerAuthMiddleware } = await import('../../middleware/auth.js');
    const strict = Fastify();
    await registerAuthMiddleware(strict);
    strict.post('/api/media', async () => ({ ok: true }));
    await strict.ready();

    const res = await strict.inject({
      method: 'POST',
      url: '/api/media',
      payload: {},
      headers: { authorization: 'Bearer nonsense' },
    });
    expect(res.statusCode).toBe(401);
    await strict.close();
  });
});
