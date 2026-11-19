/**
 * A leaf set to done is 100 %, and done ends the fleet worker's own wait
 * note. Every write path lands in updateNode / createNode: set_status, PUT
 * and the Kanban drag (status only), update_node and PATCH /nodes/bulk (any
 * fields), plan_fix mark-done/reopen, and the forge sync closing an issue
 * (status done + 100) — so these are pinned here.
 *
 * A stub handle answers every select with one row and captures what the
 * write hands to the database.
 */

import { describe, it, expect, vi } from 'vitest';
import type { StatusDef } from '@mindblown/core';

vi.mock('../../services/trustPolicy.js', () => ({ approvalForNewNode: async () => null }));
import {
  createNode,
  updateNode,
  DoneProgressConflictError,
  type CreateNodeInput,
  type DbHandle,
  type UpdateNodeInput,
} from '../nodes.js';

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#94a3b8', position: 0 },
  { id: 'wip', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'blocked', name: 'Blocked', category: 'blocked' as StatusDef['category'], color: '#ef4444', position: 2 },
  { id: 'shipped', name: 'Shipped', category: 'done', color: '#10b981', position: 3 },
];

const WORKER_NOTE = 'Fleet worker 3f2a-9c: PR #1 was closed without merging';

interface Current {
  status?: string | null;
  percentComplete?: number | null;
  childrenOrder?: string[];
  blockedReason?: string | null;
  tags?: string[];
}

function stub(current: Current): { handle: DbHandle; written: () => Record<string, unknown>; inserted: () => Record<string, unknown> } {
  let written: Record<string, unknown> = {};
  let inserted: Record<string, unknown> = {};
  const row = {
    mapId: 'm1',
    statusWorkflow: workflow,
    startedAt: null,
    completedAt: null,
    status: 'wip',
    percentComplete: 40,
    childrenOrder: [],
    blockedReason: null,
    tags: [],
    ...current,
  };
  const handle = {
    select: () => ({
      from: () => ({
        where: async () => [row],
        innerJoin: () => ({ where: async () => [row] }),
      }),
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        written = s;
        return { where: () => ({ returning: async () => [{ id: 'n1', mapId: 'm1' }] }) };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return { returning: async () => [{ id: 'n1', mapId: 'm1', ...v }] };
      },
    }),
  } as unknown as DbHandle;
  return { handle, written: () => written, inserted: () => inserted };
}

async function update(input: UpdateNodeInput, current: Current = {}): Promise<Record<string, unknown>> {
  const s = stub(current);
  await updateNode('n1', input, undefined, s.handle);
  return s.written();
}

async function create(input: Partial<CreateNodeInput>): Promise<Record<string, unknown>> {
  const s = stub({});
  await createNode({ mapId: 'm1', parentId: 'p1', text: 'x', createdBy: 'u1', ...input }, s.handle);
  return s.inserted();
}

