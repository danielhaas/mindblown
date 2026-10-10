/**
 * #113: a due date is a deadline, not a bar length — the projection reports
 * nodes that land after it (as dates, in calendar days) instead of
 * stretching them; and a baseline freezes the bars exactly as the Gantt
 * draws them.
 */
import { describe, it, expect } from 'vitest';
import type { MindMap, Node as CoreNode } from '@mindblown/core';
import { computeMapSchedule, buildBaseline } from '../mapSchedule.js';

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

  it('reports a node that lands after its due date, in dates and calendar days', () => {
    const r = computeMapSchedule({ map, nodes });
    expect(r.dueViolations).toEqual([
      { nodeId: 'a', text: 'a', dueDate: '2026-10-04', projectedEnd: '2026-10-06', lateDays: 2 },
    ]);
  });

  it('never stretches a bar to a later due date', () => {
    const r = computeMapSchedule({ map, nodes });
    const b = r.schedule.find((s) => s.nodeId === 'b')!;
    expect(b.computedEnd - b.computedStart).toBe(2);
    expect(b.dueOverrun).toBeUndefined();
  });

  it('hours maps report lateness in calendar days', () => {
    const hourly = { ...map, effortUnit: 'hours' } as MindMap;
    const r = computeMapSchedule({ map: hourly, nodes: [leaf('h', { effortEstimate: 24, dueDate: '2026-10-02' })] });
    expect(r.dueViolations?.[0]).toMatchObject({ nodeId: 'h', projectedEnd: '2026-10-04', lateDays: 2 });
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
