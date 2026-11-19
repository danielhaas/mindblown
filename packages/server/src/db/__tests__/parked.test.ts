/**
 * #655 — the parked flag round-trips through the DB layer: createNode
 * writes it (default false), updateNode passes it through, and
 * dbNodeToCore reads it back (false for rows from before the column).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/trustPolicy.js', () => ({ approvalForNewNode: async () => null }));

import { createNode, updateNode, type DbHandle } from '../nodes.js';
import { dbNodeToCore } from '../helpers.js';

function insertHandle(): { handle: DbHandle; inserted: () => Record<string, unknown> | null } {
  let inserted: Record<string, unknown> | null = null;
  const handle = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return { returning: async () => [{ id: 'n-new', ...v }] };
      },
    }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as unknown as DbHandle;
  return { handle, inserted: () => inserted };
}

describe('parked round trip (#655)', () => {
  it('createNode writes parked and returns it', async () => {
    const { handle, inserted } = insertHandle();
    const node = await createNode({ mapId: 'm1', parentId: 'p1', text: 'Later', createdBy: 'u1', parked: true }, handle);
    expect(inserted()).toMatchObject({ parked: true });
    expect(node.parked).toBe(true);
  });

  it('defaults to false', async () => {
    const { handle, inserted } = insertHandle();
    const node = await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1' }, handle);
    expect(inserted()).toMatchObject({ parked: false });
    expect(node.parked).toBe(false);
  });

  it('updateNode passes parked through, and leaves it alone when absent', async () => {
    let set: Record<string, unknown> = {};
    const row = { mapId: 'm1', statusWorkflow: [], status: null, startedAt: null };
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
          return { where: () => ({ returning: async () => [{ id: 'n1', mapId: 'm1', ...s }] }) };
        },
      }),
    } as unknown as DbHandle;
    const updated = await updateNode('n1', { parked: true }, undefined, handle);
    expect(set.parked).toBe(true);
    expect(updated?.parked).toBe(true);
    await updateNode('n1', { text: 'renamed' }, undefined, handle);
    expect(set).not.toHaveProperty('parked');
  });

  it('dbNodeToCore reads it, false for pre-column rows', () => {
    expect(dbNodeToCore({ id: 'n', parked: true }).parked).toBe(true);
    expect(dbNodeToCore({ id: 'n' }).parked).toBe(false);
  });
});