describe('done leaf is 100 %', () => {
  it('set_status / Kanban drag: a status in the done category sets 100 on a leaf', async () => {
    const set = await update({ status: 'shipped' }, { percentComplete: 40 });
    expect(set.status).toBe('shipped');
    expect(set.percentComplete).toBe(100);
    expect(set.completedAt).toBeInstanceOf(Date);
  });

  it('matches the done status by name as well as id', async () => {
    expect((await update({ status: 'Shipped' })).percentComplete).toBe(100);
  });

  it('update_node / bulk update: done with an explicit 100 goes through', async () => {
    expect((await update({ status: 'shipped', percentComplete: 100 })).percentComplete).toBe(100);
  });

  it('done with an explicit percentComplete below 100 is refused', async () => {
    await expect(update({ status: 'shipped', percentComplete: 50 })).rejects.toBeInstanceOf(DoneProgressConflictError);
    await expect(update({ status: 'shipped', percentComplete: 50 })).rejects.toThrow(/100/);
  });

  it('a parent is left to compute from its children', async () => {
    const set = await update({ status: 'shipped' }, { childrenOrder: ['c1'], percentComplete: 40 });
    expect(set.status).toBe('shipped');
    expect(set).not.toHaveProperty('percentComplete');
  });

  it('reopen (out of done) leaves progress alone', async () => {
    const set = await update({ status: 'todo' }, { status: 'shipped', percentComplete: 100 });
    expect(set.status).toBe('todo');
    expect(set).not.toHaveProperty('percentComplete');
  });

  it('plan_fix reopen keeps its own 0 %', async () => {
    const set = await update({ status: 'todo', percentComplete: 0, completedAt: null }, { status: 'shipped', percentComplete: 100 });
    expect(set.percentComplete).toBe(0);
  });

  it('a non-done status leaves progress alone', async () => {
    expect(await update({ status: 'wip' }, { status: 'todo', percentComplete: 0 })).not.toHaveProperty('percentComplete');
  });

  it('create_node / bulk_create: created done is 100', async () => {
    expect((await create({ status: 'shipped' })).percentComplete).toBe(100);
    expect((await create({ status: 'shipped', percentComplete: 100 })).percentComplete).toBe(100);
  });

  it('create_node: done with percentComplete below 100 is refused', async () => {
    await expect(create({ status: 'shipped', percentComplete: 0 })).rejects.toBeInstanceOf(DoneProgressConflictError);
  });

  it('create_node: other statuses keep the given progress', async () => {
    expect((await create({ status: 'wip', percentComplete: 30 })).percentComplete).toBe(30);
    expect((await create({ status: 'todo' })).percentComplete).toBeNull();
  });
});

describe("done ends the fleet worker's own blocker", () => {
  it('set_status done clears the worker note and its blocked tag', async () => {
    const set = await update({ status: 'shipped' }, { blockedReason: WORKER_NOTE, tags: ['bug', 'blocked'] });
    expect(set.blockedReason).toBeNull();
    expect(set.tags).toEqual(['bug']);
  });

  it('forge sync close (status done + 100) clears it too', async () => {
    const set = await update({ status: 'shipped', percentComplete: 100, externalLinks: [] }, { blockedReason: `  ${WORKER_NOTE}` });
    expect(set.blockedReason).toBeNull();
  });

  it('progress 100 (status derives to done) clears it', async () => {
    const set = await update({ percentComplete: 100 }, { blockedReason: WORKER_NOTE, tags: ['blocked'] });
    expect(set.status).toBe('shipped');
    expect(set.blockedReason).toBeNull();
    expect(set.tags).toEqual([]);
  });

  it('a tag write in the same call loses only the blocked tag', async () => {
    const set = await update({ status: 'shipped', tagsAppend: ['shipped-v1'] }, { blockedReason: WORKER_NOTE, tags: ['blocked'] });
    expect(set.tags).toEqual(['shipped-v1']);
  });

  it("a person's blocker stays", async () => {
    const set = await update({ status: 'shipped' }, { blockedReason: 'waiting on Dan for the copy', tags: ['blocked'] });
    expect(set).not.toHaveProperty('blockedReason');
    expect(set).not.toHaveProperty('tags');
  });

  it('a blocker written in the same call wins', async () => {
    const set = await update({ status: 'shipped', blockedReason: 'kept on purpose' }, { blockedReason: WORKER_NOTE });
    expect(set.blockedReason).toBe('kept on purpose');
  });

  it('a non-done write leaves the worker note', async () => {
    const set = await update({ status: 'wip' }, { blockedReason: WORKER_NOTE, tags: ['blocked'] });
    expect(set).not.toHaveProperty('blockedReason');
  });

  it('progress 100 on a custom-status (blocked) node is not done and keeps the note', async () => {
    const set = await update({ percentComplete: 100 }, { status: 'blocked', blockedReason: WORKER_NOTE });
    expect(set).not.toHaveProperty('blockedReason');
  });
});
