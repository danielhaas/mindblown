/**
 * Personal leave (#664): work pauses on its person's days off.
 */
import { describe, it, expect } from 'vitest';
import type { Node, MindMap } from '../types.js';
import { schedule, endOverDaysOff, type DaysOff } from '../dependencies.js';
import { leaveDaysOff, isFleetBuilt, describeLeave, validateLeaveInput } from '../leave.js';
import { makeDayMapper } from '../workCalendar.js';

function leaf(id: string, effort: number, over: Partial<Node> = {}): Node {
  return {
    id,
    parentId: null,
    childrenIds: [],
    text: id,
    dependencies: [],
    effortEstimate: effort,
    percentComplete: null,
    status: 'todo',
    priority: null,
    priorityRank: null,
    startDate: null,
    dueDate: null,
    completedAt: null,
    assigneeIds: [],
    tags: [],
    approval: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as unknown as Node;
}

const at = (r: ReturnType<typeof schedule>, id: string) => r.find((s) => s.nodeId === id)!;

describe('endOverDaysOff', () => {
  it('pauses over days off inside the work, not those before or after', () => {
    const off: DaysOff = [[0, 1], [5, 7], [20, 21]];
    expect(endOverDaysOff(1, 6, off)).toBe(9); // 1..5 work, 5..7 off, 7..9 work
    expect(endOverDaysOff(7, 3, off)).toBe(10);
    expect(endOverDaysOff(1, 4, off)).toBe(5); // ends right as the leave starts
  });
});

describe('schedule — leave on a serial track', () => {
  const nodes = [leaf('a', 3, { priority: 'P0' }), leaf('b', 4, { priority: 'P1' })];

  it('work stops on the leave days and carries on after them', () => {
    // Days 4–5 off: a = 0..3, b starts 3, works day 3, pauses 4–5, then 6..9.
    const r = schedule(nodes, 0, undefined, undefined, 1, 0, undefined, undefined, { tracks: [[[4, 6]]] });
    expect(at(r, 'a')).toMatchObject({ computedStart: 0, computedEnd: 3 });
    expect(at(r, 'b')).toMatchObject({ computedStart: 3, computedEnd: 9 });
  });

  it('work never starts on a leave day', () => {
    const r = schedule([leaf('a', 2)], 0, undefined, undefined, 1, 0, undefined, undefined, { tracks: [[[0, 3]]] });
    expect(at(r, 'a')).toMatchObject({ computedStart: 3, computedEnd: 5 });
  });

  it('without leave the schedule is unchanged', () => {
    const plain = schedule(nodes, 0, undefined, undefined, 1);
    const empty = schedule(nodes, 0, undefined, undefined, 1, 0, undefined, undefined, { tracks: [[]] });
    expect(empty).toEqual(plain);
  });
});

describe('schedule — an assignee vs a map worker (workerCount 2)', () => {
  // Track 0 = Dan (off days 0–5), track 1 = Ana (no leave).
  const calendars = (nodes: Map<string, DaysOff>, pinned: Map<string, number>) => ({
    tracks: [[[0, 5]] as DaysOff, [] as DaysOff],
    nodes,
    pinnedTrack: pinned,
  });

  it("an assignee's leave delays only their own nodes", () => {
    const nodes = [leaf('dan1', 2, { priority: 'P0' }), leaf('ana1', 2, { priority: 'P1' })];
    const r = schedule(nodes, 0, undefined, undefined, 2, 0, undefined, undefined, calendars(new Map(), new Map([['dan1', 0], ['ana1', 1]])));
    expect(at(r, 'dan1')).toMatchObject({ computedStart: 5, computedEnd: 7 });
    expect(at(r, 'ana1')).toMatchObject({ computedStart: 0, computedEnd: 2 });
  });

  it('unassigned work goes to the worker who finishes it first', () => {
    const r = schedule([leaf('x', 2)], 0, undefined, undefined, 2, 0, undefined, undefined, calendars(new Map(), new Map()));
    expect(at(r, 'x')).toMatchObject({ computedStart: 0, computedEnd: 2 }); // Ana's track
  });

  it("an assignee who is not a map worker brings their own leave to any track", () => {
    const r = schedule([leaf('x', 2)], 0, undefined, undefined, 2, 0, undefined, undefined,
      calendars(new Map([['x', [[0, 3]] as DaysOff]]), new Map()));
    expect(at(r, 'x')).toMatchObject({ computedStart: 3, computedEnd: 5 });
  });

  it('fleet-built work ignores the track worker\'s leave', () => {
    const r = schedule([leaf('f', 2)], 0, undefined, undefined, 1, 0, undefined, undefined,
      { tracks: [[[0, 5]]], nodes: new Map([['f', []]]) });
    expect(at(r, 'f')).toMatchObject({ computedStart: 0, computedEnd: 2 });
  });
});

describe('leaveDaysOff', () => {
  it('a range over public holidays and a weekend counts each working day once', () => {
    // AU-VIC-like: 25 Dec, 28 Dec (Boxing Day observed) and 1 Jan are holidays.
    const holidays = new Set(['2026-12-25', '2026-12-28', '2027-01-01']);
    const mapper = makeDayMapper('2026-12-01', holidays);
    const { off, days } = leaveDaysOff([{ startDate: '2026-12-21', endDate: '2027-01-04' }], mapper, holidays);
    expect(days).toBe(8); // 21–24, 29–31 Dec, 4 Jan
    // Contiguous in working-day offsets: the holidays are not days at all.
    expect(off).toEqual([[mapper.toOffset('2026-12-21'), mapper.toOffset('2026-12-21') + 8]]);
  });

  it('overlapping ranges are not counted twice; hours maps scale the intervals', () => {
    const mapper = makeDayMapper('2026-12-01', null);
    const { off, days } = leaveDaysOff(
      [{ startDate: '2026-12-02', endDate: '2026-12-03' }, { startDate: '2026-12-03', endDate: '2026-12-04' }],
      mapper, null, 8,
    );
    expect(days).toBe(3);
    expect(off).toEqual([[8, 32]]);
  });
});

describe('isFleetBuilt', () => {
  const fleetMap = { fleetId: 'f1' } as Pick<MindMap, 'fleetId'>;
  const approved = { state: 'approved', merge: 'auto', by: null, at: '' } as const;

  it('an approved, unassigned ticket on a fleet map is fleet-built', () => {
    expect(isFleetBuilt(fleetMap, leaf('a', 1, { approval: approved }))).toBe(true);
  });

  it('needs-human steps, assigned nodes and maps without a fleet follow a person', () => {
    expect(isFleetBuilt(fleetMap, leaf('a', 1, { approval: approved, tags: ['needs-human'] }))).toBe(false);
    expect(isFleetBuilt(fleetMap, leaf('a', 1, { approval: approved, assigneeIds: ['u1'] }))).toBe(false);
    expect(isFleetBuilt({ fleetId: null }, leaf('a', 1, { approval: approved }))).toBe(false);
  });
});

describe('describeLeave / validateLeaveInput', () => {
  it('one line naming the person and the dates', () => {
    expect(describeLeave([{ name: 'Dan', ranges: [{ startDate: '2026-12-21', endDate: '2027-01-04', note: null }] }]))
      .toBe('Includes leave: Dan 21 Dec – 4 Jan');
    expect(describeLeave([])).toBeNull();
  });

  it('rejects bad dates and an end before the start', () => {
    expect(validateLeaveInput({ startDate: '2026-12-21', endDate: '2027-01-04' })).toBeNull();
    expect(validateLeaveInput({ startDate: '2026-12-21', endDate: '2026-12-20' })).toMatch(/before/);
    expect(validateLeaveInput({ startDate: '21.12.2026', endDate: '2027-01-04' })).toMatch(/startDate/);
  });
});
