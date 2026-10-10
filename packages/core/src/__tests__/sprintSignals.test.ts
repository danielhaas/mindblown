import { describe, it, expect } from 'vitest';
import { sprintSignals, planSprintTransitions, type SprintLike } from '../sprintSignals.js';

const NOW = new Date('2026-08-26T12:00:00Z');
const sp = (p: Partial<SprintLike>): SprintLike => ({
  id: 's1', name: 'V1 fertigstellen', status: 'planned', startDate: '2026-08-11', endDate: '2026-08-26', versionId: 'v1', ...p,
});
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('sprintSignals (#324)', () => {
  it('state vs dates: ended-but-planned, started-but-planned, ended-but-active, fine', () => {
    const at = (p: Partial<SprintLike>) => sprintSignals({ sprint: sp(p), sprints: [], items: [], now: NOW }).stateIssue;
    expect(at({ endDate: '2026-08-25' })).toBe('Ended 2026-08-25 but still planned — never started');
    expect(at({})).toBe('Started 2026-08-11 on paper but still planned'); // ends today
    expect(at({ startDate: '2026-08-26', endDate: '2026-09-08' })).toBeNull(); // starts today: a day of grace
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
      sp({ id: 's6', name: 'Handover', startDate: '2026-08-26', endDate: '2026-09-09' }), // shares only the boundary day
      sp({ id: 's7', name: 'Unversioned', versionId: null, startDate: '2026-08-20', endDate: '2026-09-01' }),
    ];
    expect(sprintSignals({ sprint: a, sprints, items: [], now: NOW }).overlaps).toEqual(['Sprint 0']);
  });

  it("in-progress count and stalled (14 d, the Cockpit's threshold); finished work is not WIP", () => {
    const items = [
      { category: 'in_progress', percentComplete: 20, updatedAt: daysAgo(20) },
      { category: 'in_progress', percentComplete: 50, updatedAt: daysAgo(10) },
      { category: 'in_progress', percentComplete: 100, updatedAt: daysAgo(30) }, // finished
      { category: 'todo', percentComplete: 0, updatedAt: daysAgo(40) },
    ];
    const sig = sprintSignals({ sprint: sp({ status: 'active' }), sprints: [], items, now: NOW });
    expect(sig.inProgress).toBe(2);
    expect(sig.stalled).toBe(1);
    expect(sig.stalledDays).toBe(14);
  });
});

describe('planSprintTransitions (#154, #192)', () => {
  const at = new Date('2026-10-10T12:00:00Z');
  const s = (p: Partial<SprintLike>): SprintLike => ({ id: 'x', name: 'x', status: 'planned', startDate: '2026-10-01', endDate: '2026-10-07', versionId: 'v1', ...p });

  it('an ended sprint is completed and rolls into the next open sprint of its version', () => {
    const t = planSprintTransitions(
      [
        s({ id: 'old', status: 'active', startDate: '2026-09-28', endDate: '2026-10-09' }),
        s({ id: 'next', startDate: '2026-10-10', endDate: '2026-10-23' }),
        s({ id: 'other', versionId: 'v2', startDate: '2026-10-10', endDate: '2026-10-23' }),
      ],
      at,
    );
    expect(t).toEqual([
      { sprintId: 'old', action: 'complete', rollToSprintId: 'next' },
      { sprintId: 'next', action: 'activate' }, // the version freed up in the same run
      { sprintId: 'other', action: 'activate' },
    ]);
  });

  it('a never-started sprint whose end passed is completed too; no successor = nothing to roll into', () => {
    expect(planSprintTransitions([s({ id: 'drift', endDate: '2026-08-26' })], at)).toEqual([
      { sprintId: 'drift', action: 'complete', rollToSprintId: null },
    ]);
  });

  it('never two active sprints in one version: an active one blocks, and only the earliest of several starts', () => {
    expect(
      planSprintTransitions(
        [s({ id: 'running', status: 'active', startDate: '2026-10-06', endDate: '2026-10-19' }), s({ id: 'overlap', startDate: '2026-10-08', endDate: '2026-10-21' })],
        at,
      ),
    ).toEqual([]);
    expect(
      planSprintTransitions([s({ id: 'b', startDate: '2026-10-09', endDate: '2026-10-20' }), s({ id: 'a', startDate: '2026-10-08', endDate: '2026-10-20' })], at),
    ).toEqual([{ sprintId: 'a', action: 'activate' }]);
  });

  it('future and completed sprints are left alone', () => {
    expect(
      planSprintTransitions([s({ id: 'future', startDate: '2026-11-01', endDate: '2026-11-14' }), s({ id: 'done', status: 'completed', endDate: '2026-09-01' })], at),
    ).toEqual([]);
  });
});
