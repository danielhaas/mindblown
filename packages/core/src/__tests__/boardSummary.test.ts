/** The kanban board at a glance — the home-screen widget's data (#589). */
import { describe, it, expect } from 'vitest';
import { summarizeBoard } from '../boardSummary.js';
import type { Node, StatusDef } from '../types.js';

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    mapId: 'map-1',
    parentId: null,
    childrenIds: [],
    text: overrides.id,
    description: null,
    x: null,
    y: null,
    collapsed: false,
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
    customFields: {},
    dependencies: [],
    versionId: null,
    cycleId: null,
    externalLinks: [],
    attachments: [],
    autoProgress: 'off',
    priorityRank: null,
    completedAt: null,
    startedAt: null,
    expectedDoneAt: null,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    verificationVideoUrl: null,
    verificationVideoPosterUrl: null,
    // Orchestration substrate (#111)
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'user-1',
    reportedBy: null,
    approval: null,
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#ccc', position: 0 },
  { id: 'doing', name: 'In Progress', category: 'in_progress', color: '#00f', position: 1 },
  { id: 'review', name: 'In Review', category: 'in_progress', color: '#f0f', position: 2 },
  { id: 'done', name: 'Done', category: 'done', color: '#0f0', position: 3 },
];
const map = { id: 'map-1', name: 'Launch', rootNodeId: 'root', statusWorkflow: workflow, wipLimit: 3 };

function board(): Node[] {
  return [
    makeNode({ id: 'root', text: 'Launch', childrenIds: ['api', 'loose'] }),
    makeNode({ id: 'api', text: 'API', parentId: 'root', childrenIds: ['a', 'b', 'c', 'd', 'e', 'f', 'x'] }),
    makeNode({ id: 'a', text: 'Auth', parentId: 'api', status: 'doing', startedAt: '2026-10-01T08:00:00Z' }),
    makeNode({ id: 'b', text: 'Billing', parentId: 'api', status: 'In Progress', startedAt: '2026-10-02T08:00:00Z' }),
    makeNode({ id: 'c', text: 'Cache', parentId: 'api', status: 'review' }),
    makeNode({ id: 'd', text: 'Docs', parentId: 'api', status: 'todo', dependencies: [{ targetNodeId: 'a', type: 'FS' } as Node['dependencies'][number]] }),
    makeNode({ id: 'e', text: 'Email', parentId: 'api', status: 'todo', blockedReason: 'Waiting on Dan for the copy' }),
    makeNode({ id: 'f', text: 'Feeds', parentId: 'api', status: 'done', blockedReason: 'stale' }),
    makeNode({ id: 'x', text: 'Old', parentId: 'api', status: 'cancelled', blockedReason: 'gone' }),
    makeNode({ id: 'loose', text: 'Loose end', parentId: 'root', status: 'doing' }),
  ];
}

describe('summarizeBoard (#589)', () => {
  it('lists in-progress leaves newest-started first, with the parent as context (not the root)', () => {
    const s = summarizeBoard(map, board(), { now: new Date('2026-10-29T10:00:00Z') });
    expect(s.inProgress.count).toBe(3);
    expect(s.inProgress.items.map((i) => [i.id, i.context])).toEqual([['b', 'API'], ['a', 'API'], ['loose', null]]);
    expect(s).toMatchObject({ mapId: 'map-1', mapName: 'Launch', generatedAt: '2026-10-29T10:00:00.000Z' });
  });

  it('counts review cards apart and WIP over every in-progress-category card', () => {
    const s = summarizeBoard(map, board());
    expect(s.inReview).toBe(1);
    expect(s.wip).toEqual({ count: 4, limit: 3 });
  });

  it('lists open blocked leaves, a manual reason before a predecessor wait; done and cancelled are off', () => {
    const s = summarizeBoard(map, board());
    expect(s.blocked.count).toBe(2);
    expect(s.blocked.items.map((i) => [i.id, i.reason])).toEqual([
      ['e', 'Waiting on Dan for the copy'],
      ['d', 'Waiting on Auth'],
    ]);
  });

  it('caps the item lists at the limit but keeps the full counts', () => {
    const s = summarizeBoard(map, board(), { limit: 1 });
    expect(s.inProgress).toMatchObject({ count: 3, items: [{ id: 'b' }] });
    expect(s.blocked).toMatchObject({ count: 2, items: [{ id: 'e' }] });
  });
});
