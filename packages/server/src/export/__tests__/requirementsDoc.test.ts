/**
 * Pure register-data tests for the requirements export: verdict rendering
 * (✓ / ✗ with comment) and staleness suffix in the Abnahme column.
 */
import { describe, it, expect } from 'vitest';
import type { Node, MindMap, ComputedNodeValues, NodeId } from '@mindblown/core';
import { buildRegisterData, acceptanceIsStale, renderMarkdown } from '../requirementsDoc.js';

let seq = 0;
function makeNode(overrides: Partial<Node> & { id: string }): Node {
  seq++;
  return {
    mapId: 'm1',
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
    effortEstimate: null,
    actualEffort: null,
    percentComplete: null,
    status: null,
    blockedReason: null,
    assigneeIds: [],
    priority: null,
    dueDate: null,
    startDate: null,
    tags: [],
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    collapsed: false,
    x: seq,
    y: seq,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    verificationText: null,
    verificationUrl: null,
    claimedBySession: null,
    claimedAt: null,
    revision: 0,
    ...overrides,
  } as Node;
}

const map = { name: 'Testmap', rootNodeId: 'root' } as MindMap;

function build(nodes: Node[], acceptances: Parameters<typeof buildRegisterData>[3]) {
  const computed = new Map<NodeId, ComputedNodeValues>();
  return buildRegisterData(map, nodes, computed, acceptances);
}

const baseAcc = {
  userId: 'u1',
  userName: 'T. Muster',
  acceptedAt: '2026-07-17T10:00:00Z',
  progressAtAcceptance: 100,
  nodeRevisionAtAcceptance: 3,
};

describe('buildRegisterData — Abnahme verdicts', () => {
  const nodes = [
    makeNode({ id: 'root', childrenIds: ['ch'] }),
    makeNode({ id: 'ch', parentId: 'root', childrenIds: ['r1'], text: 'Bereich' }),
    makeNode({
      id: 'r1',
      parentId: 'ch',
      requirementId: 'MAN-01',
      percentComplete: 100,
      revision: 3,
    }),
  ];

  it('renders an acceptance as ✓ without comment', () => {
    const data = build(nodes, [{ ...baseAcc, nodeId: 'r1', decision: 'accepted' }]);
    expect(data.chapters[0].rows[0].abnahme).toEqual(['T. Muster ✓ 17.07.']);
  });

  it('renders a rejection as ✗ with the truncated comment', () => {
    const data = build(nodes, [
      { ...baseAcc, nodeId: 'r1', decision: 'rejected', comment: 'Rollen-Dropdown speichert nicht' },
    ]);
    expect(data.chapters[0].rows[0].abnahme).toEqual([
      'T. Muster ✗ 17.07. («Rollen-Dropdown speichert nicht»)',
    ]);
  });

  it('treats rows without a decision (pre-migration shape) as accepted', () => {
    const data = build(nodes, [{ ...baseAcc, nodeId: 'r1' }]);
    expect(data.chapters[0].rows[0].abnahme[0]).toContain('✓');
  });

  it('suffixes ⚠ when the requirement changed after the verdict', () => {
    const data = build(nodes, [
      { ...baseAcc, nodeId: 'r1', decision: 'rejected', comment: 'kaputt', nodeRevisionAtAcceptance: 1 },
    ]);
    expect(data.chapters[0].rows[0].abnahme[0]).toMatch(/⚠$/);
  });

  it('renders verdicts into the markdown table', () => {
    const data = build(nodes, [
      { ...baseAcc, nodeId: 'r1', decision: 'rejected', comment: 'kaputt' },
    ]);
    const md = renderMarkdown(data);
    expect(md).toContain('T. Muster ✗ 17.07. («kaputt»)');
  });
});

