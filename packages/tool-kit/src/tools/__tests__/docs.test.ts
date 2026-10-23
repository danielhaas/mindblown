import { describe, expect, it } from 'vitest';
import type { RepoDocsList, RepoDocText, ToolBackend } from '../../backend.js';
import { allTools } from '../../index.js';
import { listDocsTool, readDocTool } from '../docs.js';

const LIST: RepoDocsList = {
  repo: { owner: 'o', name: 'r', branch: 'main', webUrl: 'https://github.com/o/r' },
  treeSha: 't1',
  docs: [
    { path: 'README.md', sha: 'a', size: 120 },
    { path: 'docs/vision.md', sha: 'b', size: 4096 },
  ],
  truncated: false,
};

function backendWith(doc?: RepoDocText): { backend: ToolBackend; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const backend = {
    listRepoDocs: async (mapId: string) => {
      calls.push(['list', mapId]);
      return LIST;
    },
    readRepoDoc: async (mapId: string, path: string) => {
      calls.push(['read', mapId, path]);
      return doc!;
    },
  } as unknown as ToolBackend;
  return { backend, calls };
}

describe('list_docs / read_doc', () => {
  it('are registered on the shared surface (MCP + chat)', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toContain('list_docs');
    expect(names).toContain('read_doc');
  });

  it('list_docs prints repo, branch and every path', async () => {
    const { backend, calls } = backendWith();
    const out = await listDocsTool.handler(backend, { mapId: 'm' });
    expect(calls).toEqual([['list', 'm']]);
    expect(out).toContain('2 docs in o/r @ main');
    expect(out).toContain('- README.md (120 bytes)');
    expect(out).toContain('- docs/vision.md (4 KB)');
    expect(out).not.toContain('NOTE');
  });

  it('list_docs says when the tree was cut short', async () => {
    const backend = { listRepoDocs: async () => ({ ...LIST, truncated: true }) } as unknown as ToolBackend;
    expect(await listDocsTool.handler(backend, { mapId: 'm' })).toContain('some docs are missing');
  });

  it('read_doc pages the text and names the next offset', async () => {
    const { backend, calls } = backendWith({ path: 'docs/vision.md', sha: 'b', size: 30, text: 'x'.repeat(30), webUrl: 'https://github.com/o/r/blob/main/docs/vision.md' });
    const out = await readDocTool.handler(backend, { mapId: 'm', path: 'docs/vision.md', offset: 5, maxChars: 10 });
    expect(calls).toEqual([['read', 'm', 'docs/vision.md']]);
    expect(out).toContain('# docs/vision.md (30 bytes) — chars 5–14 of 30');
    expect(out).toContain('https://github.com/o/r/blob/main/docs/vision.md');
    expect(out).toContain('\n\n' + 'x'.repeat(10) + '\n\n[15 characters remain — call read_doc again with offset 15]');
  });

  it('read_doc returns a short doc whole, without a continue hint', async () => {
    const { backend } = backendWith({ path: 'README.md', sha: 'a', size: 8, text: '# Hello\n', webUrl: 'u' });
    const out = await readDocTool.handler(backend, { mapId: 'm', path: 'README.md' });
    expect(out).toContain('chars 0–7 of 8');
    expect(out.endsWith('# Hello\n')).toBe(true);
  });
});
