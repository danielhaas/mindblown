/**
 * conflict_scan on the real service (#117 — these rules used to be tested
 * only against a re-implementation inside the route test). The db is a
 * queue of select results in call order: node rows, then the map row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selects: unknown[][] = [];
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => selects.shift() ?? [] }) }) },
}));
vi.mock('../../db/schema.js', () => ({ nodes: {}, maps: {}, cycles: {} }));
vi.mock('../../db/nodes.js', () => ({ notDeleted: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/events.js', () => ({ recordClaimed: vi.fn(), recordReleased: vi.fn() }));

import { conflictScan, OrchestrationNotFoundError } from '../orchestration.js';

function row(p: Record<string, unknown>) {
  return {
    mapId: 'm1', text: String(p.id), parentId: 'root', childrenOrder: [], claimedBySession: null, claimedAt: null,
    status: null, percentComplete: null, priority: null, priorityRank: null, cycleId: null, scopes: [],
    externalLinks: [], attachments: [], assigneeIds: [], dependencies: [], tags: [], customFields: {},
    autoProgress: 'off', revision: 1, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 't', ...p,
  };
}
const workflow = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#000', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 2 },
];
const link = (externalId: string) => ({ provider: 'github', externalId, url: 'u', syncEnabled: true, lastSyncedAt: null });

beforeEach(() => {
  selects.length = 0;
});

describe('conflictScan (#117: the real service)', () => {
  it('flags in-progress and claimed nodes sharing a scope with the candidate — never the candidate itself', async () => {
    selects.push(
      [
        row({ id: 'cand', scopes: ['apps/workflows', 'db'] }),
        row({ id: 'busy', status: 'in_progress', scopes: ['apps/workflows'] }),
        row({ id: 'claimed', claimedBySession: 's2', scopes: ['db'] }),
        row({ id: 'idle', scopes: ['apps/workflows'] }), // neither in progress nor claimed
        row({ id: 'elsewhere', status: 'in_progress', scopes: ['docs'] }),
      ],
      [{ statusWorkflow: workflow }],
    );
    const r = await conflictScan('m1', 'cand');
    expect(r.conflicts.map((c) => [c.id, c.overlappingScopes])).toEqual([
      ['busy', ['apps/workflows']],
      ['claimed', ['db']],
    ]);
  });

  it('a candidate without scopes has no scope conflicts; an unknown candidate is a not-found error', async () => {
    selects.push([row({ id: 'cand' }), row({ id: 'busy', status: 'in_progress', scopes: ['x'] })]);
    expect((await conflictScan('m1', 'cand')).conflicts).toEqual([]);
    selects.push([row({ id: 'other' })]);
    await expect(conflictScan('m1', 'nope')).rejects.toBeInstanceOf(OrchestrationNotFoundError);
  });

  it('reports the same issue linked on several nodes — per candidate, and map-wide without one', async () => {
    const rows = () => [
      row({ id: 'a', externalLinks: [link('o/r#5')] }),
      row({ id: 'b', externalLinks: [link('o/r#5')] }),
      row({ id: 'c', externalLinks: [link('o/r#6')] }),
    ];
    selects.push(rows());
    expect((await conflictScan('m1', 'a')).duplicateLinks.map((d) => [d.externalId, d.nodes.map((n) => n.id)])).toEqual([
      ['o/r#5', ['a', 'b']],
    ]);
    selects.push(rows());
    const mapWide = await conflictScan('m1');
    expect(mapWide.candidateId).toBeNull();
    expect(mapWide.duplicateLinks.map((d) => d.externalId)).toEqual(['o/r#5']);
  });
});
