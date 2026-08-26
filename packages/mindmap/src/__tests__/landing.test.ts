import { describe, it, expect } from 'vitest';
import type { Node, ComputedNodeValues } from '@mindblown/core';
import type { ReleaseForecastRow } from '../api.js';
import {
  nextRelease,
  releaseVerdict,
  weeklyDelta,
  threats,
  recentlyDone,
  scopeGrowth,
  groupBlockers,
  sprintHealth,
  triagePipelineState,
  escalations,
  leavesOf,
} from '../landing.js';

const TODAY = new Date('2026-08-26T09:00:00Z');

function row(p: Partial<ReleaseForecastRow>): ReleaseForecastRow {
  return {
    versionId: 'v', versionName: 'V1.5', versionStatus: 'active', sortOrder: 1,
    targetDate: '2026-09-28', leaves: 100, noEstimateLeaves: 0, totalEffort: 100, remainingEffort: 40,
    remainingTickets: 40, effectiveStartDate: null, plannedFinishDate: '2026-09-14',
    velocityAdjustedFinishDate: '2026-09-25', ticketModelFinishDate: null, unestimatedOpenLeaves: 0,
    confidence: { level: 'agree', divergenceDays: 0, unestimatedOpenLeaves: 0, note: '' },
    slipPlannedDays: null, slipVelocityDays: null, slipTicketDays: null,
    plannedFinishDeltaDays7d: null, velocityFinishDeltaDays7d: null,
    ...p,
  };
}

let seq = 0;
function node(p: Partial<Node>): Node {
  seq += 1;
  return {
    id: p.id ?? `n${seq}`, mapId: 'm', parentId: null, text: `node ${seq}`, description: null,
    effortEstimate: null, actualEffort: null, percentComplete: null, status: null, blockedReason: null,
    assigneeIds: [], priority: null, dueDate: null, startDate: null, tags: [], dependencies: [],
    versionId: null, milestoneId: null, cycleId: null, phaseId: null, completedAt: null,
    claimedBySession: null, claimedAt: null, updatedAt: '2026-08-25T00:00:00Z', createdAt: '2026-08-01T00:00:00Z',
    ...p,
  } as unknown as Node;
}

const cat = (n: Node): 'todo' | 'in_progress' | 'done' =>
  n.status === 'done' ? 'done' : n.status === 'in_progress' ? 'in_progress' : 'todo';

function computedFor(nodes: Record<string, Node>, blocked: string[] = [], deps: string[] = []): Map<string, ComputedNodeValues> {
  const m = new Map<string, ComputedNodeValues>();
  for (const id of Object.keys(nodes)) {
    m.set(id, {
      computedEffort: 0, computedProgress: 0, healthSignal: 'on_track',
      isBlocked: blocked.includes(id) || deps.includes(id),
      blockedBy: { manual: blocked.includes(id), predecessorIds: deps.includes(id) ? ['x'] : [], blockedDescendantCount: 0 },
    } as ComputedNodeValues);
  }
  return m;
}

function byId(list: Node[]): Record<string, Node> {
  return Object.fromEntries(list.map((n) => [n.id, n]));
}

describe('nextRelease', () => {
  it('surfaces an overdue, still-open version before the next dated one (#325)', () => {
    const rows = [row({ versionId: 'mvp', versionName: 'MVP', targetDate: '2026-08-11', remainingTickets: 5 }), row({})];
    expect(nextRelease(rows, TODAY)?.versionId).toBe('mvp');
  });
  it('skips released versions and empty overdue ones', () => {
    const rows = [
      row({ versionId: 'r', versionStatus: 'released', targetDate: '2026-08-01' }),
      row({ versionId: 'mvp', targetDate: '2026-08-11', remainingTickets: 0 }),
      row({}),
    ];
    expect(nextRelease(rows, TODAY)?.versionId).toBe('v');
  });
});

