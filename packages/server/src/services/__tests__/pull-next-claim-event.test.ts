/**
 * getNextTicket writes the claim trail: a grant records `node.claimed`
 * with via 'pull' after the transaction commits, next to the broadcast.
 *
 * The decision core is pinned in pull-queue.test.ts; this file drives the
 * transactional shell with a minimal fake tx (advisory lock → map row →
 * node rows → conditional UPDATE) over the REAL @mindblown/core and the
 * real schema objects, so the winner is chosen by production logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
  recordClaimedMock: vi.fn(async () => {}),
  recordReleasedMock: vi.fn(async () => {}),
  // Rows the fake tx serves; set per test.
  mapRow: null as Record<string, unknown> | null,
  nodeRows: [] as Record<string, unknown>[],
  // Whether the conditional claim UPDATE "wins" (an unclaimed row existed).
  claimWins: true,
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock('../../db/connection.js', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema.js')>('../../db/schema.js');
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === schema.maps ? (mocks.mapRow ? [mocks.mapRow] : []) : mocks.nodeRows),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            mocks.updates.push({ table, values });
            if (table !== schema.nodes) return [];
            if (!mocks.claimWins) return [];
            const target = mocks.nodeRows.find((r) => r.status === 'todo' && r.parentId !== null);
            return target ? [{ ...target, ...values }] : [];
          },
        }),
      }),
    }),
  };
  return { db: { transaction: async (cb: (t: unknown) => unknown) => cb(tx) } };
});
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcastMock }));
vi.mock('../../db/events.js', () => ({
  recordClaimed: mocks.recordClaimedMock,
  recordReleased: mocks.recordReleasedMock,
}));

import { getNextTicket } from '../orchestration.js';

const WORKFLOW = [
  { id: 'todo', name: 'Todo', category: 'todo', color: '#9ca3af', position: 0 },
  { id: 'in_progress', name: 'In Progress', category: 'in_progress', color: '#3b82f6', position: 1 },
  { id: 'done', name: 'Done', category: 'done', color: '#22c55e', position: 2 },
];

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'n',
    mapId: 'map-1',
    parentId: 'root',
    childrenOrder: [],
    text: 'Node',
    description: 'A brief',
    status: 'todo',
    tags: [],
    scopes: [],
    dependencies: [],
    externalLinks: [],
    attachments: [],
    assigneeIds: [],
    customFields: {},
    claimedBySession: null,
    claimedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'test',
    revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.broadcastMock.mockReset();
  mocks.recordClaimedMock.mockClear();
  mocks.recordReleasedMock.mockClear();
  mocks.updates.length = 0;
  mocks.claimWins = true;
  mocks.mapRow = {
    id: 'map-1',
    statusWorkflow: WORKFLOW,
    maxActiveClaims: 5,
    dispatchGate: [],
    dispatchPolicy: [],
    profilePolicy: null,
    effortUnit: 'days',
    hoursPerDay: 8,
    dispatchMixAcc: 0,
  };
  mocks.nodeRows = [
    row({ id: 'root', parentId: null, childrenOrder: ['leaf'], status: null, description: null }),
    row({ id: 'leaf', text: 'Ship it' }),
  ];
});

describe('getNextTicket — claim trail', () => {
  it('a grant records node.claimed via "pull" for the winner, after the broadcast', async () => {
    const result = await getNextTicket('map-1', 'njoerd:worker-3:default', 'default');

    expect(result.granted).toBe(true);
    expect(result.ticket?.id).toBe('leaf');
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({ type: 'node:updated', nodeId: 'leaf' }),
    );
    expect(mocks.recordClaimedMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordClaimedMock).toHaveBeenCalledWith('map-1', 'leaf', null, {
      session: 'njoerd:worker-3:default',
      host: 'njoerd',
      worker: 'worker-3',
      profile: 'default',
      via: 'pull',
      previousSession: null,
    });
    expect(mocks.recordReleasedMock).not.toHaveBeenCalled();
  });

  it('a refusal records nothing', async () => {
    mocks.mapRow = { ...mocks.mapRow!, maxActiveClaims: 0 };
    const result = await getNextTicket('map-1', 'njoerd:worker-3:default');
    expect(result.granted).toBe(false);
    expect(mocks.recordClaimedMock).not.toHaveBeenCalled();
  });

  it('a candidate claimed out from under the pull records nothing', async () => {
    mocks.claimWins = false;
    const result = await getNextTicket('map-1', 'njoerd:worker-3:default');
    expect(result.granted).toBe(false);
    expect(mocks.recordClaimedMock).not.toHaveBeenCalled();
  });
});
