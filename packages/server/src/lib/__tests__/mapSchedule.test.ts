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

describe('computeMapSchedule — working calendar (#110)', () => {
  // LI: 25 + 26 Dec are public holidays, 27 is a Sunday.
  const liMap = { ...map, projectStartDate: '2026-12-23', holidayJurisdiction: 'LI', holidayOverrides: { add: [], remove: [] } } as unknown as MindMap;

  it('a 3-day task from 23 Dec ends (exclusive) 29 Dec / last work day 28 Dec — the deadline compares on that calendar', () => {
    const late = computeMapSchedule({ map: liMap, nodes: [leaf('a', { effortEstimate: 3, dueDate: '2026-12-24' })] });
    // Works 23, 24, 28: due Thursday 24, last day Monday 28 — 4 calendar days late.
    expect(late.dueViolations).toEqual([{ nodeId: 'a', text: 'a', dueDate: '2026-12-24', projectedEnd: '2026-12-28', lateDays: 4 }]);
    expect(late.workingCalendar?.holidays).toEqual(expect.arrayContaining(['2026-12-25', '2026-12-26']));

    const onTime = computeMapSchedule({ map: liMap, nodes: [leaf('a', { effortEstimate: 3, dueDate: '2026-12-28' })] });
    expect(onTime.dueViolations).toEqual([]);
  });

  it('a due date on a holiday or weekend means the end of the working day before it', () => {
    // Due Sunday 27: the last working day before is Thursday 24 — work ending Monday 28 is late.
    const r = computeMapSchedule({ map: liMap, nodes: [leaf('a', { effortEstimate: 3, dueDate: '2026-12-27' })] });
    expect(r.dueViolations.map((v) => [v.projectedEnd, v.lateDays])).toEqual([['2026-12-28', 1]]);
    // Two days of work (23, 24) due on the holiday 25th: on time.
    expect(computeMapSchedule({ map: liMap, nodes: [leaf('a', { effortEstimate: 2, dueDate: '2026-12-25' })] }).dueViolations).toEqual([]);
  });

  it('a baseline freezes the bars on the working calendar (end exclusive)', () => {
    const b = buildBaseline({ map: liMap, nodes: [leaf('a', { effortEstimate: 3 })] }, 'LI');
    expect(b.nodes.a).toMatchObject({ plannedStart: '2026-12-23', plannedEnd: '2026-12-29' });
  });

  it('a map without a holiday calendar keeps counting every day', () => {
    const r = computeMapSchedule({ map: { ...liMap, holidayJurisdiction: null } as unknown as MindMap, nodes: [leaf('a', { effortEstimate: 3, dueDate: '2026-12-25' })] });
    expect(r.workingCalendar).toBeNull();
    expect(r.dueViolations).toEqual([]); // 23, 24, 25
  });
});

