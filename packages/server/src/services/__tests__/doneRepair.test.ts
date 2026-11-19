/**
 * The one-time done repair: done leaves below 100 % → 100, a fleet worker's
 * own note on a done node → cleared with its blocked tag. Dry run counts the
 * same and writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  maps: [] as Array<Record<string, unknown>>,
  nodes: new Map<string, unknown[]>(),
  writes: [] as Array<Record<string, unknown>>,
  nextMap: 0,
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        // The map query has a `name` field; the node query is per map, in order.
        if ('name' in fields) return mocks.maps;
        return { where: async () => mocks.nodes.get(mocks.maps[mocks.nextMap++].id as string) ?? [] };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: async () => {
          mocks.writes.push(s);
        },
      }),
    }),
  },
}));

import { planDoneRepair, repairDoneNodes, type DoneRepairRow } from '../doneRepair.js';

const isDone = (s: string | null) => s === 'done';
const row = (r: Partial<DoneRepairRow> & { id: string }): DoneRepairRow => ({
  status: 'done',
  percentComplete: 100,
  childrenOrder: [],
  blockedReason: null,
  tags: [],
  ...r,
});
const workflow = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '', position: 0 },
  { id: 'done', name: 'Done', category: 'done', color: '', position: 1 },
];

describe('planDoneRepair', () => {
  it('done leaves below 100 % get 100; parents and open leaves are left alone', () => {
    const plan = planDoneRepair(
      [
        row({ id: 'a', percentComplete: 40 }),
        row({ id: 'b', percentComplete: null }),
        row({ id: 'c', percentComplete: 100 }),
        row({ id: 'p', percentComplete: 10, childrenOrder: ['x'] }),
        row({ id: 'o', status: 'todo', percentComplete: 10 }),
      ],
      isDone,
    );
    expect(plan.progress).toEqual(['a', 'b']);
    expect(plan.notes).toEqual([]);
  });

  it("clears a worker's own note on a done node (parent too), keeps a person's", () => {
    const plan = planDoneRepair(
      [
        row({ id: 'w', blockedReason: 'Fleet worker s-1: needs a decision: already done', tags: ['bug', 'blocked'] }),
        row({ id: 'wp', childrenOrder: ['x'], blockedReason: 'Fleet worker s-2: PR #1 was closed without merging' }),
        row({ id: 'h', blockedReason: 'waiting on Dan' }),
        row({ id: 'open', status: 'todo', blockedReason: 'Fleet worker s-3: CI failed on PR #4' }),
      ],
      isDone,
    );
    expect(plan.notes).toEqual([
      { id: 'w', tags: ['bug'] },
      { id: 'wp', tags: [] },
    ]);
  });
});

describe('repairDoneNodes', () => {
  beforeEach(() => {
    mocks.maps = [
      { id: 'm1', name: 'Navy App', statusWorkflow: workflow },
      { id: 'm2', name: 'Clean', statusWorkflow: workflow },
    ];
    mocks.nodes = new Map([
      ['m1', [row({ id: 'a', percentComplete: 0 }), row({ id: 'b', percentComplete: 50, blockedReason: 'Fleet worker s: x' })]],
      ['m2', [row({ id: 'c' })]],
    ]);
    mocks.writes = [];
    mocks.nextMap = 0;
  });

  it('dry run: counts per map, writes nothing', async () => {
    const counts = await repairDoneNodes({ dryRun: true });
    expect(counts).toEqual([{ mapId: 'm1', mapName: 'Navy App', progress: 2, notes: 1 }]);
    expect(mocks.writes).toEqual([]);
  });

  it('apply: writes the same', async () => {
    const counts = await repairDoneNodes({ dryRun: false });
    expect(counts).toEqual([{ mapId: 'm1', mapName: 'Navy App', progress: 2, notes: 1 }]);
    expect(mocks.writes).toEqual([{ percentComplete: 100 }, { blockedReason: null, tags: [] }]);
  });
});
