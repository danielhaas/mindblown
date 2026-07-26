import { describe, it, expect } from 'vitest';
import { computeReleaseComposition } from '../releaseComposition.js';
import type { CompositionNode } from '../releaseComposition.js';

const V1 = 'ver-1';
const V2 = 'ver-2';

function node(partial: Partial<CompositionNode> & { id: string }): CompositionNode {
  return {
    parentId: null,
    childrenIds: [],
    text: partial.id,
    ...partial,
  };
}

const gh = (n: number) => ({
  provider: 'github',
  externalId: `acme/repo#${n}`,
  url: `https://github.com/acme/repo/issues/${n}`,
});

describe('computeReleaseComposition', () => {
  it('splits a release into requirement work and the rest', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['req', 'bug'] }),
      node({ id: 'req', parentId: 'root', requirementId: 'PER-01', childrenIds: ['w1'], text: 'Personen' }),
      node({ id: 'w1', parentId: 'req', versionId: V1, effortEstimate: 2, percentComplete: 100 }),
      node({ id: 'bug', parentId: 'root', versionId: V1, effortEstimate: 1, percentComplete: 0, tags: ['type:bug'] }),
    ];

    const c = computeReleaseComposition(nodes, V1);

    expect(c.requirementWork.count).toBe(1);
    expect(c.otherWork.count).toBe(1);
    expect(c.coveragePct).toBe(50);
    expect(c.byRequirement).toHaveLength(1);
    expect(c.byRequirement[0].requirementId).toBe('PER-01');
    expect(c.byClassification).toEqual([
      { label: 'bug', count: 1, openCount: 1, effort: 1 },
    ]);
  });

  it('attributes a ticket that shares an issue with a requirement but lives elsewhere', () => {
    // The case the whole module exists for: the tree is organised by
    // functional area, so implementation tickets sit far from their
    // requirement. Only the issue link connects them.
    const nodes = [
      node({ id: 'root', childrenIds: ['reqs', 'work'] }),
      node({ id: 'reqs', parentId: 'root', childrenIds: ['req'] }),
      node({ id: 'req', parentId: 'reqs', requirementId: 'SPG-06', externalLinks: [gh(1313)] }),
      node({ id: 'work', parentId: 'root', childrenIds: ['t1'] }),
      node({ id: 't1', parentId: 'work', versionId: V1, externalLinks: [gh(1313)], effortEstimate: 3 }),
    ];

    const c = computeReleaseComposition(nodes, V1);

    expect(c.coveragePct).toBe(100);
    expect(c.otherWork.count).toBe(0);
    expect(c.byRequirement[0].requirementId).toBe('SPG-06');
  });

  it('follows issue links a requirement inherits from its own children', () => {
    // collectRequirementGhLinks rolls up descendants' links; a ticket
    // matching one of those must attribute to the requirement too.
    const nodes = [
      node({ id: 'root', childrenIds: ['req', 't1'] }),
      node({ id: 'req', parentId: 'root', requirementId: 'DOK-08', childrenIds: ['sub'] }),
      node({ id: 'sub', parentId: 'req', externalLinks: [gh(2936)] }),
      node({ id: 't1', parentId: 'root', versionId: V1, externalLinks: [gh(2936)] }),
    ];

    expect(computeReleaseComposition(nodes, V1).coveragePct).toBe(100);
  });

  it('attributes across releases — a V1 ticket may implement a V2 requirement', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['req', 't1'] }),
      node({ id: 'req', parentId: 'root', requirementId: 'MAN-11', versionId: V2, externalLinks: [gh(491)] }),
      node({ id: 't1', parentId: 'root', versionId: V1, externalLinks: [gh(491)] }),
    ];

    expect(computeReleaseComposition(nodes, V1).coveragePct).toBe(100);
  });

  it('inherits release membership from the nearest tagged ancestor', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['epic'] }),
      node({ id: 'epic', parentId: 'root', versionId: V1, childrenIds: ['a', 'b'] }),
      node({ id: 'a', parentId: 'epic' }),
      // An explicit tag on the leaf overrides the epic — it was pulled out.
      node({ id: 'b', parentId: 'epic', versionId: V2 }),
    ];

    const c = computeReleaseComposition(nodes, V1);
    expect(c.otherWork.count).toBe(1);
    expect(c.unattributed[0].nodeId).toBe('a');
  });

  it('counts only leaves — a tagged epic is not its own line item', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['epic'] }),
      node({ id: 'epic', parentId: 'root', versionId: V1, childrenIds: ['a'], effortEstimate: 99 }),
      node({ id: 'a', parentId: 'epic', effortEstimate: 2 }),
    ];

    const c = computeReleaseComposition(nodes, V1);
    expect(c.otherWork.count).toBe(1);
    expect(c.otherWork.effort).toBe(2);
  });

  it('reports unestimated leaves instead of counting them as zero-effort work', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['a', 'b'] }),
      node({ id: 'a', parentId: 'root', versionId: V1, effortEstimate: 4, percentComplete: 50 }),
      node({ id: 'b', parentId: 'root', versionId: V1, percentComplete: 100 }),
    ];

    const c = computeReleaseComposition(nodes, V1);
    expect(c.otherWork).toMatchObject({
      count: 2,
      openCount: 1,
      effort: 4,
      doneEffort: 2,
      unestimated: 1,
    });
  });

  it('buckets work without a type tag as unclassified rather than guessing', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['a', 'b'] }),
      // Looks exactly like a bug. Carries no tag saying so.
      node({ id: 'a', parentId: 'root', versionId: V1, text: 'fix(compliance): AIA gate is broken' }),
      node({ id: 'b', parentId: 'root', versionId: V1, text: 'CI hardening', tags: ['area:backend'] }),
    ];

    const c = computeReleaseComposition(nodes, V1);
    expect(c.byClassification).toEqual([
      { label: 'unclassified', count: 2, openCount: 2, effort: 0 },
    ]);
  });

  it('honours a custom tag prefix and unclassified label', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['a'] }),
      node({ id: 'a', parentId: 'root', versionId: V1, tags: ['kind:chore'] }),
    ];

    const c = computeReleaseComposition(nodes, V1, {
      typeTagPrefix: 'kind:',
      unclassifiedLabel: 'unbekannt',
    });
    expect(c.byClassification[0].label).toBe('chore');
  });

  it('sorts unattributed work open-first, biggest-first', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['done', 'small', 'big'] }),
      node({ id: 'done', parentId: 'root', versionId: V1, effortEstimate: 9, percentComplete: 100 }),
      node({ id: 'small', parentId: 'root', versionId: V1, effortEstimate: 1, percentComplete: 0 }),
      node({ id: 'big', parentId: 'root', versionId: V1, effortEstimate: 5, percentComplete: 0 }),
    ];

    expect(computeReleaseComposition(nodes, V1).unattributed.map((u) => u.nodeId)).toEqual([
      'big',
      'small',
      'done',
    ]);
  });

  it('returns null coverage for an empty release — no work supports no claim', () => {
    const nodes = [node({ id: 'root', childrenIds: [] })];
    const c = computeReleaseComposition(nodes, V1);
    expect(c.coveragePct).toBeNull();
    expect(c.requirementWork.count).toBe(0);
  });

  it('survives a malformed parent chain instead of hanging', () => {
    const nodes = [
      node({ id: 'a', parentId: 'b', versionId: V1 }),
      node({ id: 'b', parentId: 'a' }),
    ];
    expect(() => computeReleaseComposition(nodes, V1)).not.toThrow();
  });

  it('does not double-count an issue claimed by two requirements', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['r1', 'r2', 't1'] }),
      node({ id: 'r1', parentId: 'root', requirementId: 'A-01', externalLinks: [gh(7)] }),
      node({ id: 'r2', parentId: 'root', requirementId: 'B-01', externalLinks: [gh(7)] }),
      node({ id: 't1', parentId: 'root', versionId: V1, externalLinks: [gh(7)], effortEstimate: 2 }),
    ];

    const c = computeReleaseComposition(nodes, V1);
    expect(c.requirementWork.count).toBe(1);
    expect(c.byRequirement).toHaveLength(1);
    expect(c.byRequirement.reduce((s, r) => s + r.count, 0)).toBe(1);
  });

  it('ignores non-github external links when joining', () => {
    const nodes = [
      node({ id: 'root', childrenIds: ['req', 't1'] }),
      node({ id: 'req', parentId: 'root', requirementId: 'A-01', externalLinks: [gh(7)] }),
      node({
        id: 't1',
        parentId: 'root',
        versionId: V1,
        externalLinks: [{ provider: 'jira', externalId: 'acme/repo#7', url: 'https://jira/7' }],
      }),
    ];

    expect(computeReleaseComposition(nodes, V1).coveragePct).toBe(0);
  });
});
