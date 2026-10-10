/**
 * #113: a due date is a deadline, not a bar length — the projection reports
 * nodes that land after it (as dates, in calendar days) instead of
 * stretching them; and a baseline freezes the bars exactly as the Gantt
 * draws them.
 */
import { describe, it, expect } from 'vitest';
import type { MindMap, Node as CoreNode } from '@mindblown/core';
import { computeMapSchedule, buildBaseline, capBaselines, MAX_BASELINES } from '../mapSchedule.js';

const map = {
  id: 'm1',
  projectStartDate: '2026-10-01',
  effortUnit: 'days',
  hoursPerDay: 8,
  workerCount: 1,
  focusFactor: 1,
  baselines: [],
} as unknown as MindMap;

function leaf(id: string, over: Partial<CoreNode>): CoreNode {
  return {
    id,
    parentId: null,
    childrenIds: [],
    text: id,
    dependencies: [],
    effortEstimate: 1,
    percentComplete: null,
    status: 'todo',
    priority: null,
    priorityRank: null,
    startDate: null,
    dueDate: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as unknown as CoreNode;
}

describe('computeMapSchedule — due dates (#113)', () => {
  const nodes = [
    leaf('a', { effortEstimate: 5, dueDate: '2026-10-04', priority: 'P0' }),
    leaf('b', { effortEstimate: 2, dueDate: '2026-10-20', priority: 'P1' }),
  ];

  it('reports a node that runs past the end of its due day: last working day + whole days late', () => {
    // 5 days from 10-01 = works 10-01..10-05; due 10-04 → one day late.
    const r = computeMapSchedule({ map, nodes });
    expect(r.dueViolations).toEqual([
      { nodeId: 'a', text: 'a', dueDate: '2026-10-04', projectedEnd: '2026-10-05', lateDays: 1 },
    ]);
  });

  it('work whose last day is the due date is on time', () => {
    const r = computeMapSchedule({ map, nodes: [leaf('a', { effortEstimate: 5, dueDate: '2026-10-05' })] });
    expect(r.dueViolations).toEqual([]);
  });

  it('never stretches a bar to a later due date', () => {
    const r = computeMapSchedule({ map, nodes });
    const b = r.schedule.find((s) => s.nodeId === 'b')!;
    expect(b.computedEnd - b.computedStart).toBe(2);
    expect(b.dueOverrun).toBeUndefined();
  });

  it('hours maps: lateness follows the bar the Gantt draws (one rounding rule)', () => {
    const hourly = { ...map, effortUnit: 'hours' } as MindMap;
    const run = (effort: number, due: string) =>
      computeMapSchedule({ map: hourly, nodes: [leaf('h', { effortEstimate: effort, dueDate: due })] });
    // 24 h = 3 days: 10-01..10-03, due 10-02 → 1 day late.
    const three = run(24, '2026-10-02');
    expect(three.dueViolations?.[0]).toMatchObject({ projectedEnd: '2026-10-03', lateDays: 1 });
    expect(three.barDates(three.schedule[0]).end).toBe('2026-10-04'); // drawn end (exclusive) = projectedEnd + 1
    // 12 h = 1.5 days, drawn as 2 (10-01..10-02); due 10-01 → 1 day late.
    expect(run(12, '2026-10-01').dueViolations?.[0]).toMatchObject({ projectedEnd: '2026-10-02', lateDays: 1 });
    // 10 h = 1.25 days, drawn as 1 day: the overrun rounds away, as it does on the bar.
    expect(run(10, '2026-10-01').dueViolations).toEqual([]);
  });
});

describe('buildBaseline (#113)', () => {
  it('freezes every projected bar as the Gantt draws it, keeping the hand-set fields', () => {
    const nodes = [
      leaf('a', { effortEstimate: 5, priority: 'P0' }),
      leaf('b', { effortEstimate: 2, priority: 'P1', dueDate: '2026-12-24' }),
    ];
    const b = buildBaseline({ map, nodes }, 'Q4 kickoff', new Date('2026-10-01T09:00:00Z'));
    expect(b.name).toBe('Q4 kickoff');
    expect(b.createdAt).toBe('2026-10-01T09:00:00.000Z');
    expect(b.nodes.a).toMatchObject({ plannedStart: '2026-10-01', plannedEnd: '2026-10-06', dueDate: null });
    expect(b.nodes.b).toMatchObject({ plannedStart: '2026-10-06', plannedEnd: '2026-10-08', dueDate: '2026-12-24' });
  });
});

describe('capBaselines (#113 review)', () => {
  const b = (i: number) => ({ id: `b${i}`, name: `B${i}`, createdAt: '', nodes: {} });
  it(`keeps the newest ${MAX_BASELINES}, names the dropped ones`, () => {
    const all = Array.from({ length: MAX_BASELINES + 2 }, (_, i) => b(i));
    const { kept, dropped } = capBaselines(all);
    expect(kept.map((x) => x.id)).toEqual(all.slice(2).map((x) => x.id));
    expect(dropped).toEqual(['B0', 'B1']);
    expect(capBaselines([b(1)]).dropped).toEqual([]);
  });
});
