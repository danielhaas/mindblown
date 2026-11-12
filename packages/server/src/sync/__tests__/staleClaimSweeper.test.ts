/**
 * runStaleClaimSweep — the real module (routes/__tests__/orchestration-routes
 * .test.ts only simulates the threshold arithmetic).
 *
 * Pins: a claim older than the map's threshold is cleared, broadcast with
 * source 'stale_claim_sweep', and leaves a `node.released(stale_sweep)`
 * row in the claim trail; a fresh claim is left alone and leaves no row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimedRows: [] as Array<{ node: Record<string, unknown>; staleClaimHours: number }>,
  updated: [] as Record<string, unknown>[],
  broadcastMock: vi.fn(),
  recordReleasedMock: vi.fn(async () => {}),
  lastChange: new Map<string, Date>(),
  rollups: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => mocks.claimedRows,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            mocks.updated.push(values);
            const target = mocks.claimedRows[mocks.updated.length - 1]?.node;
            return target ? [{ ...target, ...values }] : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../ws.js', () => ({ broadcast: mocks.broadcastMock }));
vi.mock('../../db/events.js', () => ({
  recordReleased: mocks.recordReleasedMock,
  lastChangeAtByNode: async () => mocks.lastChange,
}));
vi.mock('../../db/fleet.js', () => ({
  listAllRollups: async () => mocks.rollups,
}));

const HOUR = 60 * 60 * 1000;

function rollupRow(ageMin: number, claims: { nodeId: string }[] = [], workers: unknown[] = []) {
  const at = new Date(Date.now() - ageMin * 60_000).toISOString();
  return {
    host: 'gamora',
    generatedAt: at,
    receivedAt: at,
    mapIds: ['map-1'],
    rollup: { v: 2, host: 'gamora', generated_at: at, workers, claims: claims.map((c) => ({ ...c, phase: 'working' })) },
  };
}

import { runStaleClaimSweep } from '../staleClaimSweeper.js';

function nodeRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'n1',
    mapId: 'map-1',
    parentId: 'root',
    childrenOrder: [],
    text: 'Node',
    tags: [],
    scopes: [],
    dependencies: [],
    externalLinks: [],
    attachments: [],
    assigneeIds: [],
    customFields: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'test',
    revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.claimedRows = [];
  mocks.updated.length = 0;
  mocks.broadcastMock.mockReset();
  mocks.recordReleasedMock.mockClear();
  mocks.lastChange = new Map();
  mocks.rollups = [];
});

describe('runStaleClaimSweep', () => {
  it('clears a stale claim and records node.released(stale_sweep) with the held time', async () => {
    const claimedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mocks.claimedRows = [
      { node: nodeRow({ claimedBySession: 'njoerd:worker-3:default', claimedAt }), staleClaimHours: 4 },
    ];

    const result = await runStaleClaimSweep();

    expect(result).toMatchObject({ inspected: 1, cleared: 1, errors: [] });
    expect(mocks.updated[0]).toMatchObject({ claimedBySession: null, claimedAt: null });
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({ nodeId: 'n1', source: 'stale_claim_sweep' }),
    );
    expect(mocks.recordReleasedMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordReleasedMock).toHaveBeenCalledWith(
      'map-1',
      'n1',
      null,
      expect.objectContaining({
        session: 'njoerd:worker-3:default',
        host: 'njoerd',
        worker: 'worker-3',
        reason: 'stale_sweep',
        note: 'no activity for 4h',
        claimedAt: claimedAt.toISOString(),
        heldMinutes: 300,
      }),
    );
  });

  it('leaves a fresh claim alone — no write, no broadcast, no trail row', async () => {
    mocks.claimedRows = [
      {
        node: nodeRow({ claimedBySession: 'njoerd:worker-3:default', claimedAt: new Date(Date.now() - 60_000) }),
        staleClaimHours: 4,
      },
    ];

    const result = await runStaleClaimSweep();

    expect(result).toMatchObject({ inspected: 1, cleared: 0 });
    expect(mocks.updated).toHaveLength(0);
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
    expect(mocks.recordReleasedMock).not.toHaveBeenCalled();
  });

  const oldClaim = () => [
    {
      node: nodeRow({ claimedBySession: 'gamora:worker-1:default', claimedAt: new Date(Date.now() - 5 * HOUR) }),
      staleClaimHours: 4,
    },
  ];

  it('keeps an old claim whose node changed within the threshold', async () => {
    mocks.claimedRows = oldClaim();
    mocks.lastChange = new Map([['n1', new Date(Date.now() - 1 * HOUR)]]);

    const result = await runStaleClaimSweep();

    expect(result).toMatchObject({ inspected: 1, cleared: 0 });
    expect(mocks.updated).toHaveLength(0);
  });

  it('clears an old claim whose last change is also older than the threshold', async () => {
    mocks.claimedRows = oldClaim();
    mocks.lastChange = new Map([['n1', new Date(Date.now() - 4.5 * HOUR)]]);

    const result = await runStaleClaimSweep();

    expect(result).toMatchObject({ cleared: 1 });
  });

  it('keeps an old, quiet claim that a live host still reports (claims list or worker)', async () => {
    mocks.claimedRows = oldClaim();
    mocks.rollups = [rollupRow(3, [{ nodeId: 'n1' }])];
    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 0 });

    // A worker without the #546 claims list still names its claim.
    mocks.rollups = [rollupRow(3, [], [{ name: 'worker-1', state: 'working', claim: { nodeId: 'n1' } }])];
    expect(await runStaleClaimSweep()).toMatchObject({ cleared: 0 });
    expect(mocks.updated).toHaveLength(0);
  });

  it('clears a quiet claim reported only by a stale host — a host asleep protects nothing', async () => {
    mocks.claimedRows = oldClaim();
    mocks.rollups = [rollupRow(60, [{ nodeId: 'n1' }])];

    const result = await runStaleClaimSweep();

    expect(result).toMatchObject({ cleared: 1 });
    expect(mocks.recordReleasedMock).toHaveBeenCalledWith(
      'map-1',
      'n1',
      null,
      expect.objectContaining({ reason: 'stale_sweep', host: 'gamora' }),
    );
  });
});
