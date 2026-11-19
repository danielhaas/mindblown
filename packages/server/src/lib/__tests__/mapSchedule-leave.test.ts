/**
 * Personal leave (#664) through the map's projection: the Loke-Support
 * case (AU-VIC calendar, one developer) and who the leave applies to.
 */
import { describe, it, expect } from 'vitest';
import type { MindMap, Node as CoreNode, PersonLeave } from '@mindblown/core';
import { computeMapSchedule } from '../mapSchedule.js';
import { buildTimelineMarkdown } from '../../export/timeline.js';

const DAN = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';

const map = {
  id: 'm1',
  name: 'Loke-Support',
  rootNodeId: 'root',
  projectStartDate: '2026-11-23',
  effortUnit: 'days',
  hoursPerDay: 8,
  workerCount: 1,
  focusFactor: 1,
  baselines: [],
  holidayJurisdiction: 'AU-VIC',
  holidayOverrides: { add: [], remove: [] },
  workers: [DAN],
  fleetId: null,
  statusWorkflow: [
    { id: 'todo', name: 'Todo', category: 'todo', color: '#999', position: 0 },
    { id: 'done', name: 'Done', category: 'done', color: '#0f0', position: 1 },
  ],
} as unknown as MindMap;

function node(id: string, over: Partial<CoreNode>): CoreNode {
  return {
    id,
    parentId: 'root',
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
    assigneeIds: [],
    tags: [],
    approval: null,
    externalLinks: [],
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as unknown as CoreNode;
}

const stages = [
  node('M3', { effortEstimate: 21, priorityRank: 3 }),
  node('M4', { effortEstimate: 10, priorityRank: 4 }),
  node('M5', { effortEstimate: 6, priorityRank: 5 }),
];
const nodes = [node('root', { parentId: null, childrenIds: ['M3', 'M4', 'M5'], effortEstimate: null }), ...stages];
const christmas: PersonLeave = { userId: DAN, name: 'Dan', ranges: [{ startDate: '2026-12-21', endDate: '2027-01-04', note: 'Christmas' }] };

const ends = (r: ReturnType<typeof computeMapSchedule>) =>
  Object.fromEntries(stages.map((s) => [s.id, r.schedule.find((x) => x.nodeId === s.id)!.computedEnd]));
const lastDay = (r: ReturnType<typeof computeMapSchedule>, id: string) => r.barSpan(r.schedule.find((x) => x.nodeId === id)!).end;

describe('computeMapSchedule — personal leave (#664)', () => {
  it("the one worker's Christmas leave moves M3–M5 by its 8 AU-VIC working days", () => {
    const before = computeMapSchedule({ map, nodes });
    const after = computeMapSchedule({ map, nodes, leave: [christmas] });
    const b = ends(before);
    const a = ends(after);
    for (const id of ['M3', 'M4', 'M5']) expect(a[id] - b[id]).toBe(8);
    // In dates: M3 finished on 21 Dec without leave, on 5 Jan with it.
    expect(lastDay(before, 'M3')).toBe('2026-12-21');
    expect(lastDay(after, 'M3')).toBe('2027-01-05');
    expect(after.leave).toEqual([
      expect.objectContaining({ userId: DAN, name: 'Dan', track: 0, ranges: [expect.objectContaining({ workingDays: 8 })] }),
    ]);
    expect(after.leave[0].days).toHaveLength(8);
    expect(after.leave[0].days).not.toContain('2026-12-25');
    expect(after.nodeLeave).toMatchObject({ M3: DAN, M4: DAN, M5: DAN });
  });

  it('the export says so', () => {
    const md = buildTimelineMarkdown({ map, nodes, leave: [christmas] }, { now: new Date('2026-11-19T00:00:00Z') });
    expect(md).toContain('Includes leave: Dan 21 Dec – 4 Jan');
    expect(buildTimelineMarkdown({ map, nodes }, { now: new Date('2026-11-19T00:00:00Z') })).not.toContain('Includes leave');
  });

  it("with two workers, an assignee's leave delays only their nodes", () => {
    const two = { ...map, workerCount: 2, workers: [DAN, ANA] } as MindMap;
    const work = [
      node('root', { parentId: null, childrenIds: ['dan', 'ana'], effortEstimate: null }),
      node('dan', { effortEstimate: 25, assigneeIds: [DAN] }),
      node('ana', { effortEstimate: 25, assigneeIds: [ANA] }),
    ];
    const before = computeMapSchedule({ map: two, nodes: work });
    const after = computeMapSchedule({ map: two, nodes: work, leave: [christmas] });
    const end = (r: typeof before, id: string) => r.schedule.find((s) => s.nodeId === id)!.computedEnd;
    expect(end(after, 'dan') - end(before, 'dan')).toBe(8);
    expect(end(after, 'ana')).toBe(end(before, 'ana'));
  });

  it('fleet-built work ignores the worker\'s leave; a needs-human step follows them', () => {
    const fleetMap = { ...map, fleetId: 'f1' } as MindMap;
    const approved = { state: 'approved', merge: 'auto', by: null, at: '' };
    const run = (tags: string[], leave?: PersonLeave[]) =>
      computeMapSchedule({
        map: fleetMap,
        nodes: [node('root', { parentId: null, childrenIds: ['t'], effortEstimate: null }), node('t', { effortEstimate: 25, approval: approved as never, tags })],
        leave,
      }).schedule.find((s) => s.nodeId === 't')!.computedEnd;
    expect(run([], [christmas])).toBe(run([]));
    expect(run(['needs-human'], [christmas]) - run(['needs-human'])).toBe(8);
  });

  it('leave outside the projected work is not reported', () => {
    const later: PersonLeave = { userId: DAN, name: 'Dan', ranges: [{ startDate: '2028-07-01', endDate: '2028-07-10', note: null }] };
    const r = computeMapSchedule({ map, nodes, leave: [later] });
    expect(r.leave).toEqual([]);
    expect(ends(r)).toEqual(ends(computeMapSchedule({ map, nodes })));
  });
});
