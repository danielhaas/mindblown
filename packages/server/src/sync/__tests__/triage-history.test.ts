/**
 * Tests for the Phase 3 (#96) triage history recorder.
 *
 * Covers:
 *   - Every mutation through `recordTriageHistory` writes a row with the
 *     expected before/after snapshot fields.
 *   - A multi-mutation sequence (created → overridden → reclassified)
 *     produces ordered history rows that round-trip the decision
 *     trajectory.
 *   - Write failures inside the recorder are swallowed (the caller
 *     mustn't see a thrown error from history bookkeeping).
 *
 * The DELETE-cascades-to-history invariant lives at the SQL layer — it's
 * enforced by the FK constraint in `db/schema.ts` (ON DELETE CASCADE).
 * We don't reach for a real Postgres instance here; the cascade test
 * lives in the migrate-level integration suite (the schema itself
 * declares the constraint, and the migration SQL mirrors it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared insert recorder ───────────────────────────────────────

interface HistoryRow {
  decisionId: string;
  changedBy: string;
  changeType: string;
  previousDecision: string | null;
  newDecision: string;
  previousConfidence: number | null;
  newConfidence: number | null;
  previousParentNodeId: string | null;
  newParentNodeId: string | null;
  reason: string | null;
  insertedAt: number; // ordering helper for assertions
}

const insertedHistory: HistoryRow[] = [];
let shouldFailInsert = false;

vi.mock('../../db/connection.js', () => {
  const db = {
    insert: (table: { __name?: string }) => ({
      values: async (vals: Record<string, unknown>) => {
        if (shouldFailInsert) {
          throw new Error('simulated db failure');
        }
        if (table?.__name === 'triageDecisionHistory') {
          insertedHistory.push({
            decisionId: vals.decisionId as string,
            changedBy: vals.changedBy as string,
            changeType: vals.changeType as string,
            previousDecision: (vals.previousDecision as string | null) ?? null,
            newDecision: vals.newDecision as string,
            previousConfidence: (vals.previousConfidence as number | null) ?? null,
            newConfidence: (vals.newConfidence as number | null) ?? null,
            previousParentNodeId:
              (vals.previousParentNodeId as string | null) ?? null,
            newParentNodeId: (vals.newParentNodeId as string | null) ?? null,
            reason: (vals.reason as string | null) ?? null,
            insertedAt: insertedHistory.length,
          });
        }
      },
    }),
  };
  return { db };
});

vi.mock('../../db/schema.js', () => ({
  triageDecisionHistory: { __name: 'triageDecisionHistory' },
}));

import { recordTriageHistory } from '../triageHistory.js';

beforeEach(() => {
  insertedHistory.length = 0;
  shouldFailInsert = false;
});

// ── recordTriageHistory ──────────────────────────────────────────

describe('recordTriageHistory — single mutation', () => {
  it("writes a 'created' row with previous=null", async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'created',
      previousDecision: null,
      newDecision: 'place',
      previousConfidence: null,
      newConfidence: 88,
      previousParentNodeId: null,
      newParentNodeId: 'epic-1',
      reason: 'matches Frontend',
    });
    expect(insertedHistory).toHaveLength(1);
    expect(insertedHistory[0]).toMatchObject({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'created',
      previousDecision: null,
      newDecision: 'place',
      previousConfidence: null,
      newConfidence: 88,
      previousParentNodeId: null,
      newParentNodeId: 'epic-1',
      reason: 'matches Frontend',
    });
  });

  it("writes an 'overridden' row with before/after deltas captured", async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'user-7',
      changeType: 'overridden',
      previousDecision: 'uncertain',
      newDecision: 'place',
      previousConfidence: 40,
      newConfidence: 100,
      previousParentNodeId: null,
      newParentNodeId: 'epic-1',
      reason: 'operator: I know better',
    });
    expect(insertedHistory[0]).toMatchObject({
      changeType: 'overridden',
      previousDecision: 'uncertain',
      newDecision: 'place',
      previousConfidence: 40,
      newConfidence: 100,
      changedBy: 'user-7',
    });
  });

  it("writes a 'reclassified' row with auto changedBy", async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'reclassified',
      previousDecision: 'place',
      newDecision: 'skip',
      previousConfidence: 80,
      newConfidence: 92,
      previousParentNodeId: 'epic-1',
      newParentNodeId: null,
      reason: 'no longer relevant after map refactor',
    });
    expect(insertedHistory[0]).toMatchObject({
      changeType: 'reclassified',
      changedBy: 'auto',
      previousDecision: 'place',
      newDecision: 'skip',
      previousParentNodeId: 'epic-1',
      newParentNodeId: null,
    });
  });

  it("writes a 'confirmed' row where previous_/new_ are identical", async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'user-7',
      changeType: 'confirmed',
      previousDecision: 'place',
      newDecision: 'place',
      previousConfidence: 88,
      newConfidence: 88,
      previousParentNodeId: 'epic-1',
      newParentNodeId: 'epic-1',
      reason: 'accept LLM call as-is',
    });
    expect(insertedHistory[0].changeType).toBe('confirmed');
    expect(insertedHistory[0].previousDecision).toBe(insertedHistory[0].newDecision);
    expect(insertedHistory[0].previousParentNodeId).toBe(
      insertedHistory[0].newParentNodeId,
    );
  });

  it("writes a 'state_synced' row for GH issue_state refresh on reopen", async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'state_synced',
      previousDecision: 'place',
      newDecision: 'place',
      previousConfidence: 88,
      newConfidence: 88,
      previousParentNodeId: 'epic-1',
      newParentNodeId: 'epic-1',
      reason: 'matches Frontend',
    });
    expect(insertedHistory[0].changeType).toBe('state_synced');
    expect(insertedHistory[0].changedBy).toBe('auto');
  });
});

// ── Multi-mutation sequence ──────────────────────────────────────

describe('recordTriageHistory — sequenced trajectory', () => {
  it('multiple mutations land in chronological order, decisionId stable', async () => {
    // Simulate: auto-created → operator-overridden → auto-reclassified
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'created',
      previousDecision: null,
      newDecision: 'uncertain',
      previousConfidence: null,
      newConfidence: 40,
      previousParentNodeId: null,
      newParentNodeId: null,
      reason: 'LLM unsure',
    });
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'user-7',
      changeType: 'overridden',
      previousDecision: 'uncertain',
      newDecision: 'place',
      previousConfidence: 40,
      newConfidence: 100,
      previousParentNodeId: null,
      newParentNodeId: 'epic-1',
      reason: 'operator force-placed',
    });
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'reclassified',
      previousDecision: 'place',
      newDecision: 'skip',
      previousConfidence: 100,
      newConfidence: 88,
      previousParentNodeId: 'epic-1',
      newParentNodeId: null,
      reason: 'map refactor — no longer fits',
    });

    expect(insertedHistory).toHaveLength(3);
    expect(insertedHistory.map((r) => r.changeType)).toEqual([
      'created',
      'overridden',
      'reclassified',
    ]);
    // Each row's previous_ matches the prior row's new_ — round-trips the
    // decision trajectory.
    expect(insertedHistory[1].previousDecision).toBe(insertedHistory[0].newDecision);
    expect(insertedHistory[2].previousDecision).toBe(insertedHistory[1].newDecision);
    expect(insertedHistory[1].previousParentNodeId).toBe(
      insertedHistory[0].newParentNodeId,
    );
    expect(insertedHistory[2].previousParentNodeId).toBe(
      insertedHistory[1].newParentNodeId,
    );
    // All three rows share the same decisionId — history is per-row.
    expect(new Set(insertedHistory.map((r) => r.decisionId))).toEqual(
      new Set(['d1']),
    );
  });

  it('mutations on two different decisions stay segregated by decisionId', async () => {
    await recordTriageHistory({
      decisionId: 'd1',
      changedBy: 'auto',
      changeType: 'created',
      previousDecision: null,
      newDecision: 'place',
      previousConfidence: null,
      newConfidence: 88,
      previousParentNodeId: null,
      newParentNodeId: 'epic-1',
      reason: 'r1',
    });
    await recordTriageHistory({
      decisionId: 'd2',
      changedBy: 'auto',
      changeType: 'created',
      previousDecision: null,
      newDecision: 'skip',
      previousConfidence: null,
      newConfidence: 92,
      previousParentNodeId: null,
      newParentNodeId: null,
      reason: 'r2',
    });
    expect(insertedHistory).toHaveLength(2);
    const d1Rows = insertedHistory.filter((r) => r.decisionId === 'd1');
    const d2Rows = insertedHistory.filter((r) => r.decisionId === 'd2');
    expect(d1Rows).toHaveLength(1);
    expect(d2Rows).toHaveLength(1);
    expect(d1Rows[0].newDecision).toBe('place');
    expect(d2Rows[0].newDecision).toBe('skip');
  });
});

// ── Failure modes ────────────────────────────────────────────────

describe('recordTriageHistory — failure isolation', () => {
  it('a DB throw inside the recorder is swallowed (no rethrow)', async () => {
    shouldFailInsert = true;
    // The whole point of best-effort audit logging is that a write
    // failure here can't take down the surrounding mutation. The test
    // proves the helper doesn't propagate.
    await expect(
      recordTriageHistory({
        decisionId: 'd1',
        changedBy: 'auto',
        changeType: 'created',
        previousDecision: null,
        newDecision: 'place',
        previousConfidence: null,
        newConfidence: 88,
        previousParentNodeId: null,
        newParentNodeId: 'epic-1',
        reason: 'r1',
      }),
    ).resolves.toBeUndefined();
    expect(insertedHistory).toHaveLength(0);
  });
});
