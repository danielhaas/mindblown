/**
 * Pure-engine tests for the plan linter (docs/plan-linter.md).
 * Rule firing conditions, scoping, and dismissal application — no DB.
 */
import { describe, it, expect } from 'vitest';
import type { Node } from '@mindblown/core';
import { computePlanLint, type LintHistory, type LintReport } from '../engine.js';

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
    claimedBySession: null,
    claimedAt: null,
    revision: 0,
    ...overrides,
  } as Node;
}

const NOW = new Date('2026-07-16T12:00:00Z');
const emptyHistory = (): LintHistory => ({
  ok: true,
  lastProgressChange: new Map(),
  replanEvents: new Map(),
  anyRecentEvent: true, // suppress stale-plan unless a test opts in
});

function lint(nodes: Node[], opts: Partial<Parameters<typeof computePlanLint>[0]> = {}) {
  const result = computePlanLint({
    map: { effortUnit: 'days', statusWorkflow: [{ id: 'wip', category: 'in_progress' }] },
    nodes,
    unitsPerDay: 1,
    history: emptyHistory(),
    dismissals: [],
    now: NOW,
    ...opts,
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

function rule(report: LintReport, id: string) {
  const r = report.rules.find((r) => r.ruleId === id);
  if (!r) throw new Error(`rule ${id} missing from report`);
  return r;
}

describe('computePlanLint — rules', () => {
  it('unestimated-leaf fires on incomplete leaves without estimate, not on complete ones', () => {
    const report = lint([
      makeNode({ id: 'root', childrenIds: ['a', 'b', 'c'] }),
      makeNode({ id: 'a', parentId: 'root' }), // no estimate, incomplete → fires
      makeNode({ id: 'b', parentId: 'root', percentComplete: 100 }), // complete → exempt
      makeNode({ id: 'c', parentId: 'root', effortEstimate: 3 }), // estimated → clean
    ]);
    expect(rule(report, 'unestimated-leaf').findings.map((f) => f.nodeId)).toEqual(['a']);
    expect(report.warnCount).toBe(1);
  });

  it('oversized-leaf fires above the 5-day absolute threshold, unit-aware', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['a', 'b'] }),
      makeNode({ id: 'a', parentId: 'root', effortEstimate: 48 }), // 6 days at 8h/day
      makeNode({ id: 'b', parentId: 'root', effortEstimate: 8 }), // 1 day
    ];
    const report = lint(nodes, {
      map: { effortUnit: 'hours', statusWorkflow: [] },
      unitsPerDay: 8,
    });
    expect(rule(report, 'oversized-leaf').findings.map((f) => f.nodeId)).toEqual(['a']);
  });

  it('oversized-leaf share rule only activates with ≥8 leaves', () => {
    // 3 leaves, one is 40% of the total but under 5 days → must NOT fire.
    const small = lint([
      makeNode({ id: 'root', childrenIds: ['a', 'b', 'c'] }),
      makeNode({ id: 'a', parentId: 'root', effortEstimate: 4 }),
      makeNode({ id: 'b', parentId: 'root', effortEstimate: 3 }),
      makeNode({ id: 'c', parentId: 'root', effortEstimate: 3 }),
    ]);
    expect(rule(small, 'oversized-leaf').findings).toEqual([]);

    // 9 leaves: a 4-day leaf that is >15% of total fires via the share rule.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const many = lint([
      makeNode({ id: 'root', childrenIds: ['big', ...ids] }),
      makeNode({ id: 'big', parentId: 'root', effortEstimate: 4 }),
      ...ids.map((id) => makeNode({ id, parentId: 'root', effortEstimate: 0.5 })),
    ]);
    expect(rule(many, 'oversized-leaf').findings.map((f) => f.nodeId)).toEqual(['big']);
  });

  it('stale-progress keys on progress change events, not other edits', () => {
    const history = emptyHistory();
    history.lastProgressChange.set('fresh', '2026-07-15T00:00:00Z'); // 1 day ago
    history.lastProgressChange.set('old', '2026-06-01T00:00:00Z'); // 45 days ago
    const report = lint(
      [
        makeNode({ id: 'root', childrenIds: ['fresh', 'old', 'norec'] }),
        makeNode({ id: 'fresh', parentId: 'root', percentComplete: 50 }),
        makeNode({ id: 'old', parentId: 'root', percentComplete: 50 }),
        makeNode({ id: 'norec', parentId: 'root', status: 'wip' }), // in-progress by status, no event
      ],
      { history },
    );
    const found = rule(report, 'stale-progress').findings;
    expect(found.map((f) => f.nodeId).sort()).toEqual(['norec', 'old']);
    expect(found.find((f) => f.nodeId === 'norec')!.detail).toContain('no progress change on record');
  });

  it('overdue-unreplanned exempts leaves with a re-plan event after the due date', () => {
    const history = emptyHistory();
    history.replanEvents.set('replanned', ['2026-07-10T00:00:00Z']); // after due
    history.replanEvents.set('touched-early', ['2026-06-01T00:00:00Z']); // before due
    const report = lint(
      [
        makeNode({ id: 'root', childrenIds: ['ignored', 'replanned', 'touched-early'] }),
        makeNode({ id: 'ignored', parentId: 'root', dueDate: '2026-07-01', percentComplete: 20 }),
        makeNode({ id: 'replanned', parentId: 'root', dueDate: '2026-07-01', percentComplete: 20 }),
        makeNode({ id: 'touched-early', parentId: 'root', dueDate: '2026-06-15', percentComplete: 20 }),
      ],
      { history },
    );
    expect(rule(report, 'overdue-unreplanned').findings.map((f) => f.nodeId).sort()).toEqual([
      'ignored',
      'touched-early',
    ]);
  });

  it('history-backed rules are skipped (not empty-passed) when history is unavailable', () => {
    const report = lint(
      [makeNode({ id: 'root', childrenIds: ['a'] }), makeNode({ id: 'a', parentId: 'root', status: 'wip' })],
      { history: { ok: false, lastProgressChange: new Map(), replanEvents: new Map(), anyRecentEvent: false } },
    );
    expect(rule(report, 'stale-progress').skipped).toBeTruthy();
    expect(rule(report, 'overdue-unreplanned').skipped).toBeTruthy();
    expect(rule(report, 'stale-plan').skipped).toBeTruthy();
  });

  it('calibration-drift needs ≥5 samples and fudge outside 0.8–1.25', () => {
    const drifted = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `c${i}`, parentId: 'root', effortEstimate: 2, actualEffort: 3, percentComplete: 100 }),
    );
    const report = lint([makeNode({ id: 'root', childrenIds: drifted.map((n) => n.id) }), ...drifted]);
    const r = rule(report, 'calibration-drift');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].detail).toContain('1.50×');
    expect(r.why).toContain('1.50×');

    const few = drifted.slice(0, 4);
    const quiet = lint([makeNode({ id: 'root', childrenIds: few.map((n) => n.id) }), ...few]);
    expect(rule(quiet, 'calibration-drift').findings).toEqual([]);
  });

  it('no-done-criteria exempts requirement-linked nodes and small leaves', () => {
    const report = lint([
      makeNode({ id: 'root', childrenIds: ['bare', 'req', 'small', 'documented'] }),
      makeNode({ id: 'bare', parentId: 'root', effortEstimate: 3 }),
      makeNode({ id: 'req', parentId: 'root', effortEstimate: 3, requirementId: 'REQ-1' }),
      makeNode({ id: 'small', parentId: 'root', effortEstimate: 1 }),
      makeNode({ id: 'documented', parentId: 'root', effortEstimate: 3, description: 'done means X' }),
    ]);
    expect(rule(report, 'no-done-criteria').findings.map((f) => f.nodeId)).toEqual(['bare']);
  });

  it('stale-plan fires only when incomplete and no recent events', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['a'] }),
      makeNode({ id: 'a', parentId: 'root', percentComplete: 50 }),
    ];
    const history = emptyHistory();
    history.anyRecentEvent = false;
    expect(rule(lint(nodes, { history }), 'stale-plan').findings).toHaveLength(1);
    expect(rule(lint(nodes), 'stale-plan').findings).toEqual([]);
  });

  it('dates-without-dependencies needs ≥10 dated leaves and zero dependencies', () => {
    const dated = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `d${i}`, parentId: 'root', dueDate: '2026-08-01' }),
    );
    const root = makeNode({ id: 'root', childrenIds: dated.map((n) => n.id) });
    expect(rule(lint([root, ...dated]), 'dates-without-dependencies').findings).toHaveLength(1);

    const withDep = [...dated];
    withDep[0] = makeNode({
      id: 'd0',
      parentId: 'root',
      dueDate: '2026-08-01',
      dependencies: [{ targetNodeId: 'd1', type: 'FS', lag: 0 }],
    });
    expect(rule(lint([root, ...withDep]), 'dates-without-dependencies').findings).toEqual([]);
  });
});

