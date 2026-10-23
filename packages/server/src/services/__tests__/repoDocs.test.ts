/**
 * Repo docs service (#550): the doc filter, the read guard (only a doc the
 * tree lists), the caches that keep a polled tab cheap, and push →
 * invalidate + broadcast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ctx: null as null | { owner: string; repo: string; token: string; forge: unknown },
  getRepoTree: vi.fn(),
  getBlob: vi.fn(),
  defaultBranch: vi.fn(async () => 'main'),
  boundMaps: [] as { id: string }[],
  broadcast: vi.fn(),
}));

vi.mock('../../lib/githubContext.js', () => ({ getForgeContextForMap: async () => mocks.ctx }));
vi.mock('@mindblown/integrations', () => ({ getRepoDefaultBranch: mocks.defaultBranch }));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcast }));
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.boundMaps }) }) },
}));

import { _resetRepoDocsCacheForTests, listRepoDocs, onRepoPush, readRepoDoc, readRepoImage } from '../repoDocs.js';

function forge(kind: 'github' | 'gitea') {
  return {
    endpoint: { kind, apiBaseUrl: 'https://api.example', webBaseUrl: 'https://web.example' },
    getRepoTree: mocks.getRepoTree,
    getBlob: mocks.getBlob,
  };
}

const TREE = {
  sha: 'tree1',
  truncated: false,
  files: [
    { path: 'src/index.ts', sha: 's1', size: 10 },
    { path: 'docs/vision.md', sha: 'd2', size: 12 },
    { path: 'README.md', sha: 'd1', size: 8 },
    { path: 'CHANGES.MARKDOWN', sha: 'd3', size: 3 },
    { path: 'docs/img/flow.png', sha: 'i1', size: 4 },
    { path: 'docs/huge.md', sha: 'h1', size: 3 * 1024 * 1024 },
  ],
};

beforeEach(() => {
  _resetRepoDocsCacheForTests();
  mocks.ctx = { owner: 'o', repo: 'r', token: 't', forge: forge('github') };
  mocks.getRepoTree.mockReset().mockResolvedValue(TREE);
  mocks.getBlob.mockReset().mockImplementation(async () => new TextEncoder().encode('# Vision ✓'));
  mocks.defaultBranch.mockClear();
  mocks.broadcast.mockReset();
  mocks.boundMaps = [];
});

describe('listRepoDocs', () => {
  it('lists markdown files only, sorted, with the default branch and repo link', async () => {
    const res = await listRepoDocs('m1');
    expect(res.docs.map((d) => d.path)).toEqual(['CHANGES.MARKDOWN', 'docs/huge.md', 'docs/vision.md', 'README.md']);
    expect(res.repo).toEqual({ owner: 'o', name: 'r', branch: 'main', webUrl: 'https://web.example/o/r' });
    expect(res.treeSha).toBe('tree1');
    expect(mocks.getRepoTree).toHaveBeenCalledWith('o', 'r', 'main');
  });

  it('a map without a repo is NO_REPO', async () => {
    mocks.ctx = null;
    await expect(listRepoDocs('m1')).rejects.toMatchObject({ status: 404, code: 'NO_REPO' });
  });

  it('a forge failure is FORGE_ERROR and is not cached', async () => {
    mocks.getRepoTree.mockRejectedValueOnce(new Error('GitHub API 401'));
    await expect(listRepoDocs('m1')).rejects.toMatchObject({ status: 502, code: 'FORGE_ERROR' });
    await expect(listRepoDocs('m1')).resolves.toMatchObject({ treeSha: 'tree1' });
  });

  it('several reads within the TTL cost one tree call', async () => {
    await Promise.all([listRepoDocs('m1'), listRepoDocs('m1')]);
    await listRepoDocs('m1');
    expect(mocks.getRepoTree).toHaveBeenCalledTimes(1);
  });
});

describe('readRepoDoc', () => {
  it('reads a listed doc as UTF-8 with its forge link (GitHub blob URL)', async () => {
    const doc = await readRepoDoc('m1', 'docs/vision.md');
    expect(doc).toEqual({
      path: 'docs/vision.md',
      sha: 'd2',
      size: 12,
      text: '# Vision ✓',
      webUrl: 'https://web.example/o/r/blob/main/docs/vision.md',
    });
    expect(mocks.getBlob).toHaveBeenCalledWith('o', 'r', 'd2');
  });

  it('links Gitea files under src/branch', async () => {
    mocks.ctx = { owner: 'o', repo: 'r', token: 't', forge: forge('gitea') };
    expect((await readRepoDoc('m1', 'README.md')).webUrl).toBe('https://web.example/o/r/src/branch/main/README.md');
  });

  it('refuses a path that is not a doc in the tree — source files included', async () => {
    await expect(readRepoDoc('m1', 'src/index.ts')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(readRepoDoc('m1', 'docs/missing.md')).rejects.toMatchObject({ status: 404 });
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });

  it('refuses an oversized doc without fetching it', async () => {
    await expect(readRepoDoc('m1', 'docs/huge.md')).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });

  it('caches blobs by sha — a second read is free', async () => {
    await readRepoDoc('m1', 'docs/vision.md');
    await readRepoDoc('m1', 'docs/vision.md');
    expect(mocks.getBlob).toHaveBeenCalledTimes(1);
  });
});

describe('readRepoImage', () => {
  it('serves an image the tree lists, typed by extension', async () => {
    const img = await readRepoImage('m1', 'docs/img/flow.png');
    expect(img.contentType).toBe('image/png');
    expect(img.sha).toBe('i1');
  });

  it('refuses a non-image path', async () => {
    await expect(readRepoImage('m1', 'src/index.ts')).rejects.toMatchObject({ status: 404 });
  });
});

describe('onRepoPush', () => {
  it('a push to the default branch drops the cached tree and tells every bound map', async () => {
    await listRepoDocs('m1');
    mocks.boundMaps = [{ id: 'm1' }, { id: 'm2' }];
    const n = await onRepoPush('o/r', { ref: 'refs/heads/main', repository: { default_branch: 'main' } });
    expect(n).toBe(2);
    expect(mocks.broadcast).toHaveBeenCalledWith('m1', { type: 'docs:updated' });
    expect(mocks.broadcast).toHaveBeenCalledWith('m2', { type: 'docs:updated' });
    await listRepoDocs('m1');
    expect(mocks.getRepoTree).toHaveBeenCalledTimes(2);
  });

  it('a push to another branch changes nothing', async () => {
    mocks.boundMaps = [{ id: 'm1' }];
    expect(await onRepoPush('o/r', { ref: 'refs/heads/feature', repository: { default_branch: 'main' } })).toBe(0);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
