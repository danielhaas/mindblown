/**
 * Triage lifecycle (#313): four confirm passes, each a single UPDATE that
 * sets reviewed = true / reviewed_at = now / reviewed_by = NULL. The SQL
 * predicates themselves were checked read-only against prod (counts per
 * class, archived maps excluded); this pins the write shape and the result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
const returned = [[{ id: 'f1' }, { id: 'f2' }], [{ id: 's1' }], [], [{ id: 'p1' }]];
vi.mock('../../db/connection.js', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const rows = returned[updates.length - 1] ?? [];
        return { where: () => ({ returning: async () => rows }) };
      },
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  maps: { id: 'maps.id', archivedAt: 'a', githubRepoOwner: 'o', githubRepoName: 'r', githubInboxNodeId: 'inbox' },
  nodes: { id: 'n.id', deletedAt: 'n.del', parentId: 'n.parent' },
  triageDecisions: { reviewed: 'rv', mapId: 'm', externalId: 'e', decision: 'd', issueState: 's', decidedAt: 'at', placedNodeId: 'p' },
}));

import { runTriageLifecycle } from '../triageLifecycle.js';

beforeEach(() => {
  updates.length = 0;
});

describe('runTriageLifecycle (#313)', () => {
  it('confirms in four passes — reviewed, now, no person — and reports each class', async () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const r = await runTriageLifecycle(now);
    expect(r).toEqual({ foreign: 2, skipsSettled: 1, uncertainClosed: 0, placedSettled: 1 });
    expect(updates).toHaveLength(4);
    for (const u of updates) expect(u).toEqual({ reviewed: true, reviewedAt: now, reviewedBy: null });
  });
});
