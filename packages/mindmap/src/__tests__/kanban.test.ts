import { describe, it, expect } from 'vitest';
import { groupDone, doneGroupBounds, isBlockedCard } from '../kanban.js';

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

describe('isBlockedCard', () => {
  const n = (p: Partial<{ status: string | null; blockedReason: string | null; tags: string[] }>) => ({
    status: 'in_progress', blockedReason: null, tags: [], ...p,
  });
  it('a reason, the fleet\'s blocked tag, or a "blocked" status', () => {
    expect(isBlockedCard(n({ blockedReason: 'waiting on legal' }), false)).toBe(true);
    expect(isBlockedCard(n({ tags: ['blocked'] }), false)).toBe(true);
    expect(isBlockedCard(n({ status: 'Blocked' }), false)).toBe(true);
    expect(isBlockedCard(n({ blockedReason: '  ' }), false)).toBe(false);
    expect(isBlockedCard(n({}), false)).toBe(false);
  });
  it('done work is never shown as blocked', () => {
    expect(isBlockedCard(n({ blockedReason: 'stale' }), true)).toBe(false);
  });
});
