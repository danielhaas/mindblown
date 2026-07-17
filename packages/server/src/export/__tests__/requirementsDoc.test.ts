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

describe('acceptanceIsStale', () => {
  it('flags revision drift and >1pt progress drift, tolerates rounding', () => {
    const acc = { ...baseAcc };
    expect(acceptanceIsStale(acc, 100, 3)).toBe(false);
    expect(acceptanceIsStale(acc, 99.5, 3)).toBe(false); // within 1pt
    expect(acceptanceIsStale(acc, 90, 3)).toBe(true);
    expect(acceptanceIsStale(acc, 100, 4)).toBe(true);
  });
});
