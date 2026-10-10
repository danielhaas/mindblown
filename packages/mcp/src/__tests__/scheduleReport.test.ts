/**
 * get_schedule's report carries each node's id (#191): agents act on the
 * queue (tag, claim, re-prioritise) and otherwise had to look every title
 * up with search_nodes first.
 */
import { describe, it, expect } from 'vitest';
import { formatScheduleReport } from '../formatters.js';
import type { MapDetail, ScheduleResult } from '../api.js';

const node = (id: string, text: string) => ({ id, text, computedProgress: 50 });

describe('formatScheduleReport (#191)', () => {
  it('prints the node id on critical-path and scheduled lines', () => {
    const map = {
      map: { name: 'Plan', effortUnit: 'hours' },
      nodes: [node('n-a', 'Design'), node('n-b', 'Build')],
    } as unknown as MapDetail;
    const schedule = {
      criticalPath: { path: ['n-a'], totalDuration: 4, float: { 'n-a': 0, 'n-b': 2 } },
      workerCount: 2,
      schedule: [
        { nodeId: 'n-a', computedStart: 0, computedEnd: 4, duration: 4 },
        { nodeId: 'n-b', computedStart: 0, computedEnd: 2, duration: 2 },
      ],
    } as unknown as ScheduleResult;
    const out = formatScheduleReport(map, schedule);
    expect(out).toContain('-> Design [n-a] (50% complete)');
    expect(out).toContain('- Design [n-a]: day 0 - 4 (4 duration) **CRITICAL**');
    expect(out).toContain('- Build [n-b]: day 0 - 2 (2 duration) slack: 2');
    expect(out).toContain('## Critical Path (capacity-aware, 2 workers)');
  });

  it('prints dates on the map\'s calendar — working days once holidays are set (#110)', () => {
    const map = { map: { name: 'Plan', effortUnit: 'days' }, nodes: [node('n-a', 'Design')] } as unknown as MapDetail;
    const base = {
      criticalPath: { path: ['n-a'], totalDuration: 3, float: { 'n-a': 0 } },
      schedule: [{ nodeId: 'n-a', computedStart: 0, computedEnd: 3, duration: 3 }],
      projectStartDate: '2026-12-23',
      unitsPerDay: 1,
    };
    const every = formatScheduleReport(map, { ...base, workingCalendar: null } as unknown as ScheduleResult);
    expect(every).toContain('every day counts from 2026-12-23');
    // The end shown is the last day worked (23, 24, 25), not the next start.
    expect(every).toContain('day 0 - 3 (2026-12-23 → 2026-12-25, 3 duration)');
    const li = formatScheduleReport(map, {
      ...base,
      workingCalendar: { jurisdiction: 'LI', holidays: ['2026-12-25', '2026-12-26'] },
    } as unknown as ScheduleResult);
    expect(li).toContain('Mon–Fri, LI public holidays');
    expect(li).toContain('day 0 - 3 (2026-12-23 → 2026-12-28, 3 duration)');
  });
});