describe('computePlanLint — requirements pack', () => {
  it('uncovered-requirement fires on incomplete must-requirements with zero subtree estimate', () => {
    const report = lint(
      [
        makeNode({ id: 'root', childrenIds: ['bare', 'covered', 'should', 'done'] }),
        // must-requirement, no estimate anywhere → fires
        makeNode({ id: 'bare', parentId: 'root', requirementId: 'REQ-1', requirementPriority: 'must', childrenIds: ['bare-child'] }),
        makeNode({ id: 'bare-child', parentId: 'bare' }),
        // must-requirement with an estimated child → clean
        makeNode({ id: 'covered', parentId: 'root', requirementId: 'REQ-2', requirementPriority: 'must', childrenIds: ['covered-child'] }),
        makeNode({ id: 'covered-child', parentId: 'covered', effortEstimate: 3 }),
        // should-requirement → out of scope for this rule
        makeNode({ id: 'should', parentId: 'root', requirementId: 'REQ-3', requirementPriority: 'should' }),
        // completed must-requirement → exempt
        makeNode({ id: 'done', parentId: 'root', requirementId: 'REQ-4', requirementPriority: 'must', percentComplete: 100 }),
      ],
      { computedProgress: new Map([['done', 100]]) },
    );
    const r = rule(report, 'uncovered-requirement');
    expect(r.findings.map((f) => f.nodeId)).toEqual(['bare']);
    expect(r.findings[0].detail).toContain('REQ-1');
  });

  it('stale-acceptance mirrors the register: >1% progress drift or revision change', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['fresh', 'moved', 'edited'] }),
      makeNode({ id: 'fresh', parentId: 'root', requirementId: 'R1', percentComplete: 50 }),
      makeNode({ id: 'moved', parentId: 'root', requirementId: 'R2', percentComplete: 80 }),
      makeNode({ id: 'edited', parentId: 'root', requirementId: 'R3', percentComplete: 50 }),
    ] as ReturnType<typeof makeNode>[];
    (nodes[3] as { revision: number }).revision = 7;
    const acceptances = [
      { nodeId: 'fresh', userName: 'Thomas', acceptedAt: '2026-07-01T00:00:00Z', progressAtAcceptance: 50, nodeRevisionAtAcceptance: 0 },
      { nodeId: 'moved', userName: 'Thomas', acceptedAt: '2026-07-01T00:00:00Z', progressAtAcceptance: 50, nodeRevisionAtAcceptance: 0 },
      { nodeId: 'edited', userName: 'Rita', acceptedAt: '2026-07-01T00:00:00Z', progressAtAcceptance: 50, nodeRevisionAtAcceptance: 0 },
      { nodeId: 'gone', userName: 'Rita', acceptedAt: '2026-07-01T00:00:00Z', progressAtAcceptance: 50, nodeRevisionAtAcceptance: 0 },
    ];
    const report = lint(nodes, { acceptances });
    const r = rule(report, 'stale-acceptance');
    // fresh: unchanged → clean. moved: 50→80. edited: revision 0→7. gone: node deleted → skipped.
    expect(r.findings.map((f) => f.nodeId).sort()).toEqual(['edited', 'moved']);
    expect(r.findings.find((f) => f.nodeId === 'moved')!.detail).toContain('Thomas');
  });

  it('stale-acceptance is skipped (not empty-passed) without acceptance data', () => {
    const report = lint([makeNode({ id: 'root' })]);
    expect(rule(report, 'stale-acceptance').skipped).toBeTruthy();
  });

  it('unscheduled-must fires only without an own or inherited version tag', () => {
    const report = lint([
      makeNode({ id: 'root', childrenIds: ['epic', 'floating'] }),
      makeNode({ id: 'epic', parentId: 'root', versionId: 'v1', childrenIds: ['tagged'] }),
      // inherits v1 from epic → clean
      makeNode({ id: 'tagged', parentId: 'epic', requirementId: 'R1', requirementPriority: 'must' }),
      // no version anywhere up the chain → fires
      makeNode({ id: 'floating', parentId: 'root', requirementId: 'R2', requirementPriority: 'must' }),
    ]);
    expect(rule(report, 'unscheduled-must').findings.map((f) => f.nodeId)).toEqual(['floating']);
  });

  it('requirement rules evaluate map-wide even under subtree scoping', () => {
    const report = lint(
      [
        makeNode({ id: 'root', childrenIds: ['a', 'req'] }),
        makeNode({ id: 'a', parentId: 'root' }),
        makeNode({ id: 'req', parentId: 'root', requirementId: 'R9', requirementPriority: 'must' }),
      ],
      { nodeId: 'a' },
    );
    expect(rule(report, 'uncovered-requirement').findings.map((f) => f.nodeId)).toEqual(['req']);
  });
});

