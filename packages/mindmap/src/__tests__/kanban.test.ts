import { describe, it, expect } from 'vitest';
import type { StatusDef } from '@mindblown/core';
import { groupDone, doneGroupBounds, cardBlockState, kanbanColumnId } from '../kanban.js';

describe('kanbanColumnId', () => {
  const workflow: StatusDef[] = [
    { id: 'todo', name: 'Todo', category: 'todo', color: '#94a3b8', position: 0 },
    { id: 'wip', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
    { id: 'shipped', name: 'Done', category: 'done', color: '#10b981', position: 2 },
  ];

  it('matches a status by id or by name, case-insensitively', () => {
    expect(kanbanColumnId({ status: 'wip', percentComplete: 0 }, workflow)).toBe('wip');
    expect(kanbanColumnId({ status: 'in progress', percentComplete: 0 }, workflow)).toBe('wip');
  });

  it('puts a no-status leaf at 100 % in the done column, not under no status', () => {
    expect(kanbanColumnId({ status: null, percentComplete: 100 }, workflow)).toBe('shipped');
    expect(kanbanColumnId({ status: 'unknown', percentComplete: 100 }, workflow)).toBe('shipped');
  });

  it('leaves an unfinished no-status leaf under no status', () => {
    expect(kanbanColumnId({ status: null, percentComplete: 99 }, workflow)).toBeNull();
    expect(kanbanColumnId({ status: null, percentComplete: null }, workflow)).toBeNull();
  });

  it('keeps an explicit status even at 100 %, so a card dragged out of Done stays put', () => {
    expect(kanbanColumnId({ status: 'todo', percentComplete: 100 }, workflow)).toBe('todo');
  });

  it('falls back to no status when the workflow has no done column', () => {
    expect(kanbanColumnId({ status: null, percentComplete: 100 }, workflow.slice(0, 2))).toBeNull();
  });
});

// Friday 10 Oct 2026, 15:00 local.
const NOW = new Date(2026, 9, 10, 15, 0, 0);
const local = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0).toISOString();

describe('groupDone', () => {
  it('week starts Monday 00:00 local; Sunday belongs to the week before', () => {
    const { todayStart, weekStart } = doneGroupBounds(NOW);
    expect(new Date(todayStart)).toEqual(new Date(2026, 9, 10));
    expect(new Date(weekStart)).toEqual(new Date(2026, 9, 5)); // Monday
    expect(new Date(doneGroupBounds(new Date(2026, 9, 11, 9)).weekStart)).toEqual(new Date(2026, 9, 5)); // Sunday
  });

  it('Today / This week / Earlier, newest first; no completion time → Earlier', () => {
    const items = [
      { id: 'mon', at: local(5) },
      { id: 'today-am', at: local(10, 8) },
      { id: 'lastweek', at: local(3) },
      { id: 'today-pm', at: local(10, 14) },
      { id: 'imported', at: null },
      { id: 'wed', at: local(7) },
    ];
    const g = groupDone(items, (i) => i.at, NOW);
    expect(g.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([
      ['today', ['today-pm', 'today-am']],
      ['week', ['wed', 'mon']],
      ['earlier', ['lastweek', 'imported']],
    ]);
  });
});

describe('cardBlockState — the Blocked panel\'s rule', () => {
  const n = (p: Partial<{ status: string | null; blockedReason: string | null; tags: string[] }>) => ({
    status: 'in_progress', blockedReason: null, tags: [], ...p,
  });
  const title = (id: string) => ({ a1: 'Appliance #1' } as Record<string, string>)[id] ?? id;
  const none = { manual: false, predecessorIds: [] };

  it('manual: a reason, the fleet\'s blocked tag, or a "blocked" status', () => {
    expect(cardBlockState(n({ blockedReason: 'waiting on legal' }), { manual: true, predecessorIds: [] }, false, title))
      .toEqual({ kind: 'blocked', detail: 'Blocked: waiting on legal' });
    expect(cardBlockState(n({ tags: ['blocked'] }), none, false, title)?.kind).toBe('blocked');
    expect(cardBlockState(n({ status: 'Blocked' }), none, false, title)?.kind).toBe('blocked');
  });
  it('waiting: an unfinished finish-to-start predecessor, named', () => {
    expect(cardBlockState(n({}), { manual: false, predecessorIds: ['a1'] }, false, title))
      .toEqual({ kind: 'waiting', detail: 'Waiting on: Appliance #1' });
  });
  it('nothing otherwise; done work never', () => {
    expect(cardBlockState(n({}), none, false, title)).toBeNull();
    expect(cardBlockState(n({ blockedReason: 'stale' }), { manual: true, predecessorIds: ['a1'] }, true, title)).toBeNull();
  });
});
