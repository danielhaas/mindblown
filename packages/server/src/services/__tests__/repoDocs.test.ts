/**
 * Repo docs service (#550): the doc filter, the read guard (only a doc the
 * tree lists), the caches that keep a polled tab cheap, and push →
 * invalidate + broadcast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ctx: null as null | 'throw' | { owner: string; repo: string; token: string; forge: unknown },
  getRepoTree: vi.fn(),
  getBlob: vi.fn(),
  defaultBranch: vi.fn(async () => 'main'),
  boundMaps: [] as { id: string }[],
  broadcast: vi.fn(),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  putFile: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock('../../lib/githubContext.js', () => ({
  getForgeContextForMap: async () => {
    if (mocks.ctx === 'throw') throw new Error('OAuth refresh failed');
    return mocks.ctx;
  },
}));
vi.mock('@mindblown/integrations', () => {
  class ForgeApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: string,
    ) {
      super(body);
    }
  }
  return { getRepoDefaultBranch: mocks.defaultBranch, ForgeApiError };
});
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcast }));
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.boundMaps }) }) },
}));

import { ForgeApiError } from '@mindblown/integrations';
import {
  _resetRepoDocsCacheForTests,
  editBranchName,
  listRepoDocs,
  onRepoPush,
  proposeRepoDocEdit,
  readRepoDoc,
  readRepoImage,
} from '../repoDocs.js';

function forge(kind: 'github' | 'gitea') {
  return {
    endpoint: { kind, apiBaseUrl: 'https://api.example', webBaseUrl: 'https://web.example' },
    getRepoTree: mocks.getRepoTree,
    getBlob: mocks.getBlob,
    createBranch: mocks.createBranch,
    deleteBranch: mocks.deleteBranch,
    putFile: mocks.putFile,
    createPullRequest: mocks.createPullRequest,
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
  mocks.createBranch.mockReset().mockResolvedValue(undefined);
  mocks.deleteBranch.mockReset().mockResolvedValue(undefined);
  mocks.putFile.mockReset().mockResolvedValue({ blobSha: 'nb', commitSha: 'c0ffee1234' });
  mocks.createPullRequest.mockReset().mockResolvedValue({ number: 7, url: 'https://web.example/o/r/pull/7' });
});

describe('proposeRepoDocEdit (#552)', () => {
  const edit = { path: 'docs/vision.md', text: '# Vision v2\n', baseSha: 'd2' };

  it('branch off the default branch → commit against the base sha → PR back; default branch untouched', async () => {
    const res = await proposeRepoDocEdit('m1', { ...edit, message: 'docs: sharpen vision' }, 'Dan');
    const branch = mocks.createBranch.mock.calls[0][2] as string;
    expect(branch).toMatch(/^mindblown\/docs-vision-\d{8}-\d{6}-[0-9a-f]{1,4}$/);
    expect(mocks.createBranch).toHaveBeenCalledWith('o', 'r', branch, 'main');
    const put = mocks.putFile.mock.calls[0][2];
    expect(put).toMatchObject({ path: 'docs/vision.md', branch, blobSha: 'd2', message: 'docs: sharpen vision' });
    expect(new TextDecoder().decode(put.content)).toBe('# Vision v2\n');
    expect(mocks.createPullRequest).toHaveBeenCalledWith('o', 'r', expect.objectContaining({ head: branch, base: 'main', title: 'docs: sharpen vision' }));
    expect(mocks.createPullRequest.mock.calls[0][2].body).toContain('by Dan');
    expect(res).toEqual({ path: 'docs/vision.md', branch, commitSha: 'c0ffee1234', pullRequest: { number: 7, url: 'https://web.example/o/r/pull/7' } });
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
  });

  it('defaults the title to "docs: update <path>"', async () => {
    await proposeRepoDocEdit('m1', edit, 'Dan');
    expect(mocks.putFile.mock.calls[0][2].message).toBe('docs: update docs/vision.md');
  });

  it('judges staleness on a fresh tree: a moved doc is CONFLICT and nothing is created', async () => {
    await listRepoDocs('m1'); // tree cached with d2
    mocks.getRepoTree.mockResolvedValue({ ...TREE, files: TREE.files.map((f) => (f.path === 'docs/vision.md' ? { ...f, sha: 'd2-new' } : f)) });
    await expect(proposeRepoDocEdit('m1', edit, 'Dan')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(mocks.createBranch).not.toHaveBeenCalled();
  });

  it('a push landing between check and commit: the forge 409 → CONFLICT, branch cleaned up', async () => {
    mocks.putFile.mockRejectedValue(new ForgeApiError(409, 'does not match'));
    await expect(proposeRepoDocEdit('m1', edit, 'Dan')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(mocks.deleteBranch).toHaveBeenCalledWith('o', 'r', mocks.createBranch.mock.calls[0][2]);
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it('a PR refusal is FORGE_ERROR and the branch is cleaned up', async () => {
    mocks.createPullRequest.mockRejectedValue(new ForgeApiError(403, 'Resource not accessible by integration'));
    await expect(proposeRepoDocEdit('m1', edit, 'Dan')).rejects.toMatchObject({ status: 502, code: 'FORGE_ERROR' });
    expect(mocks.deleteBranch).toHaveBeenCalledTimes(1);
  });

  it('unchanged text is NO_CHANGE, before any write', async () => {
    await expect(proposeRepoDocEdit('m1', { ...edit, text: '# Vision ✓' }, 'Dan')).rejects.toMatchObject({ status: 400, code: 'NO_CHANGE' });
    expect(mocks.createBranch).not.toHaveBeenCalled();
  });

  it('only an existing doc can be edited — no source files, no new paths', async () => {
    await expect(proposeRepoDocEdit('m1', { ...edit, path: 'src/index.ts', baseSha: 's1' }, 'Dan')).rejects.toMatchObject({ status: 404 });
    await expect(proposeRepoDocEdit('m1', { ...edit, path: 'docs/new.md' }, 'Dan')).rejects.toMatchObject({ status: 404 });
    expect(mocks.createBranch).not.toHaveBeenCalled();
  });

  it('refuses text over the doc cap', async () => {
    await expect(proposeRepoDocEdit('m1', { ...edit, text: 'x'.repeat(2 * 1024 * 1024 + 1) }, 'Dan')).rejects.toMatchObject({ status: 413 });
  });
});

describe('editBranchName', () => {
  it('slug of the file stem + UTC stamp + suffix', () => {
    expect(editBranchName('docs/Product Vision.md', new Date('2026-10-23T09:14:05Z'), 'a1b2')).toBe('mindblown/docs-product-vision-20261023-091405-a1b2');
    expect(editBranchName('ÄÖÜ.md', new Date('2026-10-23T09:14:05Z'), 'ff')).toBe('mindblown/docs-doc-20261023-091405-ff');
  });
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

  it('a failure resolving the forge (token refresh) is FORGE_ERROR, not a 500', async () => {
    mocks.ctx = 'throw';
    await expect(listRepoDocs('m1')).rejects.toMatchObject({ status: 502, code: 'FORGE_ERROR' });
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

  it('concurrent misses on one blob share a single forge read', async () => {
    await Promise.all([readRepoDoc('m1', 'docs/vision.md'), readRepoDoc('m1', 'docs/vision.md'), readRepoDoc('m1', 'docs/vision.md')]);
    expect(mocks.getBlob).toHaveBeenCalledTimes(1);
  });

  it('a failed blob read is not kept — the next read tries again', async () => {
    mocks.getBlob.mockRejectedValueOnce(new Error('GitHub API 500'));
    await expect(readRepoDoc('m1', 'README.md')).rejects.toMatchObject({ status: 502 });
    await expect(readRepoDoc('m1', 'README.md')).resolves.toMatchObject({ sha: 'd1' });
  });
});

describe('readRepoImage', () => {
  it('serves an image the tree lists, typed by extension', async () => {
    const img = await readRepoImage('m1', 'docs/img/flow.png');
    expect(img.contentType).toBe('image/png');
    expect(img.sha).toBe('i1');
  });

  it('refuses a non-image path, prototype names included', async () => {
    await expect(readRepoImage('m1', 'src/index.ts')).rejects.toMatchObject({ status: 404 });
    await expect(readRepoImage('m1', 'x.constructor')).rejects.toMatchObject({ status: 404 });
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