describe('computePlanLint — scoping and dismissals', () => {
  const tree = () => [
    makeNode({ id: 'root', childrenIds: ['epicA', 'epicB'] }),
    makeNode({ id: 'epicA', parentId: 'root', childrenIds: ['a1', 'a2'], versionId: 'v1' }),
    makeNode({ id: 'a1', parentId: 'epicA' }),
    makeNode({ id: 'a2', parentId: 'epicA' }),
    makeNode({ id: 'epicB', parentId: 'root', childrenIds: ['b1'] }),
    makeNode({ id: 'b1', parentId: 'epicB' }),
  ];

  it('nodeId scopes leaf rules to the subtree', () => {
    const report = lint(tree(), { nodeId: 'epicB' });
    expect(rule(report, 'unestimated-leaf').findings.map((f) => f.nodeId)).toEqual(['b1']);
    expect(report.scopeLabel).toContain('epicB');
  });

  it('versionId scopes with ancestor inheritance', () => {
    const report = lint(tree(), { versionId: 'v1' });
    expect(rule(report, 'unestimated-leaf').findings.map((f) => f.nodeId).sort()).toEqual(['a1', 'a2']);
  });

  it('cycleId scopes with ancestor inheritance', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['epic', 'other'] }),
      makeNode({ id: 'epic', parentId: 'root', cycleId: 's1', childrenIds: ['in1', 'in2'] }),
      makeNode({ id: 'in1', parentId: 'epic' }),
      makeNode({ id: 'in2', parentId: 'epic', cycleId: 's2' }),
      makeNode({ id: 'other', parentId: 'root' }),
    ];
    const s1 = lint(nodes, { cycleId: 's1' });
    expect(rule(s1, 'unestimated-leaf').findings.map((f) => f.nodeId).sort()).toEqual(['in1', 'in2']);
    expect(s1.scopeLabel).toContain('sprint s1');
    const s2 = lint(nodes, { cycleId: 's2' });
    expect(rule(s2, 'unestimated-leaf').findings.map((f) => f.nodeId)).toEqual(['in2']);
  });

  it('unknown nodeId returns an error, not a report', () => {
    const result = computePlanLint({
      map: {},
      nodes: tree(),
      unitsPerDay: 1,
      history: emptyHistory(),
      dismissals: [],
      nodeId: 'nope',
      now: NOW,
    });
    expect('error' in result).toBe(true);
  });

  it('node dismissal hides one finding; rule mute hides them all — counts follow', () => {
    const nodes = tree();
    const undismissed = lint(nodes);
    expect(rule(undismissed, 'unestimated-leaf').activeCount).toBe(3);

    const oneOff = lint(nodes, { dismissals: [{ ruleId: 'unestimated-leaf', nodeId: 'a1' }] });
    const r1 = rule(oneOff, 'unestimated-leaf');
    expect(r1.activeCount).toBe(2);
    expect(r1.dismissedCount).toBe(1);
    expect(r1.findings.find((f) => f.nodeId === 'a1')!.dismissed).toBe(true);
    expect(oneOff.warnCount).toBe(2);

    const muted = lint(nodes, { dismissals: [{ ruleId: 'unestimated-leaf', nodeId: null }] });
    const r2 = rule(muted, 'unestimated-leaf');
    expect(r2.ruleMuted).toBe(true);
    expect(r2.activeCount).toBe(0);
    expect(muted.warnCount).toBe(0);
  });

  it('dismissals on one rule do not bleed into another', () => {
    const nodes = [
      makeNode({ id: 'root', childrenIds: ['a'] }),
      makeNode({ id: 'a', parentId: 'root', effortEstimate: 10 }), // oversized, has estimate
    ];
    const report = lint(nodes, { dismissals: [{ ruleId: 'unestimated-leaf', nodeId: 'a' }] });
    expect(rule(report, 'oversized-leaf').findings[0].dismissed).toBe(false);
  });
});
