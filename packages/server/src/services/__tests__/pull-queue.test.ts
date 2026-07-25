/**
 * Leidang pull queue — decision-core tests.
 *
 * `selectPullCandidates` is the pure heart of getNextTicket: cap gate →
 * dispatchGate AND-filter → dispatchPolicy sort → empty-brief guard.
 * The transactional shell (advisory lock + conditional claim) is thin
 * and exercised through the route test; everything decision-shaped is
 * pinned here against real @mindblown/core predicates.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Node as CoreNode, StatusDef } from '@mindblown/core';

// The service module imports the DB substrate at module level; stub the
// I/O edges but keep @mindblown/core and drizzle-orm real — the pure
// functions under test lean on real isReady/buildTodoIds semantics.
vi.mock('../../db/connection.js', () => ({ db: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));

import {
  selectPullCandidates,
  matchesDispatchGate,
  sortByDispatchPolicy,
  hasBrief,
  DEFAULT_DISPATCH_POLICY,
} from '../orchestration.js';

const WORKFLOW: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
];

let seq = 0;
function makeNode(overrides: Partial<CoreNode> & { id: string }): CoreNode {
  seq += 1;
  return {
    mapId: 'map-1',
    parentId: 'root',
    childrenIds: [],
    text: `Node ${overrides.id}`,
    description: `Brief for ${overrides.id}`,
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
    autoProgress: 'off',
    priorityRank: null,
    completedAt: null,
    requirementId: null,
    requirementPriority: null,
    requirementText: null,
    phaseId: null,
    verificationText: null,
    verificationUrl: null,
    claimedBySession: null,
    claimedAt: null,
    scopes: [],
    linkedPr: null,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    updatedAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    createdBy: 'test',
    revision: 1,
    deletedAt: null,
    ...overrides,
  } as CoreNode;
}

const root = makeNode({ id: 'root', parentId: null, description: null });

function select(
  nodes: CoreNode[],
  opts: Partial<{ cap: number; gate: string[]; policy: string[] }> = {},
) {
  return selectPullCandidates([root, ...nodes], {
    workflow: WORKFLOW,
    cap: opts.cap ?? 10,
    gate: opts.gate ?? [],
    policy: opts.policy ?? [],
  });
}

describe('cap gate', () => {
  it('cap 0 = hold: grants nothing regardless of ready work', () => {
    const d = select([makeNode({ id: 'a' })], { cap: 0 });
    expect(d.reason).toBe('hold');
    expect(d.ranked).toHaveLength(0);
  });

  it('refuses with reason cap when active claims reach the cap', () => {
    const d = select(
      [
        makeNode({ id: 'a', claimedBySession: 'w1', claimedAt: new Date().toISOString() }),
        makeNode({ id: 'b', claimedBySession: 'w2', claimedAt: new Date().toISOString() }),
        makeNode({ id: 'c' }),
      ],
      { cap: 2 },
    );
    expect(d.reason).toBe('cap');
    expect(d.active).toBe(2);
    expect(d.cap).toBe(2);
  });

  it('grants below the cap', () => {
    const d = select(
      [makeNode({ id: 'a', claimedBySession: 'w1' }), makeNode({ id: 'b' })],
      { cap: 2 },
    );
    expect(d.reason).toBeUndefined();
    expect(d.ranked.map((n) => n.id)).toEqual(['b']);
  });
});

describe('ready-set membership', () => {
  it('excludes the root, claimed, non-todo, and dep-blocked nodes', () => {
    const done = makeNode({ id: 'dep-done', status: 'done' });
    const open = makeNode({ id: 'dep-open', status: 'in_progress' });
    const d = select([
      done,
      open,
      makeNode({ id: 'claimed', claimedBySession: 'w9' }),
      makeNode({ id: 'in-flight', status: 'in_progress' }),
      makeNode({
        id: 'blocked',
        dependencies: [{ targetNodeId: 'dep-open', type: 'FS', lag: 0 }],
      }),
      makeNode({
        id: 'unblocked',
        dependencies: [{ targetNodeId: 'dep-done', type: 'FS', lag: 0 }],
      }),
      makeNode({ id: 'plain' }),
    ]);
    expect(d.ranked.map((n) => n.id).sort()).toEqual(['plain', 'unblocked']);
  });
});

describe('dispatchGate', () => {
  it('version: matches own and ancestor-inherited versionIds', () => {
    const epic = makeNode({ id: 'epic', versionId: 'v1' });
    const inherited = makeNode({ id: 'inherited', parentId: 'epic' });
    const explicit = makeNode({ id: 'explicit', versionId: 'v1' });
    const other = makeNode({ id: 'other', versionId: 'v2' });
    const unversioned = makeNode({ id: 'loose' });
    const d = select([epic, inherited, explicit, other, unversioned], {
      gate: ['version:v1'],
    });
    expect(d.ranked.map((n) => n.id).sort()).toEqual(['epic', 'explicit', 'inherited']);
  });

  it('type:bug + version:<id> AND together', () => {
    const d = select(
      [
        makeNode({ id: 'v1-bug', versionId: 'v1', tags: ['bug'] }),
        makeNode({ id: 'v1-feature', versionId: 'v1' }),
        makeNode({ id: 'v2-bug', versionId: 'v2', tags: ['bug'] }),
      ],
      { gate: ['version:v1', 'type:bug'] },
    );
    expect(d.ranked.map((n) => n.id)).toEqual(['v1-bug']);
  });

  it('empty gate is no fence; unknown entries fail closed', () => {
    const nodes = [makeNode({ id: 'a' })];
    expect(select(nodes, { gate: [] }).ranked).toHaveLength(1);
    expect(select(nodes, { gate: ['sprint:s1'] }).ranked).toHaveLength(0);
  });

  it('matchesDispatchGate exposes the same semantics directly', () => {
    const bug = makeNode({ id: 'bug', tags: ['Bug'] }); // case-insensitive
    const nodeMap = new Map([[bug.id, bug]]);
    expect(matchesDispatchGate(bug, ['type:bug'], nodeMap)).toBe(true);
    expect(matchesDispatchGate(bug, ['version:v1'], nodeMap)).toBe(false);
  });
});

describe('dispatchPolicy', () => {
  it('default policy is bugs → priority → age', () => {
    const oldFeature = makeNode({ id: 'old-feature', createdAt: '2026-01-01T00:00:00Z' });
    const p0Feature = makeNode({ id: 'p0-feature', priority: 'P0', createdAt: '2026-02-01T00:00:00Z' });
    const bug = makeNode({ id: 'bug', tags: ['bug'], createdAt: '2026-03-01T00:00:00Z' });
    const d = select([oldFeature, p0Feature, bug]);
    expect(d.ranked.map((n) => n.id)).toEqual(['bug', 'p0-feature', 'old-feature']);
    expect(DEFAULT_DISPATCH_POLICY).toEqual(['bugs', 'priority', 'age']);
  });

  it('priority key: priorityRank beats the P0–P3 enum, nulls last', () => {
    const sorted = sortByDispatchPolicy(
      [
        makeNode({ id: 'p1', priority: 'P1' }),
        makeNode({ id: 'ranked-9', priorityRank: 9, priority: 'P3' }),
        makeNode({ id: 'ranked-2', priorityRank: 2 }),
        makeNode({ id: 'none' }),
      ],
      ['priority'],
    );
    expect(sorted.map((n) => n.id)).toEqual(['ranked-2', 'ranked-9', 'p1', 'none']);
  });

  it('size key: smallest estimate first, unestimated last', () => {
    const sorted = sortByDispatchPolicy(
      [
        makeNode({ id: 'big', effortEstimate: 8 }),
        makeNode({ id: 'unsized' }),
        makeNode({ id: 'small', effortEstimate: 0.5 }),
      ],
      ['size'],
    );
    expect(sorted.map((n) => n.id)).toEqual(['small', 'big', 'unsized']);
  });

  it('a custom policy order overrides the default', () => {
    const bug = makeNode({ id: 'bug', tags: ['bug'], createdAt: '2026-03-01T00:00:00Z' });
    const older = makeNode({ id: 'older', createdAt: '2026-01-01T00:00:00Z' });
    const d = select([bug, older], { policy: ['age'] });
    expect(d.ranked.map((n) => n.id)).toEqual(['older', 'bug']);
  });
});

describe('empty-brief guard', () => {
  it('splits brief-less ready nodes into skipped', () => {
    const briefed = makeNode({ id: 'briefed' });
    const bare = makeNode({ id: 'bare', description: null });
    const linked = makeNode({
      id: 'linked',
      description: null,
      externalLinks: [
        {
          provider: 'github',
          externalId: 'o/r#1',
          url: 'https://github.com/o/r/issues/1',
          syncEnabled: true,
          lastSyncedAt: null,
          state: 'open',
        },
      ],
    });
    const d = select([briefed, bare, linked]);
    expect(d.ranked.map((n) => n.id).sort()).toEqual(['briefed', 'linked']);
    expect(d.skipped.map((n) => n.id)).toEqual(['bare']);
  });

  it('hasBrief treats whitespace-only ProseMirror docs as empty', () => {
    const emptyDoc = makeNode({
      id: 'x',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [] }] } as unknown as CoreNode['description'],
    });
    expect(hasBrief(emptyDoc)).toBe(false);
    expect(hasBrief(makeNode({ id: 'y', description: 'real text' }))).toBe(true);
  });
});
