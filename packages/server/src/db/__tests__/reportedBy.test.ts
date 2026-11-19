/**
 * reportedBy (#490): createNode writes it into the INSERT, updateNode
 * never touches it, and dbNodeToCore reads it back — null for rows
 * created before the column.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/trustPolicy.js', () => ({ approvalForNewNode: async () => null }));

import { createNode, updateNode, type DbHandle, type UpdateNodeInput } from '../nodes.js';
import { dbNodeToCore } from '../helpers.js';

function stubHandle(): { handle: DbHandle; inserted: () => Record<string, unknown> | null } {
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

describe('reportedBy round trip (#490)', () => {
  it('createNode writes the reporter and returns it', async () => {
    const { handle, inserted } = stubHandle();
    const reporter = { kind: 'forge', provider: 'github', login: 'octocat' } as const;
    const node = await createNode(
      { mapId: 'm1', parentId: 'p1', text: '#1 bug', createdBy: 'owner', reportedBy: reporter },
      handle,
    );
    expect(inserted()).toMatchObject({ reportedBy: reporter });
    expect(node.reportedBy).toEqual(reporter);
  });

  it('defaults to null when no reporter is given', async () => {
    const { handle, inserted } = stubHandle();
    const node = await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1' }, handle);
    expect(inserted()).toMatchObject({ reportedBy: null });
    expect(node.reportedBy).toBeNull();
  });

  it('updateNode never writes it, even when a caller smuggles it in', async () => {
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
          return { where: () => ({ returning: async () => [{ id: 'n1', mapId: 'm1' }] }) };
        },
      }),
    } as unknown as DbHandle;
    // The PUT route forwards its body as-is; this is the layer that drops it.
    const smuggled = { text: 'renamed', reportedBy: { kind: 'user', userId: 'someone-else' } };
    await updateNode('n1', smuggled as UpdateNodeInput, undefined, handle);
    expect(set.text).toBe('renamed');
    expect(set).not.toHaveProperty('reportedBy');
  });

  it('dbNodeToCore reads snake_case rows and pre-column rows', () => {
    expect(dbNodeToCore({ id: 'n', reported_by: { kind: 'user', userId: 'u1' } }).reportedBy)
      .toEqual({ kind: 'user', userId: 'u1' });
    expect(dbNodeToCore({ id: 'n' }).reportedBy).toBeNull();
  });
});
