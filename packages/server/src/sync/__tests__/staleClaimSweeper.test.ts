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
}));

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
});