describe('buildRegisterData — Release column', () => {
  const versions = [
    { id: 'v1', name: 'V1' },
    { id: 'v2', name: 'V2' },
  ] as Parameters<typeof buildRegisterData>[4];

  const withChildren = (reqOverrides: Partial<Node>, childVersions: Array<string | null>) => {
    const childIds = childVersions.map((_, i) => `c${i}`);
    return [
      makeNode({ id: 'root', childrenIds: ['ch'] }),
      makeNode({ id: 'ch', parentId: 'root', childrenIds: ['r1'], text: 'Bereich' }),
      makeNode({ id: 'r1', parentId: 'ch', requirementId: 'MAN-01', childrenIds: childIds, ...reqOverrides }),
      ...childVersions.map((v, i) => makeNode({ id: `c${i}`, parentId: 'r1', versionId: v })),
    ];
  };

  const release = (nodes: Node[]) => {
    const computed = new Map<NodeId, ComputedNodeValues>();
    return buildRegisterData(map, nodes, computed, [], versions).chapters[0].rows[0].release;
  };

  it('uses the version tagged on the requirement itself', () => {
    expect(release(withChildren({ versionId: 'v1' }, ['v2']))).toBe('V1');
  });

  it('inherits a unanimous version from the work below', () => {
    expect(release(withChildren({}, ['v2', 'v2']))).toBe('↳ V2');
  });

  it('reports a count when the requirement is split across releases', () => {
    expect(release(withChildren({}, ['v1', 'v2']))).toBe('↳ 2 Releases');
  });

  it('renders — when nothing below it is scheduled', () => {
    expect(release(withChildren({}, [null]))).toBe('—');
  });
});

describe('buildRegisterData — status detail', () => {
  const req = (percentComplete: number | null) => [
    makeNode({ id: 'root', childrenIds: ['ch'] }),
    makeNode({ id: 'ch', parentId: 'root', childrenIds: ['r1'], text: 'Bereich' }),
    makeNode({ id: 'r1', parentId: 'ch', requirementId: 'MAN-01', percentComplete }),
  ];
  const detail = (p: number | null) =>
    buildRegisterData(map, req(p), new Map(), []).chapters[0].rows[0].statusDetail;

  it('appends the derived percentage to partial rows', () => {
    expect(detail(42)).toBe('Teilweise · 42 %');
  });

  it('leaves Umgesetzt and Offen without a percentage', () => {
    expect(detail(100)).toBe('Umgesetzt');
    expect(detail(null)).toBe('Offen');
  });
});

