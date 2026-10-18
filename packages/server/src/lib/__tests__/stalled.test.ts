/**
 * stalledForMap: the change-log read is asked for candidates only, an
 * archived map has nothing stalled (on hold by design), and a failed read
 * never fails the map load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Node, StatusDef } from '@mindblown/core';

const loadStalledActivity = vi.fn();
// A read failure is thrown outside the spy: vitest fails a test whose
// vi.fn implementation threw, even when the caller caught it.
let failRead = false;
vi.mock('../../db/events.js', () => ({
  loadStalledActivity: async (...a: unknown[]) => {
    if (failRead) throw new Error('db down');
    return loadStalledActivity(...a);
  },
}));

import { stalledForMap } from '../stalled.js';

const workflow: StatusDef[] = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '', position: 0 },
  { id: 'wip', name: 'In Progress', category: 'in_progress', color: '', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '', position: 2 },
];
const now = new Date('2026-10-18T12:00:00Z');
const node = (id: string, over: Partial<Node> = {}) =>
  ({
    id,
    childrenIds: [],
    status: 'wip',
    percentComplete: 25,
    claimedBySession: null,
    blockedReason: null,
    tags: [],
    updatedAt: '2026-10-18T11:00:00Z',
    ...over,
  }) as Node;
const map = { id: 'm1', statusWorkflow: workflow, archivedAt: null };

beforeEach(() => loadStalledActivity.mockReset());

describe('stalledForMap', () => {
  it('reads the change log for candidates only and applies the threshold', async () => {
    loadStalledActivity.mockResolvedValue({
      lastChangeAt: new Map([['dead', '2026-10-18T03:00:00Z']]),
      lastRelease: new Map([['dead', { session: 'w-3', releasedAt: '2026-10-18T03:00:00Z', reason: 'release' }]]),
    });
    const out = await stalledForMap(
      map,
      [node('dead'), node('claimed', { claimedBySession: 'w-1' }), node('todo', { status: 'todo', percentComplete: 0 })],
      now,
    );
    expect(loadStalledActivity).toHaveBeenCalledWith('m1', ['dead']);
    expect(out.map((s) => s.nodeId)).toEqual(['dead']);
    expect(out[0].lastRelease?.session).toBe('w-3');
  });

  it('nothing on an archived map, and no query when there are no candidates', async () => {
    expect(await stalledForMap({ ...map, archivedAt: '2026-10-01T00:00:00Z' }, [node('dead')], now)).toEqual([]);
    expect(await stalledForMap(map, [node('c', { claimedBySession: 'w-1' })], now)).toEqual([]);
    expect(loadStalledActivity).not.toHaveBeenCalled();
  });

  it('a failed change-log read yields an empty list, not an error', async () => {
    failRead = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await stalledForMap(map, [node('dead')], now)).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    failRead = false;
  });
});
