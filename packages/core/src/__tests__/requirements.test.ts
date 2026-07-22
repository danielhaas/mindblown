import { describe, it, expect } from 'vitest';
import { collectRequirementGhLinks } from '../requirements.js';

type N = {
  id: string;
  childrenIds?: string[];
  externalLinks?: Array<{ provider: string; externalId: string; url: string }>;
};

const gh = (n: number) => ({
  provider: 'github',
  externalId: `FulcrumCRM/crm#${n}`,
  url: `https://github.com/FulcrumCRM/crm/issues/${n}`,
});

function lookup(nodes: N[]) {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => map.get(id);
}

describe('collectRequirementGhLinks', () => {
  it('returns own links, not inherited', () => {
    const get = lookup([{ id: 'r', externalLinks: [gh(1)] }]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([
      { externalId: 'FulcrumCRM/crm#1', url: expect.any(String), inherited: false },
    ]);
  });

  it('rolls up links from the work below — the 54-requirement case', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w1', 'w2'] },
      { id: 'w1', externalLinks: [gh(1)] },
      { id: 'w2', externalLinks: [gh(2)] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got.map((l) => l.externalId)).toEqual(['FulcrumCRM/crm#1', 'FulcrumCRM/crm#2']);
    expect(got.every((l) => l.inherited)).toBe(true);
  });

  it('reaches links at any depth', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['a'] },
      { id: 'a', childrenIds: ['b'] },
      { id: 'b', childrenIds: ['c'] },
      { id: 'c', externalLinks: [gh(9)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([
      { externalId: 'FulcrumCRM/crm#9', url: expect.any(String), inherited: true },
    ]);
  });

  it('own link wins over the same issue linked on a child', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w'], externalLinks: [gh(5)] },
      { id: 'w', externalLinks: [gh(5)] },
    ]);
    const got = collectRequirementGhLinks(get, 'r');
    expect(got).toHaveLength(1);
    expect(got[0].inherited).toBe(false);
  });

  it('dedupes the same issue linked on two children', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w1', 'w2'] },
      { id: 'w1', externalLinks: [gh(7)] },
      { id: 'w2', externalLinks: [gh(7)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toHaveLength(1);
  });

  it('ignores non-github providers', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['w'] },
      { id: 'w', externalLinks: [{ provider: 'jira', externalId: 'X-1', url: 'https://x' }] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toEqual([]);
  });

  it('returns empty for a bare requirement — the 36-requirement case', () => {
    expect(collectRequirementGhLinks(lookup([{ id: 'r' }]), 'r')).toEqual([]);
  });

  it('survives a cyclic tree instead of hanging', () => {
    const get = lookup([
      { id: 'r', childrenIds: ['a'] },
      { id: 'a', childrenIds: ['r'], externalLinks: [gh(3)] },
    ]);
    expect(collectRequirementGhLinks(get, 'r')).toHaveLength(1);
  });

  it('tolerates a missing node id', () => {
    expect(collectRequirementGhLinks(lookup([]), 'nope')).toEqual([]);
  });
});
