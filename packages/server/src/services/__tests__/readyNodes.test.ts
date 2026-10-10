/**
 * ready_nodes as a developer queue (#323): leaves only, the active sprint
 * by default, priority before rank, and the context to pick (parent path,
 * what waits on it). Real core; the db is a queue of select results in
 * call order: map row, node rows, cycle rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selects: unknown[][] = [];
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => selects.shift() ?? [] }) }) },
}));
vi.mock('../../db/schema.js', () => ({ nodes: {}, maps: {}, cycles: {} }));
vi.mock('../../db/nodes.js', () => ({ notDeleted: {} }));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../db/events.js', () => ({ recordClaimed: vi.fn(), recordReleased: vi.fn() }));

import { readyNodes } from '../orchestration.js';

let seq = 0;
function row(p: Record<string, unknown>) {
  seq += 1;
  return {
    id: `n${seq}`, mapId: 'm1', text: `node ${seq}`, parentId: 'root', childrenOrder: [],
    claimedBySession: null, claimedAt: null, status: null, percentComplete: null, priority: null,
    priorityRank: null, cycleId: null, scopes: [], externalLinks: [], attachments: [], assigneeIds: [],
    dependencies: [], tags: [], customFields: {}, autoProgress: 'off', revision: 1,
    createdAt: new Date(`2026-01-${String(seq).padStart(2, '0')}T00:00:00Z`),
    updatedAt: new Date('2026-01-01T00:00:00Z'), createdBy: 't',
    ...p,
  };
}
const mapRow = { id: 'm1', statusWorkflow: [] };
const root = () => row({ id: 'root', parentId: null, text: 'Root' });

beforeEach(() => {
  selects.length = 0;
  seq = 0;
});

describe('readyNodes — developer queue (#323)', () => {
  it('leaves only, priority before rank, parent path and dependents', async () => {
    const epic = row({ id: 'epic', text: 'Portal', priority: 'P0' });
    const p2ranked = row({ id: 'p2', parentId: 'epic', priority: 'P2', priorityRank: 1 });
    const p0 = row({ id: 'p0', parentId: 'epic', priority: 'P0' });
    const p0ranked = row({ id: 'p0r', parentId: 'epic', priority: 'P0', priorityRank: 5 });
    const waiter = row({ id: 'w', parentId: 'epic', status: 'in_progress', dependencies: [{ targetNodeId: 'p0', type: 'FS', lag: 0 }] });
    selects.push([mapRow], [root(), epic, p2ranked, p0, p0ranked, waiter], []);

    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['p0r', 'p0', 'p2']); // epic is a container; rank only within P0
    expect(r.ready.find((n) => n.id === 'p0')).toMatchObject({ breadcrumb: ['Portal'], dependents: 1 });
    expect(r.sprintScope).toEqual({ mode: 'all', cycles: [] });
  });

  it('defaults to the active sprint — the node or an ancestor carries it', async () => {
    const sprintEpic = row({ id: 'se', cycleId: 'c1' });
    const inSprint = row({ id: 'a', parentId: 'se' });
    const direct = row({ id: 'b', cycleId: 'c1' });
    const outside = row({ id: 'c', cycleId: 'c2' });
    selects.push([mapRow], [root(), sprintEpic, inSprint, direct, outside], [
      { id: 'c1', name: 'Sprint 7', status: 'active' },
      { id: 'c2', name: 'Sprint 8', status: 'planned' },
    ]);
    const r = await readyNodes('m1');
    expect(r.ready.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(r.sprintScope).toEqual({ mode: 'active', cycles: [{ id: 'c1', name: 'Sprint 7' }] });
  });

  it('no active sprint: the whole map, and it says so; an unknown sprint id is an error', async () => {
    selects.push([mapRow], [root(), row({ id: 'x' })], [{ id: 'c2', name: 'S8', status: 'planned' }]);
    const r = await readyNodes('m1');
    expect(r.ready.map((n) => n.id)).toEqual(['x']);
    expect(r.sprintScope?.note).toContain('No active sprint');

    selects.push([mapRow], [root(), row({ id: 'y' })], []);
    await expect(readyNodes('m1', { sprint: 'nope' })).rejects.toThrow(/Sprint nope not found/);
  });
});
