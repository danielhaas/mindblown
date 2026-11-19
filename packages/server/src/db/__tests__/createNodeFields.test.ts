/**
 * createNode forwarded only a subset of its input to the INSERT: `tags`
 * was hardcoded to [] and description / scopes / versionId / cycleId were
 * not read at all, while updateNode accepted every one of them. REST
 * answered 201, the MCP tools reported success, and the caller only found
 * out on the round trip (#389 empty GitHub issue body, #346 versionId).
 *
 * A stub handle captures the values() the function hands to the INSERT.
 * That is the whole claim under test: the field is in the statement.
 */

import { describe, it, expect, vi } from 'vitest';

const { STAMP, approvalForNewNode } = vi.hoisted(() => {
  const STAMP = { state: 'proposed', merge: 'pr-only', by: null, at: '2026-10-28T00:00:00.000Z' } as const;
  return { STAMP, approvalForNewNode: vi.fn(async () => STAMP) };
});
vi.mock('../../services/trustPolicy.js', () => ({ approvalForNewNode }));

import { createNode, estimateSourceUpdate, type DbHandle } from '../nodes.js';

function stubHandle(): { handle: DbHandle; inserted: () => Record<string, unknown> | null } {
  let inserted: Record<string, unknown> | null = null;
  const handle = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return { returning: async () => [{ id: 'n-new', ...v }] };
      },
    }),
    // Parent lookup — no parent row, so the children_order update is skipped.
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as unknown as DbHandle;
  return { handle, inserted: () => inserted };
}

describe('createNode forwards every data field to the INSERT (#389)', () => {
  it('writes description, tags, scopes, versionId and cycleId', async () => {
    const { handle, inserted } = stubHandle();
    await createNode(
      {
        mapId: 'm1',
        parentId: 'p1',
        text: 'ticket',
        createdBy: 'u1',
        description: '## Why\n\nbecause',
        tags: ['probe'],
        scopes: ['apps/x'],
        versionId: 'v1',
        cycleId: 'c1',
      },
      handle,
    );
    expect(inserted()).toMatchObject({
      text: 'ticket',
      description: '## Why\n\nbecause',
      tags: ['probe'],
      scopes: ['apps/x'],
      versionId: 'v1',
      cycleId: 'c1',
    });
  });

  it('defaults them when omitted (unchanged behaviour for existing callers)', async () => {
    const { handle, inserted } = stubHandle();
    await createNode({ mapId: 'm1', parentId: 'p1', text: 'bare', createdBy: 'u1' }, handle);
    expect(inserted()).toMatchObject({
      description: null,
      tags: [],
      scopes: [],
      versionId: null,
      cycleId: null,
    });
  });

  it('stamps the approval from the reporter against the map (#492)', async () => {
    const { handle, inserted } = stubHandle();
    const reportedBy = { kind: 'user', userId: 'fleet-user' } as const;
    await createNode({ mapId: 'm1', parentId: 'p1', text: 'follow-up', createdBy: 'u1', reportedBy }, handle);
    expect(approvalForNewNode).toHaveBeenLastCalledWith('m1', reportedBy, expect.any(Date));
    expect(inserted()).toMatchObject({ approval: STAMP });
  });
});

describe('estimate drafts (#318): the source marker', () => {
  it('create keeps an AI marker only alongside an estimate', async () => {
    const a = stubHandle();
    await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1', effortEstimate: 2, estimateSource: 'ai' }, a.handle);
    expect(a.inserted()).toMatchObject({ effortEstimate: 2, estimateSource: 'ai' });
    const b = stubHandle();
    await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1', estimateSource: 'ai' }, b.handle);
    expect(b.inserted()).toMatchObject({ effortEstimate: null, estimateSource: null });
    const c = stubHandle();
    await createNode({ mapId: 'm1', parentId: 'p1', text: 't', createdBy: 'u1', effortEstimate: 3 }, c.handle);
    expect(c.inserted()).toMatchObject({ estimateSource: null });
  });

  it('update: writing an estimate without a source makes it a person\'s; explicit values win; untouched otherwise', () => {
    expect(estimateSourceUpdate({ effortEstimate: 4 })).toBeNull();
    expect(estimateSourceUpdate({ effortEstimate: null })).toBeNull();
    expect(estimateSourceUpdate({ effortEstimate: 4, estimateSource: 'ai' })).toBe('ai');
    expect(estimateSourceUpdate({ estimateSource: null })).toBeNull(); // "Accept" keeps the number
    expect(estimateSourceUpdate({})).toBeUndefined();
  });
});
