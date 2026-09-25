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

import { describe, it, expect } from 'vitest';
import { createNode, type DbHandle } from '../nodes.js';

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
});
