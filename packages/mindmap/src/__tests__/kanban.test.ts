import { describe, it, expect } from 'vitest';
import type { Node, StatusDef } from '@mindblown/core';
import { groupDone, doneGroupBounds, cardBlockState, kanbanColumnId, startedLabel, etaLabel, readyNodeIds, personHolds } from '../kanban.js';

describe('etaLabel', () => {
  const now = new Date(2026, 9, 20, 12, 0); // local time — the label is local
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();

  it('is the clock time today, with the date on another day', () => {
    expect(etaLabel(at(2026, 9, 20, 15, 40), now)).toMatchObject({ short: 'ETA 15:40', overdue: false });
    expect(etaLabel(at(2026, 9, 22, 9, 5), now)?.short).toBe('ETA Oct 22, 09:05');
  });

  it('reads overdue once past, by how much', () => {
    expect(etaLabel(at(2026, 9, 20, 11, 50), now)).toMatchObject({ short: 'overdue 10m', overdue: true });
    expect(etaLabel(at(2026, 9, 20, 9, 30), now)?.short).toBe('overdue 2h');
    expect(etaLabel(at(2026, 9, 17, 12, 0), now)?.short).toBe('overdue 3d');
  });

  it('carries the exact time for the hover title', () => {
    expect(etaLabel(at(2026, 9, 20, 15, 40), now)?.full).toMatch(/^ETA Oct 20, 2026/);
  });

  it('is null without an ETA', () => {
    expect(etaLabel(null, now)).toBeNull();
    expect(etaLabel('garbage', now)).toBeNull();
  });
});

describe('startedLabel', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const short = (iso: string | null) => startedLabel(iso, now)?.short;

  it('is relative while recent', () => {
    expect(short(ago(20_000))).toBe('started just now');
    expect(short(ago(25 * 60_000))).toBe('started 25m ago');
    expect(short(ago(3 * 3_600_000))).toBe('started 3h ago');
    expect(short(ago(5 * 86_400_000))).toBe('started 5d ago');
  });

  it('is a date once older than two weeks', () => {
    expect(short(ago(20 * 86_400_000))).toMatch(/^started Sep 2[78]$/);
  });

  it('carries the exact time for the hover title', () => {
    expect(startedLabel(ago(3 * 3_600_000), now)?.full).toMatch(/^Started Oct 18, 2026/);
  });

  it('is null without a start on record', () => {
    expect(startedLabel(null, now)).toBeNull();
    expect(startedLabel('garbage', now)).toBeNull();
  });
});

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
  it('human: a person hold beats a dependency wait, a manual block beats both', () => {
    const hold = 'Needs a person: tagged needs-human';
    expect(cardBlockState(n({}), { manual: false, predecessorIds: ['a1'] }, false, title, hold))
      .toEqual({ kind: 'human', detail: hold });
    expect(cardBlockState(n({ blockedReason: 'legal' }), { manual: true, predecessorIds: [] }, false, title, hold)?.kind)
      .toBe('blocked');
    expect(cardBlockState(n({}), none, true, title, hold)).toBeNull();
  });
});

describe('readyNodeIds', () => {
  const workflow: StatusDef[] = [
    { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
    { id: 'doing', name: 'Doing', category: 'in_progress', color: '#000', position: 1 },
    { id: 'done', name: 'Done', category: 'done', color: '#000', position: 2 },
  ];
  const node = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      id, text: id, parentId: 'root', childrenIds: [], status: 'todo', claimedBySession: null,
      dependencies: [], tags: [], blockedReason: null, description: 'brief', externalLinks: [], ...extra,
    }) as unknown as Node;

  it('counts only what an agent could pick up now', () => {
    const nodes = [
      node('root', { parentId: null, childrenIds: ['ok', 'nostatus'] }),
      node('ok'),
      node('nostatus', { status: null }),
      node('started', { status: 'doing' }),
      node('finished', { status: 'done' }),
      node('claimed', { claimedBySession: 'w1' }),
      node('waits', { dependencies: [{ targetNodeId: 'started', type: 'FS' }] }),
      node('afterDone', { dependencies: [{ targetNodeId: 'finished', type: 'FS' }] }),
      node('nobrief', { description: null }),
      node('blocker', { blockedReason: 'waiting on Dan' }),
      node('human', { tags: ['needs-human'] }),
      node('epic', { text: 'Epic: billing' }),
      node('heldParent', { status: null, blockedReason: 'decision', childrenIds: ['underHeld'] }),
      node('underHeld', { parentId: 'heldParent' }),
    ];
    expect([...readyNodeIds(nodes, workflow)].sort()).toEqual(['afterDone', 'nostatus', 'ok']);
  });
});

describe('personHolds', () => {
  const workflow: StatusDef[] = [
    { id: 'todo', name: 'Todo', category: 'todo', color: '#000', position: 0 },
    { id: 'done', name: 'Done', category: 'done', color: '#000', position: 1 },
  ];
  const node = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, text: id, parentId: 'root', childrenIds: [], status: 'todo', tags: [], blockedReason: null, ...extra }) as unknown as Node;

  it('skip tags on the ticket or an open parent; not epics, not plain blockers, not under a done parent', () => {
    const holds = personHolds(
      [
        node('root', { parentId: null }),
        node('tagged', { tags: ['Needs-Human'] }),
        node('skip', { tags: ['kira-skip'] }),
        node('epic', { text: 'Epic: billing' }),
        node('blocker', { blockedReason: 'waiting on legal' }),
        node('decide', { text: 'Decide pricing', blockedReason: 'which tier?' }),
        node('underDecide', { parentId: 'decide' }),
        node('humanParent', { text: 'Contracts', tags: ['needs-human'] }),
        node('underHuman', { parentId: 'humanParent' }),
        node('doneParent', { status: 'done', tags: ['needs-human'] }),
        node('underDone', { parentId: 'doneParent' }),
        node('free'),
      ],
      workflow,
    );
    expect(Object.fromEntries(holds)).toEqual({
      tagged: 'Needs a person: tagged Needs-Human',
      skip: 'Needs a person: tagged kira-skip',
      underDecide: 'Needs a person: parent "Decide pricing" is blocked: which tier?',
      humanParent: 'Needs a person: tagged needs-human',
      underHuman: 'Needs a person: parent "Contracts" is tagged needs-human',
      doneParent: 'Needs a person: tagged needs-human',
    });
  });
});