describe('releaseVerdict', () => {
  it('is on track when forecast <= target and the models agree', () => {
    expect(releaseVerdict(row({}), TODAY).level).toBe('on_track');
  });
  it('is behind when the velocity forecast passes the target, with the slip in days', () => {
    const v = releaseVerdict(row({ velocityAdjustedFinishDate: '2026-12-25' }), TODAY);
    expect(v.level).toBe('behind');
    expect(v.reasons[0]).toMatch(/88 days after/);
  });
  it('is at risk when a quarter of open tasks are unestimated (Thomas: "114 of 140")', () => {
    const v = releaseVerdict(row({ remainingTickets: 140, unestimatedOpenLeaves: 114, confidence: { level: 'unmeasured', divergenceDays: null, unestimatedOpenLeaves: 114, note: '' } }), TODAY);
    expect(v.level).toBe('at_risk');
    expect(v.reasons.join(' ')).toMatch(/114 of 140/);
  });
  it('names a target in the past as the first reason', () => {
    const v = releaseVerdict(row({ targetDate: '2026-08-11', velocityAdjustedFinishDate: '2026-09-25' }), TODAY);
    expect(v.level).toBe('behind');
    expect(v.reasons.some((r) => /15 days gone/.test(r))).toBe(true);
  });
  it('reports unknown without a target or forecast', () => {
    expect(releaseVerdict(row({ targetDate: null }), TODAY).level).toBe('unknown');
  });
});

describe('weeklyDelta', () => {
  it('reads the 7-day trend in words', () => {
    expect(weeklyDelta(row({ velocityFinishDeltaDays7d: 3 }))).toBe('slipped 3 days since last week');
    expect(weeklyDelta(row({ velocityFinishDeltaDays7d: -2 }))).toBe('pulled in 2 days since last week');
    expect(weeklyDelta(row({}))).toBeNull();
  });
});

describe('threats', () => {
  it('lists big blocked-but-counted work, unowned P0/P1, and unestimated bulk', () => {
    const parent = node({ id: 'p', versionId: 'v' });
    const big = node({ id: 'big', parentId: 'p', effortEstimate: 15, blockedReason: 'deferred to V1.5 follow-up' });
    const p0 = node({ id: 'p0', parentId: 'p', priority: 'P0', effortEstimate: 1 });
    const un = [1, 2, 3].map((i) => node({ id: `u${i}`, parentId: 'p' }));
    const nodes = byId([parent, big, p0, ...un]);
    const t = threats(nodes, computedFor(nodes, ['big']), cat, 'v');
    expect(t.map((x) => x.nodeId)).toContain('big');
    expect(t.some((x) => /1 high-priority/.test(x.text))).toBe(true);
    expect(t.some((x) => /3 of 5 open tasks have no estimate/.test(x.text))).toBe(true);
  });
  it('ignores leaves outside the version', () => {
    const other = node({ id: 'o', versionId: 'w', priority: 'P0' });
    const nodes = byId([other]);
    expect(threats(nodes, computedFor(nodes), cat, 'v')).toEqual([]);
  });
});

describe('recentlyDone', () => {
  it('returns done leaves within the window, newest first, using completedAt', () => {
    const a = node({ id: 'a', status: 'done', completedAt: '2026-08-20T00:00:00Z' });
    const b = node({ id: 'b', status: 'done', completedAt: '2026-08-24T00:00:00Z' });
    const old = node({ id: 'old', status: 'done', completedAt: '2026-07-01T00:00:00Z' });
    const open = node({ id: 'open', status: 'todo' });
    expect(recentlyDone(byId([a, b, old, open]), cat, 14, TODAY).map((n) => n.id)).toEqual(['b', 'a']);
  });
});

describe('scopeGrowth', () => {
  it('sums creations, deletions, estimate deltas and promotions into the version', () => {
    const g = scopeGrowth(
      [
        { eventType: 'node.created', fieldName: null, oldValue: null, newValue: null, nodeId: 'a', createdAt: '' },
        { eventType: 'node.deleted', fieldName: null, oldValue: null, newValue: null, nodeId: 'b', createdAt: '' },
        { eventType: 'node.field_changed', fieldName: 'effortEstimate', oldValue: 2, newValue: 5, nodeId: 'c', createdAt: '' },
        { eventType: 'node.field_changed', fieldName: 'versionId', oldValue: null, newValue: 'v', nodeId: 'd', createdAt: '' },
        { eventType: 'node.field_changed', fieldName: 'versionId', oldValue: 'v', newValue: 'w', nodeId: 'e', createdAt: '' },
      ],
      'v',
    );
    expect(g).toEqual({ created: 1, deleted: 1, effortDelta: 3, promoted: ['d'] });
  });
});