describe('buildRegisterData — filters (export mirrors the filter bar)', () => {
  const versions = [
    { id: 'v2', name: 'V2', sortOrder: 1, targetDate: null },
    { id: 'v1', name: 'V1', sortOrder: 0, targetDate: null },
  ] as Parameters<typeof buildRegisterData>[4];

  // MAN-01 done+v1 · MAN-02 partial+v2 · MAN-03 open, v1 via child ·
  // MAN-04 open, unscheduled, priority could.
  const nodes = [
    makeNode({ id: 'root', childrenIds: ['ch'] }),
    makeNode({ id: 'ch', parentId: 'root', childrenIds: ['r1', 'r2', 'r3', 'r4'], text: 'Bereich' }),
    makeNode({ id: 'r1', parentId: 'ch', requirementId: 'MAN-01', requirementPriority: 'must', percentComplete: 100, versionId: 'v1' }),
    makeNode({ id: 'r2', parentId: 'ch', requirementId: 'MAN-02', requirementPriority: 'must', percentComplete: 50, versionId: 'v2' }),
    makeNode({ id: 'r3', parentId: 'ch', requirementId: 'MAN-03', childrenIds: ['r3c'] }),
    makeNode({ id: 'r3c', parentId: 'r3', versionId: 'v1', percentComplete: 0 }),
    makeNode({ id: 'r4', parentId: 'ch', requirementId: 'MAN-04', requirementPriority: 'could', percentComplete: 0 }),
  ];

  const acceptances = [
    { ...baseAcc, nodeId: 'r1', userId: 'u1', decision: 'accepted' as const, nodeRevisionAtAcceptance: 0 },
    { ...baseAcc, nodeId: 'r2', userId: 'u2', decision: 'rejected' as const, comment: 'Falsche Maske', nodeRevisionAtAcceptance: 0 },
  ];

  const buildF = (filter: Parameters<typeof buildRegisterData>[5]) =>
    buildRegisterData(map, nodes, new Map(), acceptances, versions, filter);
  const ids = (filter: Parameters<typeof buildRegisterData>[5]) =>
    buildF(filter).chapters.flatMap((c) => c.rows.map((r) => r.id));

  it('includes everything and no label when unfiltered', () => {
    const data = buildF({});
    expect(data.total).toBe(4);
    expect(data.totalAll).toBe(4);
    expect(data.filterLabel).toBeNull();
  });

  it('filters by derived status', () => {
    expect(ids({ status: 'done' })).toEqual(['MAN-01']);
    expect(ids({ status: 'partial' })).toEqual(['MAN-02']);
    expect(ids({ status: 'open' })).toEqual(['MAN-03', 'MAN-04']);
  });

  it('hideDone drops implemented requirements', () => {
    expect(ids({ hideDone: true })).toEqual(['MAN-02', 'MAN-03', 'MAN-04']);
  });

  it('filters by MoSCoW priority', () => {
    expect(ids({ priority: 'could' })).toEqual(['MAN-04']);
  });

  it('release exact matches own and descendant versions', () => {
    expect(ids({ release: 'v1', releaseMode: 'exact' })).toEqual(['MAN-01', 'MAN-03']);
  });

  it('release cumulative includes everything due by that release, and is the default', () => {
    expect(ids({ release: 'v2', releaseMode: 'cumulative' })).toEqual(['MAN-01', 'MAN-02', 'MAN-03']);
    expect(ids({ release: 'v1' })).toEqual(['MAN-01', 'MAN-03']);
  });

  it('release "none" keeps only requirements unscheduled through their whole subtree', () => {
    expect(ids({ release: 'none' })).toEqual(['MAN-04']);
  });

  it('acceptance filters mirror the register UI', () => {
    expect(ids({ acceptance: 'rejected' })).toEqual(['MAN-02']);
    expect(ids({ acceptance: 'none' })).toEqual(['MAN-03', 'MAN-04']);
    expect(ids({ acceptance: 'mine-open', currentUserId: 'u1' })).toEqual(['MAN-02', 'MAN-03', 'MAN-04']);
  });

  it('counts reflect the filtered set, totalAll the whole register', () => {
    const data = buildF({ hideDone: true });
    expect(data.total).toBe(3);
    expect(data.totalAll).toBe(4);
    expect(data.counts).toEqual({ Umgesetzt: 0, Teilweise: 1, Offen: 2 });
  });

  it('describes the active filter in German', () => {
    expect(buildF({ release: 'v2' }).filterLabel).toBe('Release: bis V2');
    expect(buildF({ release: 'v1', releaseMode: 'exact' }).filterLabel).toBe('Release: nur V1');
    expect(buildF({ release: 'none' }).filterLabel).toBe('Release: ohne Zuordnung');
    expect(buildF({ status: 'open', hideDone: true, priority: 'must' }).filterLabel).toBe(
      'Status: Offen · ohne Umgesetzte · Priorität: Muss',
    );
  });

  it('marks the rendered Markdown as a filtered Auszug and separates scope from Stand', () => {
    const md = renderMarkdown(buildF({ release: 'none' }));
    expect(md).toContain('Gefilterter Auszug');
    expect(md).toContain('Release: ohne Zuordnung');
    expect(md).toContain(
      '**Umfang:** 1 der insgesamt 4 Anforderungen dieser Map — gefilterter Auszug (Release: ohne Zuordnung)',
    );
    expect(md).toContain('**Stand dieser Anforderung:**');
  });

  it('renders an unfiltered document without the Auszug banner', () => {
    const md = renderMarkdown(buildF({}));
    expect(md).not.toContain('Gefilterter Auszug');
    expect(md).toContain('**Umfang:** alle 4 Anforderungen dieser Map');
    expect(md).toContain(
      '**Stand dieser 4 Anforderungen:** 1 Umgesetzt · 1 Teilweise · 2 Offen',
    );
  });
});

describe('acceptanceIsStale', () => {
  it('flags revision drift and >1pt progress drift, tolerates rounding', () => {
    const acc = { ...baseAcc };
    expect(acceptanceIsStale(acc, 100, 3)).toBe(false);
    expect(acceptanceIsStale(acc, 99.5, 3)).toBe(false); // within 1pt
    expect(acceptanceIsStale(acc, 90, 3)).toBe(true);
    expect(acceptanceIsStale(acc, 100, 4)).toBe(true);
  });
});
