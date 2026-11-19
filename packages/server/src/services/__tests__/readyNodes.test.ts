/**
 * ready_nodes as a developer queue (#323): leaves only, the active sprint
 * by default, priority before rank, and the context to pick (parent path,
 * what waits on it). Real core; the db is a queue of select results in
 * call order: map row, node rows, version rows (only when the gate names
 * a version), cycle rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selects: unknown[][] = [];
vi.mock('../../db/connection.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => selects.shift() ?? [] }) }) },
}));
vi.mock('../../db/schema.js', () => ({ nodes: {}, maps: {}, cycles: {}, versions: {} }));
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
    approval: { state: 'approved', merge: 'auto', by: null, at: '2026-10-28T00:00:00.000Z' },
    description: 'A brief the worker can act on.',
    ...p,
  };
}
const mapRow = { id: 'm1', statusWorkflow: [] };
const root = () => row({ id: 'root', parentId: null, text: 'Root' });

beforeEach(() => {
  selects.length = 0;
  seq = 0;
});

describe('readyNodes — approval gate (#492)', () => {
  it('lists unapproved ready leaves apart, with the parent that holds them; they are not ready', async () => {
    const proposed = { state: 'proposed', merge: 'pr-only', by: null, at: '2026-10-28T00:00:00.000Z' };
    const epic = row({ id: 'epic', text: 'Follow-ups', approval: proposed });
    selects.push(
      [mapRow],
      [
        row({ id: 'root', parentId: null, text: 'Root', approval: null }),
        row({ id: 'ok' }),
        row({ id: 'prop', text: 'From a stranger', approval: proposed }),
        row({ id: 'none', text: 'No stamp', approval: null }),
        epic,
        row({ id: 'sub', parentId: 'epic', text: 'Sub' }),
      ],
      [],
    );
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['ok']);
    expect(r.total).toBe(1);
    expect(r.awaitingApproval).toEqual([
      { id: 'prop', text: 'From a stranger', approval: 'proposed', heldBy: null },
      { id: 'none', text: 'No stamp', approval: 'proposed', heldBy: null },
      { id: 'sub', text: 'Sub', approval: 'proposed', heldBy: { id: 'epic', text: 'Follow-ups' } },
    ]);
  });
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

  it('leaves out tickets held for a person: skip tag or manual blocker', async () => {
    selects.push([mapRow], [
      root(),
      row({ id: 'ok' }),
      row({ id: 'tagged', tags: ['needs-human'] }),
      row({ id: 'flagged', blockedReason: 'Waiting on Dan' }),
    ], []);
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['ok']);
  });

  it('a held open parent holds its leaves; a done parent does not', async () => {
    selects.push([{ id: 'm1', statusWorkflow: [{ id: 'done', name: 'Done', category: 'done' }] }], [
      root(),
      row({ id: 'epic', blockedReason: 'Waiting on Dan' }),
      row({ id: 'kid', parentId: 'epic' }),
      row({ id: 'old', status: 'done', tags: ['needs-human'] }),
      row({ id: 'late', parentId: 'old' }),
    ], []);
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['late']);
  });
});

describe('readyNodes — the pull queue\'s own fences: gate and brief (19.11.2026)', () => {
  it('a briefless leaf and a leaf outside the gate are listed apart with the reason; a briefed leaf inside the gate is ready', async () => {
    selects.push(
      [{ id: 'm1', statusWorkflow: [], dispatchGate: ['version:v1'] }],
      [
        root(),
        row({ id: 'go', versionId: 'v1', text: 'Avatar picker' }),
        row({ id: 'bare', versionId: 'v1', text: 'Avatar crop', description: null }),
        row({ id: 'later', versionId: 'v2', text: 'Avatar frames' }),
        row({ id: 'loose', text: 'Avatar upload', description: null }),
        row({ id: 'linked', versionId: 'v1', text: 'Avatar cache', description: null, externalLinks: [{ provider: 'github', externalId: 'o/r#7', url: '', syncEnabled: true, lastSyncedAt: null }] }),
      ],
      [{ id: 'v1', name: 'V1' }, { id: 'v2', name: 'V2' }],
    );
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id).sort()).toEqual(['go', 'linked']);
    expect(r.total).toBe(2);
    expect(r.needsBrief).toEqual([
      { id: 'bare', text: 'Avatar crop', reason: 'no description, no linked issue, title under 10 words' },
    ]);
    expect(r.outsideGate).toEqual([
      { id: 'later', text: 'Avatar frames', missedGate: ['version:v1'], reason: 'gate wants version "V1" — this leaf has version "V2"' },
      { id: 'loose', text: 'Avatar upload', missedGate: ['version:v1'], reason: 'gate wants version "V1" — this leaf has no version; it has no brief either' },
    ]);
  });

  it('milestone:current (#675): a later milestone\'s leaf waits outside the gate while the current one has work', async () => {
    selects.push(
      [{ id: 'm1', statusWorkflow: [], dispatchGate: ['milestone:current'] }],
      [
        row({ id: 'root', parentId: null, text: 'Root', childrenOrder: ['ms1', 'ms2'] }),
        row({ id: 'ms1', text: 'M1 test VM' }),
        row({ id: 'ms2', text: 'M2 pilot' }),
        row({ id: 'a', parentId: 'ms1', text: 'Set up VM' }),
        row({ id: 'b', parentId: 'ms2', text: 'Pilot rollout' }),
      ],
      [],
    );
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['a']);
    expect(r.outsideGate).toEqual([
      { id: 'b', text: 'Pilot rollout', missedGate: ['milestone:current'], reason: 'gate wants the current milestone "M1 test VM" — this leaf is in "M2 pilot"' },
    ]);
  });

  it('no gate: nothing is outside it; a long title is a brief', async () => {
    selects.push([mapRow], [
      root(),
      row({ id: 'short', description: null, text: 'Fix it' }),
      row({ id: 'long', description: null, text: 'Make the avatar upload accept PNG files up to five megabytes' }),
    ]);
    const r = await readyNodes('m1', { sprint: 'all' });
    expect(r.ready.map((n) => n.id)).toEqual(['long']);
    expect(r.needsBrief?.map((n) => n.id)).toEqual(['short']);
    expect(r.outsideGate).toEqual([]);
  });
});
