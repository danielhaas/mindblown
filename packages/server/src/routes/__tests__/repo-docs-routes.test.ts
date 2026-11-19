/**
 * Docs tab routes (#550) — the real plugin over a mocked service. Pins what
 * the route owns: the map guard, the `path` parameter, which service call
 * it makes, error → status mapping and the image response headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  permission: 'view' as string | null,
  listRepoDocs: vi.fn(),
  readRepoDoc: vi.fn(),
  readRepoImage: vi.fn(),
  proposeRepoDocEdit: vi.fn(),
}));

const RANK: Record<string, number> = { view: 1, edit: 2, admin: 3 };
vi.mock('../../db/permissions.js', () => ({
  getPermission: async () => mocks.permission,
  hasPermission: (perm: string | null, level: string) => perm !== null && RANK[perm] >= RANK[level],
}));
vi.mock('../../services/repoDocs.js', () => {
  class RepoDocsError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    listRepoDocs: mocks.listRepoDocs,
    readRepoDoc: mocks.readRepoDoc,
    readRepoImage: mocks.readRepoImage,
    proposeRepoDocEdit: mocks.proposeRepoDocEdit,
    proposerName: async (userId: string) => `name-of-${userId}`,
    RepoDocsError,
  };
});

import { repoDocsRoutes } from '../repoDocs.js';
import { RepoDocsError } from '../../services/repoDocs.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (req) => {
    req.userId = 'user-1';
  });
  await app.register(repoDocsRoutes);
  return app;
}

beforeEach(() => {
  mocks.permission = 'view';
  mocks.listRepoDocs.mockReset();
  mocks.readRepoDoc.mockReset();
  mocks.readRepoImage.mockReset();
  mocks.proposeRepoDocEdit.mockReset();
});

describe('POST /api/maps/:id/docs/propose (#552)', () => {
  const body = { path: 'docs/a.md', text: '# new\n', baseSha: 'b1', message: 'docs: tweak' };

  it('needs edit on the map — a viewer is refused before any forge write', async () => {
    mocks.permission = 'view';
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/maps/m1/docs/propose', payload: body });
    expect(res.statusCode).toBe(403);
    expect(mocks.proposeRepoDocEdit).not.toHaveBeenCalled();
  });

  it('an editor gets 201 with the PR; the service gets the fields and the proposer name', async () => {
    mocks.permission = 'edit';
    const result = { path: 'docs/a.md', branch: 'mindblown/docs-a-x', commitSha: 'c1', pullRequest: { number: 3, url: 'u' } };
    mocks.proposeRepoDocEdit.mockResolvedValue(result);
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/maps/m1/docs/propose', payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(result);
    expect(mocks.proposeRepoDocEdit).toHaveBeenCalledWith('m1', body, 'name-of-user-1');
  });

  it('validates the body', async () => {
    mocks.permission = 'edit';
    const app = await buildApp();
    for (const bad of [{ ...body, path: '' }, { ...body, text: 1 }, { ...body, baseSha: undefined }, { ...body, message: 5 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/maps/m1/docs/propose', payload: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(mocks.proposeRepoDocEdit).not.toHaveBeenCalled();
  });

  it('accepts a doc above the default 1 MB body limit', async () => {
    mocks.permission = 'edit';
    mocks.proposeRepoDocEdit.mockResolvedValue({});
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/maps/m1/docs/propose', payload: { ...body, text: 'x'.repeat(1_500_000) } });
    expect(res.statusCode).toBe(201);
  });

  it('a stale base is 409 CONFLICT', async () => {
    mocks.permission = 'edit';
    mocks.proposeRepoDocEdit.mockRejectedValue(new RepoDocsError(409, 'CONFLICT', 'changed'));
    const res = await (await buildApp()).inject({ method: 'POST', url: '/api/maps/m1/docs/propose', payload: body });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });
});

describe('GET /api/maps/:id/docs', () => {
  it('answers the service list for a viewer', async () => {
    const list = { repo: { owner: 'o', name: 'r', branch: 'main', webUrl: 'w' }, treeSha: 't', docs: [], truncated: false };
    mocks.listRepoDocs.mockResolvedValue(list);
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(list);
    expect(mocks.listRepoDocs).toHaveBeenCalledWith('m1');
  });

  it('refuses a user without view on the map, before any forge read', async () => {
    mocks.permission = null;
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs' });
    expect(res.statusCode).toBe(403);
    expect(mocks.listRepoDocs).not.toHaveBeenCalled();
  });

  it('maps a map without a repo to 404 NO_REPO', async () => {
    mocks.listRepoDocs.mockRejectedValue(new RepoDocsError(404, 'NO_REPO', 'This map has no repository connected'));
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_REPO');
  });
});

describe('GET /api/maps/:id/docs/file', () => {
  it('requires a path', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs/file' });
    expect(res.statusCode).toBe(400);
    expect(mocks.readRepoDoc).not.toHaveBeenCalled();
  });

  it('reads the decoded path', async () => {
    mocks.readRepoDoc.mockResolvedValue({ path: 'docs/a b.md', sha: 's', size: 1, text: '#', webUrl: 'w' });
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs/file?path=docs%2Fa%20b.md' });
    expect(res.statusCode).toBe(200);
    expect(mocks.readRepoDoc).toHaveBeenCalledWith('m1', 'docs/a b.md');
  });

  it('passes the service status through (too large → 413, forge down → 502)', async () => {
    mocks.readRepoDoc.mockRejectedValueOnce(new RepoDocsError(413, 'TOO_LARGE', 'big'));
    mocks.readRepoDoc.mockRejectedValueOnce(new RepoDocsError(502, 'FORGE_ERROR', 'down'));
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/maps/m1/docs/file?path=a.md' })).statusCode).toBe(413);
    expect((await app.inject({ method: 'GET', url: '/api/maps/m1/docs/file?path=a.md' })).statusCode).toBe(502);
  });
});

describe('GET /api/maps/:id/docs/image', () => {
  it('serves the bytes with their type, a sandboxing CSP and the blob sha as ETag', async () => {
    mocks.readRepoImage.mockResolvedValue({ bytes: new Uint8Array([60, 115, 118, 103, 62]), contentType: 'image/svg+xml', sha: 'abc' });
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/maps/m1/docs/image?path=docs/x.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.etag).toBe('"abc"');
    expect(res.body).toBe('<svg>');
    expect(mocks.readRepoImage).toHaveBeenCalledWith('m1', 'docs/x.svg');
    // Revalidated on every use — a changed image must not hide behind a cache.
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('answers 304 when the browser already holds this blob', async () => {
    mocks.readRepoImage.mockResolvedValue({ bytes: new Uint8Array([1]), contentType: 'image/png', sha: 'abc' });
    const app = await buildApp();
    const same = await app.inject({ method: 'GET', url: '/api/maps/m1/docs/image?path=a.png', headers: { 'if-none-match': '"abc"' } });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    const changed = await app.inject({ method: 'GET', url: '/api/maps/m1/docs/image?path=a.png', headers: { 'if-none-match': '"old"' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).toBe('"abc"');
  });
});
