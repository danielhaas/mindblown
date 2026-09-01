/**
 * Parity between the two readings of the pull queue: the server's
 * `selectPullCandidates` (what get_next_ticket grants) and core's
 * `dispatchQueueSnapshot` (what the cockpit's Dispatch card shows).
 *
 * The card exists so a PM sees the SAME queue the fleet gets. Ray's review
 * of #347 caught the first drift (snapshot ignored the empty-brief guard);
 * this test pins the two together on one fixture that exercises every
 * filter: root, claimed, non-todo status, dependency, gate (inherited
 * version + bug tag), missing brief.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Node as CoreNode, StatusDef } from '@mindblown/core';
import { dispatchQueueSnapshot } from '@mindblown/core';

vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import { selectPullCandidates } from '../orchestration.js';

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
  { id: 'in_progress', name: 'Doing', category: 'in_progress', color: '#000', position: 1 },
  { id: 'blocked', name: 'Blocked', category: 'in_progress', color: '#000', position: 2 },
  { id: 'done', name: 'Done', category: 'done', color: '#000', position: 3 },
];

function n(p: Partial<CoreNode> & { id: string }): CoreNode {
  return {
    mapId: 'm',
    parentId: 'root',
    childrenIds: [],
    text: p.id,
    description: null,
    effortEstimate: 1,
    status: 'todo',
    blockedReason: null,
    priority: null,
    priorityRank: null,
    tags: [],
    dependencies: [],
    versionId: null,
    claimedBySession: null,
    claimedAt: null,
    externalLinks: [{ provider: 'github', externalId: '#1', url: 'https://github.com/o/r/issues/1' }],
    createdAt: '2026-08-01T00:00:00Z',
    ...p,
  } as unknown as CoreNode;
}

const fixture: CoreNode[] = [
  n({ id: 'root', parentId: null, status: null, childrenIds: ['epic', 'bugA', 'bugB', 'loose', 'claimed', 'blocked', 'waiting', 'done', 'briefless', 'nostatus'] }),
  n({ id: 'epic', versionId: 'v1', status: 'in_progress', childrenIds: ['leaf1', 'leaf2'] }),
  n({ id: 'leaf1', parentId: 'epic' }),
  n({ id: 'leaf2', parentId: 'epic', tags: ['Bug'], priority: 'P1' }),
  n({ id: 'bugA', tags: ['bug'] }),
  n({ id: 'bugB', tags: ['bug'], versionId: 'v2' }),
  n({ id: 'loose' }),
  n({ id: 'claimed', claimedBySession: 's1' }),
  n({ id: 'blocked', status: 'blocked', blockedReason: 'needs Dan' }),
  n({ id: 'waiting', dependencies: [{ targetNodeId: 'loose', type: 'FS' }] as never }),
  n({ id: 'done', status: 'done' }),
  n({ id: 'briefless', externalLinks: [] }),
  n({ id: 'nostatus', status: null }),
];

const sorted = (ids: string[]) => [...ids].sort();

describe('dispatchQueueSnapshot ⇔ selectPullCandidates', () => {
  const cases: { name: string; gate: string[] }[] = [
    { name: 'open gate', gate: [] },
    { name: 'version gate (inherited version counts)', gate: ['version:v1'] },
    { name: 'bugs only', gate: ['type:bug'] },
    { name: 'version AND bugs', gate: ['version:v1', 'type:bug'] },
    { name: 'unknown entry (fail-closed)', gate: ['prio:P0'] },
    { name: 'gate on a version nobody has', gate: ['version:nope'] },
  ];

  for (const { name, gate } of cases) {
    it(`grants exactly what the card calls grantable — ${name}`, () => {
      const server = selectPullCandidates(fixture, { workflow: WORKFLOW, cap: 6, gate, policy: [] });
      const card = dispatchQueueSnapshot(fixture, { workflow: WORKFLOW, cap: 6, gate });
      // ranked = what the pull tries to claim (gated, with a brief, profile-
      // eligible — no policy here → all); skipped = gated without a brief.
      const grantable = server.ranked.map((x) => x.id);
      expect(sorted(card.inGateIds)).toEqual(sorted(grantable));
      expect(card.needsBrief).toBe(server.skipped.length);
      expect(card.activeClaims).toBe(server.active);
      expect(card.state === 'empty').toBe(grantable.length === 0);
    });
  }

  it('hold and cap refusals match', () => {
    expect(selectPullCandidates(fixture, { workflow: WORKFLOW, cap: 0, gate: [], policy: [] }).reason).toBe('hold');
    expect(dispatchQueueSnapshot(fixture, { workflow: WORKFLOW, cap: 0, gate: [] }).state).toBe('hold');
    expect(selectPullCandidates(fixture, { workflow: WORKFLOW, cap: 1, gate: [], policy: [] }).reason).toBe('cap');
    expect(dispatchQueueSnapshot(fixture, { workflow: WORKFLOW, cap: 1, gate: [] }).state).toBe('full');
  });
});
