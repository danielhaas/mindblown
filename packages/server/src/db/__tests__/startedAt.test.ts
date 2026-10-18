/**
 * updateNode stamps nodes.started_at the first time work starts (status
 * into an 'in_progress' category, or progress above 0), keeps it through
 * later ticks and done, and clears it when the node goes back to todo.
 * Kanban shows it on In-Progress cards.
 *
 * A stub handle answers every select with one row and captures the set()
 * handed to the UPDATE — that set is the claim under test.
 */

import { describe, it, expect } from 'vitest';
import type { StatusDef } from '@mindblown/core';
import { createNode, updateNode, type CreateNodeInput, type DbHandle, type UpdateNodeInput } from '../nodes.js';

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#94a3b8', position: 0 },
  { id: 'wip', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#10b981', position: 2 },
];

async function setFor(
  input: UpdateNodeInput,
  current: { status: string | null; startedAt: Date | null },
): Promise<Record<string, unknown>> {
  let set: Record<string, unknown> = {};
  const row = { mapId: 'm1', statusWorkflow: workflow, ...current };
  const handle = {
    select: () => ({
      from: () => ({
        where: async () => [row],
        innerJoin: () => ({ where: async () => [row] }),
      }),
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        set = s;
        return { where: () => ({ returning: async () => [{ id: 'n1', mapId: 'm1' }] }) };
      },
    }),
  } as unknown as DbHandle;
  await updateNode('n1', input, undefined, handle);
  return set;
}

describe('updateNode startedAt', () => {
  it('stamps on the move into an in_progress status', async () => {
    const set = await setFor({ status: 'wip' }, { status: 'todo', startedAt: null });
    expect(set.startedAt).toBeInstanceOf(Date);
  });

  it('stamps when progress goes above 0 (status auto-derives to in_progress)', async () => {
    const set = await setFor({ percentComplete: 20 }, { status: 'todo', startedAt: null });
    expect(set.status).toBe('wip');
    expect(set.startedAt).toBeInstanceOf(Date);
  });

  it('keeps the first start on later progress ticks and on done', async () => {
    const started = new Date('2026-10-01T08:00:00Z');
    expect(await setFor({ percentComplete: 60 }, { status: 'wip', startedAt: started })).not.toHaveProperty('startedAt');
    expect(await setFor({ status: 'done' }, { status: 'wip', startedAt: started })).not.toHaveProperty('startedAt');
  });

  it('clears when the node goes back to todo, by status or by progress 0', async () => {
    const started = new Date('2026-10-01T08:00:00Z');
    expect((await setFor({ status: 'todo' }, { status: 'wip', startedAt: started })).startedAt).toBeNull();
    expect((await setFor({ percentComplete: 0 }, { status: 'wip', startedAt: started })).startedAt).toBeNull();
  });

  it('progress 0 clears even when the status is already todo (no status change)', async () => {
    const started = new Date('2026-10-01T08:00:00Z');
    expect((await setFor({ percentComplete: 0 }, { status: 'todo', startedAt: started })).startedAt).toBeNull();
  });

  it('leaves it alone when neither status nor progress moves', async () => {
    expect(await setFor({ text: 'renamed' }, { status: 'wip', startedAt: null })).not.toHaveProperty('startedAt');
  });
});

describe('createNode startedAt', () => {
  async function insertedFor(input: Partial<CreateNodeInput>): Promise<Record<string, unknown>> {
    let inserted: Record<string, unknown> = {};
    const handle = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted = v;
          return { returning: async () => [{ id: 'n-new', ...v }] };
        },
      }),
      // Map workflow lookup answers the workflow; no parent row.
      select: (cols?: Record<string, unknown>) => ({
        from: () => ({ where: async () => (cols && 'statusWorkflow' in cols ? [{ statusWorkflow: workflow }] : []) }),
      }),
    } as unknown as DbHandle;
    await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1', ...input }, handle);
    return inserted;
  }

  it('a node created in flight starts now; a todo or done one does not', async () => {
    expect((await insertedFor({ status: 'In Progress' })).startedAt).toBeInstanceOf(Date);
    expect((await insertedFor({ percentComplete: 30 })).startedAt).toBeInstanceOf(Date);
    expect((await insertedFor({ status: 'todo' })).startedAt).toBeNull();
    expect((await insertedFor({ status: 'done', percentComplete: 100 })).startedAt).toBeNull();
    expect((await insertedFor({})).startedAt).toBeNull();
  });
});
