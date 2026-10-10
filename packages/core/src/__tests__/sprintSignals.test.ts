import { describe, it, expect } from 'vitest';
import { sprintSignals, type SprintLike } from '../sprintSignals.js';

const NOW = new Date('2026-08-26T12:00:00Z');
const sp = (p: Partial<SprintLike>): SprintLike => ({
  id: 's1', name: 'V1 fertigstellen', status: 'planned', startDate: '2026-08-11', endDate: '2026-08-26', versionId: 'v1', ...p,
});
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('sprintSignals (#324)', () => {
  it('state vs dates: ended-but-planned, started-but-planned, ended-but-active, fine', () => {
    const at = (p: Partial<SprintLike>) => sprintSignals({ sprint: sp(p), sprints: [], items: [], wipLimit: null, now: NOW }).stateIssue;
    expect(at({ endDate: '2026-08-25' })).toBe('Ended 2026-08-25 but still planned — never started');
    expect(at({})).toBe('Started 2026-08-11 on paper but still planned'); // ends today
    expect(at({ status: 'active', endDate: '2026-08-20' })).toBe('Ended 2026-08-20 but still active');
    expect(at({ status: 'active' })).toBeNull();
    expect(at({ startDate: '2026-09-01', endDate: '2026-09-14' })).toBeNull();
  });

  it('overlaps: other open sprints of the same version whose days intersect', () => {
    const a = sp({});
    const sprints = [
      a,
      sp({ id: 's2', name: 'Sprint 0', startDate: '2026-08-25', endDate: '2026-09-07' }),
      sp({ id: 's3', name: 'Other version', versionId: 'v2', startDate: '2026-08-20', endDate: '2026-09-01' }),
      sp({ id: 's4', name: 'Done one', status: 'completed', startDate: '2026-08-20', endDate: '2026-09-01' }),
      sp({ id: 's5', name: 'Later', startDate: '2026-08-27', endDate: '2026-09-10' }),
    ];
    expect(sprintSignals({ sprint: a, sprints, items: [], wipLimit: null, now: NOW }).overlaps).toEqual(['Sprint 0']);
  });

  it('WIP against the limit, and stalled in-progress items', () => {
    const items = [
      { category: 'in_progress', percentComplete: 20, updatedAt: daysAgo(20) },
      { category: 'in_progress', percentComplete: 50, updatedAt: daysAgo(1) },
      { category: 'in_progress', percentComplete: 100, updatedAt: daysAgo(30) }, // finished
      { category: 'todo', percentComplete: 0, updatedAt: daysAgo(40) },
    ];
    const sig = sprintSignals({ sprint: sp({ status: 'active' }), sprints: [], items, wipLimit: 1, now: NOW });
    expect(sig.wip).toEqual({ count: 2, limit: 1, over: true });
    expect(sig.stalled).toBe(1);
    expect(sprintSignals({ sprint: sp({ status: 'active' }), sprints: [], items, wipLimit: null, now: NOW }).wip.over).toBe(false);
  });
});
