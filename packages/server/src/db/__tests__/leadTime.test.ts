/**
 * Lead time (#654): createNode inserts leadTime / requestedAt / waitingOn,
 * updateNode writes them (null clears), and dbNodeToCore reads them back —
 * null for rows from before the columns.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/trustPolicy.js', () => ({ approvalForNewNode: async () => null }));

import { createNode, updateNode, type DbHandle } from '../nodes.js';
import { dbNodeToCore } from '../helpers.js';

const fields = { leadTime: 5, requestedAt: '2026-11-12', waitingOn: 'LOKE engineering' };

describe('lead-time round trip (#654)', () => {
  it('createNode inserts the fields and returns them', async () => {
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
    const node = await createNode({ mapId: 'm1', parentId: 'p1', text: '[External] VM', createdBy: 'u1', ...fields }, handle);
    expect(inserted).toMatchObject(fields);
    expect(node).toMatchObject(fields);
  });

  it('updateNode writes them, and null clears them', async () => {
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
    await updateNode('n1', fields, undefined, handle);
    expect(set).toMatchObject(fields);
    await updateNode('n1', { leadTime: null, requestedAt: null, waitingOn: null }, undefined, handle);
    expect(set).toMatchObject({ leadTime: null, requestedAt: null, waitingOn: null });
  });

  it('dbNodeToCore reads snake_case rows and pre-column rows', () => {
    expect(dbNodeToCore({ id: 'n', lead_time: 3, requested_at: '2026-11-01', waiting_on: 'Legal' })).toMatchObject({
      leadTime: 3,
      requestedAt: '2026-11-01',
      waitingOn: 'Legal',
    });
    expect(dbNodeToCore({ id: 'n' })).toMatchObject({ leadTime: null, requestedAt: null, waitingOn: null });
  });
});
