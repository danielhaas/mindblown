/**
 * The done repair: done leaves below 100 % → 100, a fleet worker's own note
 * on a done node → cleared with its blocked tag. Dry run counts the same and
 * writes nothing; apply only touches the maps named, never archived ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  maps: [] as Array<Record<string, unknown>>,
  nodes: new Map<string, unknown[]>(),
  writes: [] as Array<{ set: Record<string, unknown>; ids: string[] }>,
}));

// Conditions become plain data so the mock db can read which map / nodes a query targets.
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ and: c }),
  eq: (_col: unknown, v: unknown) => ({ eq: v }),
  isNull: () => ({ isNull: true }),
  inArray: (_col: unknown, v: unknown[]) => ({ inArray: v }),
}));

type Cond = { and?: Cond[]; eq?: string; inArray?: string[] };
const nodeOwner = (id: string) => [...mocks.nodes].find(([, rows]) => rows.some((r) => (r as { id: string }).id === id))?.[0];

vi.mock('../../db/connection.js', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        if ('archivedAt' in fields) {
          // Map query: all maps, or `where(inArray(maps.id, ids))`.
          return Object.assign(Promise.resolve(mocks.maps), {
            where: async (c: Cond) => mocks.maps.filter((m) => c.inArray!.includes(m.id as string)),
          });
        }
        return { where: async (c: Cond) => mocks.nodes.get(c.and![0].eq!) ?? [] };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: async (c: Cond) => {
          mocks.writes.push({ set: s, ids: c.inArray ?? [c.eq!] });
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
      { id: 'm1', name: 'Navy App', statusWorkflow: workflow, archivedAt: null },
      { id: 'm2', name: 'Clean', statusWorkflow: workflow, archivedAt: null },
      { id: 'm3', name: 'Tracer Avatar', statusWorkflow: workflow, archivedAt: null },
      { id: 'm4', name: 'Fulcrum', statusWorkflow: workflow, archivedAt: new Date('2026-09-26') },
    ];
    mocks.nodes = new Map([
      ['m1', [row({ id: 'a', percentComplete: 0 }), row({ id: 'b', percentComplete: 50, blockedReason: 'Fleet worker s: x' })]],
      ['m2', [row({ id: 'c' })]],
      ['m3', [row({ id: 'd', percentComplete: 10 })]],
      ['m4', [row({ id: 'e', percentComplete: 20 })]],
    ]);
    mocks.writes = [];
  });

  it('dry run: lists every map with something to repair, archived ones marked, writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = await repairDoneNodes({ dryRun: true });
    expect(counts).toEqual([
      { mapId: 'm1', mapName: 'Navy App', archived: false, progress: 2, notes: 1 },
      { mapId: 'm3', mapName: 'Tracer Avatar', archived: false, progress: 1, notes: 0 },
      { mapId: 'm4', mapName: 'Fulcrum', archived: true, progress: 1, notes: 0 },
    ]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"Navy App" (m1): would set 2 done leaves to 100 %, would clear 1 worker notes');
    expect(lines[2]).toContain('[archived: --apply refuses it]');
    expect(mocks.writes).toEqual([]);
    log.mockRestore();
  });

  it('apply --map m1 writes only m1', async () => {
    const counts = await repairDoneNodes({ dryRun: false, mapIds: ['m1'] });
    expect(counts).toEqual([{ mapId: 'm1', mapName: 'Navy App', archived: false, progress: 2, notes: 1 }]);
    expect(mocks.writes).toEqual([
      { set: { percentComplete: 100 }, ids: ['a', 'b'] },
      { set: { blockedReason: null, tags: [] }, ids: ['b'] },
    ]);
    expect(mocks.writes.flatMap((w) => w.ids).every((id) => nodeOwner(id) === 'm1')).toBe(true);
  });

  it('apply without --map is refused: there is no all-maps apply', async () => {
    await expect(repairDoneNodes({ dryRun: false })).rejects.toThrow(/--map/);
    await expect(repairDoneNodes({ dryRun: false, mapIds: [] })).rejects.toThrow(/--map/);
    expect(mocks.writes).toEqual([]);
  });

  it('apply refuses an archived map and writes nothing, not even the active maps named with it', async () => {
    await expect(repairDoneNodes({ dryRun: false, mapIds: ['m1', 'm4'] })).rejects.toThrow(/archived.*Fulcrum/);
    expect(mocks.writes).toEqual([]);
  });

  it('an unknown map id is an error', async () => {
    await expect(repairDoneNodes({ dryRun: false, mapIds: ['nope'] })).rejects.toThrow(/no such map nope/);
    expect(mocks.writes).toEqual([]);
  });
});

describe('startup', () => {
  it('the API does not run the done repair on startup', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/doneRepair|repairDoneNodes|runDoneRepairOnce|repair_done_nodes/);
    const mod = await import('../doneRepair.js');
    expect('runDoneRepairOnce' in mod).toBe(false);
  });
});
