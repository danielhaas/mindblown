/**
 * Auto-backfill drift remediation.
 *
 * The daily drift audit (`./driftAudit.ts`) detects open GitHub issues
 * that have no linked MindBlown node, then pushes a Kuma alarm. Before
 * this module landed, the operator had to click "Backfill" in the UI
 * for each drifted map to actually heal the drift. This module closes
 * that gap: when audit finds drift below a per-day cap, it auto-invokes
 * the same backfill code path the manual UI uses; over the cap, it
 * leaves the drift in place so the alarm escalates to a human.
 *
 * Safety model:
 *   - A per-day cap (`AUTO_BACKFILL_MAX_PER_DAY`, default 50) prevents a
 *     misconfigured webhook + a fast-issue-opening repo from
 *     flood-amplifying into thousands of inbox nodes overnight.
 *   - `AUTO_BACKFILL_MAX_PER_DAY=0` is a kill switch: no map ever gets
 *     auto-backfilled, audit still runs and alarms.
 *   - Per-map backfill failures are caught — one map's broken token
 *     doesn't stall remediation for the others.
 *
 * Kuma push semantics (set by `runDriftAudit` in `./driftAudit.ts`):
 *   - No drift → status=up, msg="no-drift"
 *   - Drift fully auto-healed → status=up, msg="auto-backfilled-N"
 *   - Drift partially healed → status=up, msg="auto-backfilled-N,manual-M"
 *   - Drift all over cap → status=up, msg="manual-N"
 *   - Backfill threw entirely → status=down, msg="audit_failed:<reason>"
 *
 * `up` for full auto-heal means the operator never gets a page when the
 * system recovers itself. `up` for the manual-pending branches reflects
 * a 2026-06-10 scope clarification: a triage queue waiting on human
 * eyes is not an infra failure — operators get a daily email from
 * Jenna's housekeeping sweep instead. Kuma only fires for true infra
 * failures (audit threw, no heartbeat in 24h). The message field still
 * carries the manual-N receipt so the Kuma dashboard shows the
 * backlog; it just doesn't page.
 */

import type { DriftReport } from './driftAudit.js';
import { backfillMap, type BackfillMapResult } from './githubIngest.js';

/**
 * Per-map outcome from the auto-backfill sweep. Mirrors the report
 * shape from drift audit so the Kuma message can show "this map was
 * over cap" vs "this map's backfill threw" without dropping data.
 */
export type AutoBackfillMapOutcome =
  | { mapId: string; mapName: string; kind: 'healed'; imported: number }
  | { mapId: string; mapName: string; kind: 'over-cap'; pending: number }
  | { mapId: string; mapName: string; kind: 'failed'; pending: number; reason: string };

export interface AutoBackfillSummary {
  /** Total nodes created across all healed maps. */
  totalImported: number;
  /** Total drift left behind (manual + failed). */
  totalManualPending: number;
  /** Map-level outcomes for the Kuma message + log line. */
  outcomes: AutoBackfillMapOutcome[];
}

/** Default cap on auto-backfill per map per audit tick. */
export const DEFAULT_AUTO_BACKFILL_MAX_PER_DAY = 50;

/**
 * Read the configured per-day auto-backfill cap from
 * `AUTO_BACKFILL_MAX_PER_DAY`. Falls back to `DEFAULT_AUTO_BACKFILL_MAX_PER_DAY`
 * if unset or unparseable. Negative values are clamped to 0 (kill
 * switch). Exported for tests.
 */
export function getAutoBackfillCap(): number {
  const raw = process.env.AUTO_BACKFILL_MAX_PER_DAY;
  if (raw === undefined) return DEFAULT_AUTO_BACKFILL_MAX_PER_DAY;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_AUTO_BACKFILL_MAX_PER_DAY;
  return Math.max(0, parsed);
}

/**
 * Process every drift report. For each:
 *   - `onlyInGitHub == 0` is impossible here (audit returns only > 0),
 *     but defensively treated as already-healed.
 *   - `0 < onlyInGitHub <= cap` → invoke `backfillMap` for the map.
 *   - `onlyInGitHub > cap` → skip; leave drift for the operator.
 *
 * Drift audit only counts open issues, so we pass
 * `allowClosedWithinDays: 0` into backfillMap — even if a stale
 * closed-within-window issue is unlinked, it's not part of the alarm
 * the audit raised, so we don't sweep it in here.
 */
export async function runAutoBackfill(
  reports: DriftReport[],
  capOverride?: number,
): Promise<AutoBackfillSummary> {
  const cap = capOverride ?? getAutoBackfillCap();
  const outcomes: AutoBackfillMapOutcome[] = [];
  let totalImported = 0;
  let totalManualPending = 0;

  for (const report of reports) {
    const { mapId, mapName, onlyInGitHub } = report;

    if (onlyInGitHub <= 0) continue;

    if (cap === 0 || onlyInGitHub > cap) {
      // Either the kill switch is engaged or this map's drift is too
      // big to safely auto-heal. Leave it for manual ack.
      outcomes.push({ mapId, mapName, kind: 'over-cap', pending: onlyInGitHub });
      totalManualPending += onlyInGitHub;
      continue;
    }

    let result: BackfillMapResult;
    try {
      result = await backfillMap(mapId, {
        // Drift count is open-issues-only, so cap maxToImport to that
        // exact number — avoids reading further closed issues into the
        // inbox by surprise.
        maxToImport: onlyInGitHub,
        allowClosedWithinDays: 0,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[auto-backfill] map ${mapId} (${mapName}) — backfill threw:`,
        reason,
      );
      outcomes.push({ mapId, mapName, kind: 'failed', pending: onlyInGitHub, reason });
      totalManualPending += onlyInGitHub;
      continue;
    }

    totalImported += result.imported;

    // It's possible for `result.imported < onlyInGitHub` even without an
    // exception — `ensureNodeForIssue` may have raced with another path
    // (skipped_exists), or per-issue ingest may have errored. Count the
    // residual as manual-pending so the Kuma message stays honest.
    const residual = Math.max(0, onlyInGitHub - result.imported);
    if (residual > 0) {
      totalManualPending += residual;
      // Replace the "healed" outcome with "failed" if NOTHING got
      // imported — that's a worse signal than a partial heal and it
      // shouldn't masquerade as success in the per-map log.
      if (result.imported === 0) {
        outcomes.push({
          mapId,
          mapName,
          kind: 'failed',
          pending: residual,
          reason: `imported 0/${onlyInGitHub} (${result.errored} errored)`,
        });
        continue;
      }
    }

    outcomes.push({ mapId, mapName, kind: 'healed', imported: result.imported });
  }

  return { totalImported, totalManualPending, outcomes };
}