describe('groupBlockers', () => {
  it('groups identical root causes, separates orphaned claims and dependency waits (#322)', () => {
    const ci = [1, 2, 3].map((i) => node({ id: `ci${i}`, blockedReason: `PR #${700 + i} green, cannot merge: CI red on main` }));
    const orphan = node({ id: 'orph', status: 'in_progress', blockedReason: 'claim swept off worker while not running, nobody on it' });
    const dep = node({ id: 'dep' });
    const done = node({ id: 'done', status: 'done', blockedReason: 'irrelevant' });
    const nodes = byId([...ci, orphan, dep, done]);
    const groups = groupBlockers(nodes, computedFor(nodes, ['ci1', 'ci2', 'ci3', 'orph', 'done'], ['dep']), cat);
    expect(groups[0].kind).toBe('orphaned_claim');
    expect(groups[1]).toMatchObject({ kind: 'reason', nodeIds: ['ci1', 'ci2', 'ci3'] });
    expect(groups[2]).toMatchObject({ kind: 'dependency', nodeIds: ['dep'] });
  });
});

describe('sprintHealth', () => {
  it('flags a sprint that ended while still planned, WIP over limit, stalled work, rollover (#324)', () => {
    const cycle = { id: 'c', mapId: 'm', versionId: null, name: 'V1 fertigstellen', startDate: '2026-08-11', endDate: '2026-08-25', status: 'planned' as const, createdAt: '' };
    const fresh = node({ id: 'f', status: 'in_progress', cycleId: 'c', updatedAt: '2026-08-25T00:00:00Z' });
    const stale = node({ id: 's', status: 'in_progress', cycleId: 'c', updatedAt: '2026-08-01T00:00:00Z' });
    const todo = node({ id: 't', status: 'todo', cycleId: 'c' });
    const finished = node({ id: 'd', status: 'done', cycleId: 'c' });
    const h = sprintHealth(cycle, byId([fresh, stale, todo, finished]), cat, 1, TODAY);
    expect(h.endedButNotClosed).toBe(true);
    expect(h.daysLeft).toBe(-1);
    expect(h.inProgress).toBe(2);
    expect(h.stalled).toBe(1);
    expect(h.openInSprint).toBe(3);
  });
});

describe('triagePipelineState', () => {
  const err = (i: number) => ({ decision: 'uncertain' as const, reason: `triage_error: credit balance too low to access the Anthropic API (#${9000 + i})`, decidedAt: `2026-08-2${i % 5}T10:00:00Z` });
  it('detects N identical errors as a broken pipeline, not N tickets (#320)', () => {
    const s = triagePipelineState([err(1), err(2), err(3), err(4), err(5), err(6)]);
    expect(s.broken).toBe(true);
    expect(s.count).toBe(6);
    expect(s.cause).toMatch(/credit balance too low/);
    expect(s.since).toBe('2026-08-20T10:00:00Z');
  });
  it('stays quiet below the threshold or for ordinary uncertain rows', () => {
    expect(triagePipelineState([err(1), err(2)]).broken).toBe(false);
    expect(triagePipelineState(Array.from({ length: 10 }, () => ({ decision: 'uncertain' as const, reason: 'could be a feature or a bug', decidedAt: '' }))).broken).toBe(false);
  });
});

describe('escalations + leavesOf', () => {
  it('returns blocked P0/P1 leaves with a reason, P0 first', () => {
    const parent = node({ id: 'p' });
    const p1 = node({ id: 'p1', parentId: 'p', priority: 'P1', blockedReason: 'Gate 2.16 wording' });
    const p0 = node({ id: 'p0', parentId: 'p', priority: 'P0', blockedReason: 'Gate 2.4 spec' });
    const p2 = node({ id: 'p2', parentId: 'p', priority: 'P2', blockedReason: 'x' });
    const nodes = byId([parent, p1, p0, p2]);
    expect(leavesOf(nodes).map((n) => n.id).sort()).toEqual(['p0', 'p1', 'p2']);
    expect(escalations(nodes, computedFor(nodes, ['p1', 'p0', 'p2']), cat).map((n) => n.id)).toEqual(['p0', 'p1']);
  });
});
