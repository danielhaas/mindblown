/**
 * Triage decision history recorder (#96, Phase 3).
 *
 * Every mutation of a `triage_decisions` row writes one row to
 * `triage_decision_history` so an operator/auditor can reconstruct what
 * Claude or the human did to a given decision over time.
 *
 * The recorder is centralised here so the wire-up at each mutation site
 * stays a one-line `await recordTriageHistory(...)`. Mutation sites:
 *
 *   - `ensureNodeForIssueViaTriage`  → 'created' or 'overridden' depending
 *     on whether a prior row was present in the upsert.
 *   - `POST .../override`            → 'overridden'.
 *   - `POST .../reclassify`          → 'reclassified'.
 *   - `POST .../confirm`             → 'confirmed'.
 *   - `syncTriageRowsForReopen`      → 'state_synced' (and 'reclassified'
 *      when the row is re-triaged).
 *   - Bulk variants                  → one row per item.
 *
 * Write failures are best-effort: the helper logs and swallows. History
 * is an audit-trail concern; if it can't write, the actual decision flow
 * must still succeed. (Compare: change_events follows the same pattern.)
 */

import { db } from '../db/connection.js';
import { triageDecisionHistory } from '../db/schema.js';

export type TriageChangeType =
  | 'created'
  | 'overridden'
  | 'reclassified'
  | 'confirmed'
  | 'state_synced';

export interface TriageHistoryInput {
  decisionId: string;
  /** 'auto' for pipeline writes, a stringified userId for operator writes. */
  changedBy: string;
  changeType: TriageChangeType;
  previousDecision: string | null;
  newDecision: string;
  previousConfidence: number | null;
  newConfidence: number;
  previousParentNodeId: string | null;
  newParentNodeId: string | null;
  /** Snapshot of the new decision's reason text. */
  reason: string | null;
}

/**
 * Append a history row for a triage_decisions mutation.
 *
 * Best-effort: errors are logged but not rethrown so the surrounding
 * mutation never fails on audit-write failure.
 */
export async function recordTriageHistory(
  input: TriageHistoryInput,
): Promise<void> {
  try {
    await db.insert(triageDecisionHistory).values({
      decisionId: input.decisionId,
      changedBy: input.changedBy,
      changeType: input.changeType,
      previousDecision: input.previousDecision,
      newDecision: input.newDecision,
      previousConfidence: input.previousConfidence,
      newConfidence: input.newConfidence,
      previousParentNodeId: input.previousParentNodeId,
      newParentNodeId: input.newParentNodeId,
      reason: input.reason,
    });
  } catch (err) {
    console.warn(
      `[triage-history] failed to record ${input.changeType} on decision ${input.decisionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
