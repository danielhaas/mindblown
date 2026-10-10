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
});
