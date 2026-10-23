import { describe, expect, it } from 'vitest';
import { defaultDoc, filterDocs, groupDocs, headingSlug, resolveRepoLink, siblingWebUrl } from '../docs.js';

const d = (path: string) => ({ path, sha: path, size: 1 });

describe('groupDocs', () => {
  it('root first, directories by name, README leading each', () => {
    const groups = groupDocs([d('docs/zeta.md'), d('docs/README.md'), d('CHANGELOG.md'), d('README.md'), d('adr/001.md')]);
    expect(groups.map((g) => g.dir)).toEqual(['', 'adr', 'docs']);
    expect(groups[0].docs.map((x) => x.path)).toEqual(['README.md', 'CHANGELOG.md']);
    expect(groups[2].docs.map((x) => x.path)).toEqual(['docs/README.md', 'docs/zeta.md']);
  });
});

describe('defaultDoc', () => {
  it('opens the root README', () => {
    expect(defaultDoc([d('docs/a.md'), d('readme.md')])).toBe('readme.md');
  });
  it('else the first doc of the first group', () => {
    expect(defaultDoc([d('docs/b.md'), d('docs/a.md')])).toBe('docs/a.md');
    expect(defaultDoc([])).toBeNull();
  });
});

describe('filterDocs', () => {
  it('matches the path case-insensitively', () => {
    expect(filterDocs([d('docs/Vision.md'), d('README.md')], 'vis').map((x) => x.path)).toEqual(['docs/Vision.md']);
    expect(filterDocs([d('a.md')], '  ')).toHaveLength(1);
  });
});

describe('resolveRepoLink', () => {
  it('resolves relative to the doc, with ./ and ../', () => {
    expect(resolveRepoLink('docs/guide/a.md', 'b.md')).toEqual({ path: 'docs/guide/b.md', hash: null });
    expect(resolveRepoLink('docs/guide/a.md', './img/x.png')).toEqual({ path: 'docs/guide/img/x.png', hash: null });
    expect(resolveRepoLink('docs/guide/a.md', '../../README.md#setup')).toEqual({ path: 'README.md', hash: 'setup' });
  });

  it('a leading slash is the repo root; encoded names decode; queries drop', () => {
    expect(resolveRepoLink('docs/a.md', '/CLAUDE.md')).toEqual({ path: 'CLAUDE.md', hash: null });
    expect(resolveRepoLink('a.md', 'my%20notes.md?plain=1')).toEqual({ path: 'my notes.md', hash: null });
  });

  it('leaves the repo → null', () => {
    expect(resolveRepoLink('a.md', 'https://example.com/x.md')).toBeNull();
    expect(resolveRepoLink('a.md', 'mailto:x@y.z')).toBeNull();
    expect(resolveRepoLink('a.md', '//cdn.example/x.png')).toBeNull();
    expect(resolveRepoLink('a.md', '#local')).toBeNull();
    expect(resolveRepoLink('a.md', '../outside.md')).toBeNull();
  });
});

describe('siblingWebUrl', () => {
  it('swaps the doc path for the target on the same branch (GitHub and Gitea shapes)', () => {
    expect(siblingWebUrl('https://github.com/o/r/blob/main/docs/a%20b.md', 'docs/a b.md', { path: 'src/x.ts', hash: 'L3' })).toBe(
      'https://github.com/o/r/blob/main/src/x.ts#L3',
    );
    expect(siblingWebUrl('https://git.example/o/r/src/branch/main/README.md', 'README.md', { path: 'spec.pdf', hash: null })).toBe(
      'https://git.example/o/r/src/branch/main/spec.pdf',
    );
  });
  it('null when the URL does not end in the doc path', () => {
    expect(siblingWebUrl('https://x/other.md', 'README.md', { path: 'a', hash: null })).toBeNull();
  });
});

describe('headingSlug', () => {
  it('follows GitHub anchors', () => {
    expect(headingSlug('Feature Definition of Done')).toBe('feature-definition-of-done');
    expect(headingSlug('When adding a field to `Node`')).toBe('when-adding-a-field-to-node');
    expect(headingSlug('Ä/B — test')).toBe('äb--test');
  });
});
