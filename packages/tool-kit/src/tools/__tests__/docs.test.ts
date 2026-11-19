import { describe, expect, it } from 'vitest';
import type { RepoDocsList, RepoDocText, ToolBackend } from '../../backend.js';
import { allTools } from '../../index.js';
import { listDocsTool, proposeDocEditTool, readDocTool } from '../docs.js';

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
  it('are registered on the shared (MCP) surface', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toContain('list_docs');
    expect(names).toContain('read_doc');
    expect(names).toContain('propose_doc_edit');
  });

  it('read_doc prints the sha an edit needs', async () => {
    const { backend } = backendWith({ path: 'README.md', sha: 'abc123', size: 8, text: '# Hello\n', utf8: true, webUrl: 'u' });
    expect(await readDocTool.handler(backend, { mapId: 'm', path: 'README.md' })).toContain('sha abc123');
  });

  it('read_doc warns when the doc is not UTF-8', async () => {
    const { backend } = backendWith({ path: 'old.md', sha: 'a', size: 4, text: 'caf\uFFFD', utf8: false, webUrl: 'u' });
    const out = await readDocTool.handler(backend, { mapId: 'm', path: 'old.md' });
    expect(out).toContain('sha a');
    expect(out).toMatch(/Not UTF-8 .*propose_doc_edit refuses it/);
  });

  it('propose_doc_edit refuses a drastic shrink (one page of a paged doc) unless allowed', async () => {
    const calls: unknown[] = [];
    const backend = {
      readRepoDoc: async () => ({ path: 'README.md', sha: 'a', size: 1000, text: 'x'.repeat(1000), utf8: true, webUrl: 'u' }),
      proposeRepoDocEdit: async (...a: unknown[]) => {
        calls.push(a);
        return { path: 'README.md', branch: 'b', commitSha: 'c0ffee1', pullRequest: { number: 1, url: 'u' } };
      },
    } as unknown as ToolBackend;
    const refused = await proposeDocEditTool.handler(backend, { mapId: 'm', path: 'README.md', text: 'x'.repeat(300), baseSha: 'a' });
    expect(refused).toMatch(/^Refused: .*less than half/);
    expect(calls).toHaveLength(0);
    await proposeDocEditTool.handler(backend, { mapId: 'm', path: 'README.md', text: 'x'.repeat(300), baseSha: 'a', allowLargeDeletion: true });
    expect(calls).toHaveLength(1);
  });

  it('propose_doc_edit forwards the edit and prints the PR', async () => {
    const calls: unknown[] = [];
    const backend = {
      readRepoDoc: async () => ({ path: 'README.md', sha: 'a', size: 5, text: '# Hi\n', utf8: true, webUrl: 'u' }),
      proposeRepoDocEdit: async (mapId: string, input: unknown) => {
        calls.push([mapId, input]);
        return { path: 'README.md', branch: 'mindblown/docs-readme-x', commitSha: 'c0ffee1234', pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' } };
      },
    } as unknown as ToolBackend;
    const out = await proposeDocEditTool.handler(backend, { mapId: 'm', path: 'README.md', text: '# Hi\n', baseSha: 'a' });
    expect(calls).toEqual([['m', { path: 'README.md', text: '# Hi\n', baseSha: 'a', message: undefined }]]);
    expect(out).toContain('Opened PR #12 for README.md: https://github.com/o/r/pull/12');
    expect(out).toContain('branch mindblown/docs-readme-x · commit c0ffee1');
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
    const { backend, calls } = backendWith({ path: 'docs/vision.md', sha: 'b', size: 30, text: 'x'.repeat(30), utf8: true, webUrl: 'https://github.com/o/r/blob/main/docs/vision.md' });
    const out = await readDocTool.handler(backend, { mapId: 'm', path: 'docs/vision.md', offset: 5, maxChars: 10 });
    expect(calls).toEqual([['read', 'm', 'docs/vision.md']]);
    expect(out).toContain('# docs/vision.md (30 bytes) — chars 5–14 of 30');
    expect(out).toContain('https://github.com/o/r/blob/main/docs/vision.md');
    expect(out).toContain('\n\n' + 'x'.repeat(10) + '\n\n[15 characters remain — call read_doc again with offset 15. To edit, propose_doc_edit needs the complete text, not this page.]');
  });

  it('read_doc returns a short doc whole, without a continue hint', async () => {
    const { backend } = backendWith({ path: 'README.md', sha: 'a', size: 8, text: '# Hello\n', utf8: true, webUrl: 'u' });
    const out = await readDocTool.handler(backend, { mapId: 'm', path: 'README.md' });
    expect(out).toContain('chars 0–7 of 8');
    expect(out.endsWith('# Hello\n')).toBe(true);
  });
});
