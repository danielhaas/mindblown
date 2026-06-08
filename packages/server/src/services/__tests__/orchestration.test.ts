/**
 * #118 — orchestration service cleanup.
 *
 * Targets the real `services/orchestration.ts` functions (NOT the inline
 * fakes in routes/__tests__/orchestration-routes.test.ts — those don't
 * exercise the service module; that's tracked separately in #117).
 *
 * Coverage:
 *   - Issue 4: claimNode wraps SELECT + UPDATE in a single transaction
 *     so the `warned` flag is observable across concurrent claims.
 *   - Issue 5: releaseNode on an already-unclaimed node returns
 *     `released: false, alreadyReleased: true` without any DB write
 *     or broadcast.
 *
 * Issue 3 (query amplification) is verified separately in
 * db/__tests__/nodes-status-update.test.ts since the cut sits in the
 * nodes DB layer, not the orchestration service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  txSelectMock: vi.fn(),
  txUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  broadcastMock: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (_w: unknown) => mocks.selectMock(),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mocks.updateMock(),
        }),
      }),
    }),
    transaction: (cb: (tx: unknown) => unknown) => {
      mocks.transactionMock();
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: (_lock: string) => mocks.txSelectMock(),
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => mocks.txUpdateMock() }),
          }),
        }),
      };
      return cb(tx);
    },
  },
}));

vi.mock('../../db/schema.js', () => ({
  nodes: { __name: 'nodes' },
  maps: { __name: 'maps' },
}));

vi.mock('../../db/nodes.js', () => ({
  notDeleted: { __sentinel: 'notDeleted' },
}));

vi.mock('../../ws.js', () => ({
  broadcast: mocks.broadcastMock,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ __pred: 'and', args }),
  eq: (...args: unknown[]) => ({ __pred: 'eq', args }),
}));

// Bypass heavy core import — the service only uses a few functions and
// they're not invoked by the paths under test (claim/release don't read
// schedule). For paths that DO use core (readyNodes, conflictScan), we
// don't cover them here.
vi.mock('@mindblown/core', () => ({
  resolvedSiblingOrder: vi.fn(),
  isReady: vi.fn(),
  scopeOverlap: vi.fn(),
}));

import { claimNode, releaseNode } from '../orchestration.js';

function nodeRow(overrides: Partial<{
  id: string;
  mapId: string;
  text: string;
  parentId: string | null;
  childrenOrder: string[];
  claimedBySession: string | null;
  claimedAt: Date | null;
  status: string | null;
  percentComplete: number | null;
  scopes: string[];
  externalLinks: unknown[];
  assigneeIds: string[];
  dependencies: unknown[];
  tags: string[];
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: 'n1',
    mapId: 'm1',
    text: 'Test node',
    parentId: null,
    childrenOrder: [],
    claimedBySession: null,
    claimedAt: null,
    status: null,
    percentComplete: null,
    scopes: [],
    externalLinks: [],
    assigneeIds: [],
    dependencies: [],
    tags: [],
    customFields: {},
    autoProgress: 'off',
    revision: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: 'test',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.selectMock.mockReset();
  mocks.updateMock.mockReset();
  mocks.txSelectMock.mockReset();
  mocks.txUpdateMock.mockReset();
  mocks.transactionMock.mockReset();
  mocks.broadcastMock.mockReset();
});

describe('claimNode (#118 issue 4 — transactional)', () => {
  it('wraps SELECT FOR UPDATE + UPDATE in a single transaction', async () => {
    const before = nodeRow({ claimedBySession: null });
    const after = nodeRow({
      claimedBySession: 'sess-a',
      claimedAt: new Date('2026-06-08T10:00:00Z'),
    });
    mocks.txSelectMock.mockResolvedValue([before]);
    mocks.txUpdateMock.mockResolvedValue([after]);

    const result = await claimNode('m1', 'n1', 'sess-a');

    expect(mocks.transactionMock).toHaveBeenCalledTimes(1);
    expect(mocks.txSelectMock).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdateMock).toHaveBeenCalledTimes(1);
    // Non-tx code paths must NOT be used for the claim's read or write.
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(result.claimed).toBe(true);
    expect(result.warned).toBe(false);
    expect(result.node.claimedBySession).toBe('sess-a');
  });

  it('reports warned=true when the pre-state was claimed by a different session', async () => {
    const before = nodeRow({
      claimedBySession: 'sess-other',
      claimedAt: new Date('2026-06-08T09:00:00Z'),
    });
    const after = nodeRow({
      claimedBySession: 'sess-a',
      claimedAt: new Date('2026-06-08T10:00:00Z'),
    });
    mocks.txSelectMock.mockResolvedValue([before]);
    mocks.txUpdateMock.mockResolvedValue([after]);

    const result = await claimNode('m1', 'n1', 'sess-a');

    expect(result.warned).toBe(true);
    expect(result.warning).toContain('sess-other');
    expect(result.warning).toContain('sess-a');
  });

  it('does NOT warn when re-claimed by the same session', async () => {
    const before = nodeRow({
      claimedBySession: 'sess-a',
      claimedAt: new Date('2026-06-08T09:00:00Z'),
    });
    const after = nodeRow({
      claimedBySession: 'sess-a',
      claimedAt: new Date('2026-06-08T10:00:00Z'),
    });
    mocks.txSelectMock.mockResolvedValue([before]);
    mocks.txUpdateMock.mockResolvedValue([after]);

    const result = await claimNode('m1', 'n1', 'sess-a');

    expect(result.warned).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it('throws OrchestrationNotFoundError when the node does not exist', async () => {
    mocks.txSelectMock.mockResolvedValue([]);

    await expect(claimNode('m1', 'ghost', 'sess-a')).rejects.toThrow(
      /Node ghost not found/,
    );
    // The transaction is entered before the throw; UPDATE must not fire.
    expect(mocks.transactionMock).toHaveBeenCalled();
    expect(mocks.txUpdateMock).not.toHaveBeenCalled();
  });
});

describe('releaseNode (#118 issue 5 — unclaimed = no-op success)', () => {
  it('returns alreadyReleased:true without writing when node is unclaimed', async () => {
    mocks.selectMock.mockResolvedValue([nodeRow({ claimedBySession: null })]);

    const result = await releaseNode('m1', 'n1', 'sess-a');

    expect(result).toMatchObject({
      released: false,
      alreadyReleased: true,
    });
    // Critical: no UPDATE issued, no broadcast emitted.
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.broadcastMock).not.toHaveBeenCalled();
  });

  it('clears the claim and reports released:true when caller owns it', async () => {
    const before = nodeRow({
      claimedBySession: 'sess-a',
      claimedAt: new Date('2026-06-08T09:00:00Z'),
    });
    const after = nodeRow({ claimedBySession: null, claimedAt: null });
    mocks.selectMock.mockResolvedValue([before]);
    mocks.updateMock.mockResolvedValue([after]);

    const result = await releaseNode('m1', 'n1', 'sess-a');

    expect(result.released).toBe(true);
    expect(result.alreadyReleased).toBeUndefined();
    expect(mocks.updateMock).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with ClaimOwnershipError when a different session owns the claim', async () => {
    mocks.selectMock.mockResolvedValue([
      nodeRow({ claimedBySession: 'sess-other', claimedAt: new Date() }),
    ]);

    await expect(releaseNode('m1', 'n1', 'sess-a')).rejects.toThrow(
      /claimed by session "sess-other"/,
    );
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});
