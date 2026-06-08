/**
 * One-off backfill: populate `suggested_parent_node_id` on existing
 * low-confidence `place` triage rows whose `placed_node_id IS NULL`.
 *
 * Why this exists
 * ---------------
 * The `suggested_parent_node_id` column was added to `triage_decisions`
 * AFTER several rounds of auto-triage had already run. Rows written
 * before the column existed have `suggested_parent_node_id = NULL`,
 * which means the new Override-modal pre-selection has nothing to
 * latch onto for the exact rows the feature targets (low-confidence
 * places that the operator must review).
 *
 * The fix is to re-run `triageIssue` once per affected row, with the
 * row's stored title + state as input, and write the LLM's suggested
 * parent into the new column. The existing `/reclassify` route does
 * exactly this — we reach into it via the same `triageIssue` helper
 * rather than HTTP-bouncing through Fastify, so the script can be
 * run from a one-shot container without standing up the API server.
 *
 * Scope
 * -----
 * Only touches rows where:
 *   - `decision = 'place'`
 *   - `placed_node_id IS NULL` (low-confidence — auto-apply didn't fire)
 *   - `suggested_parent_node_id IS NULL` (not already backfilled)
 *   - the parent map is `triage_enabled = true`
 *
 * For each affected row, runs one LLM call. The current MindBlown
 * self-map (df1d3294-09a1-4d08-9099-0899b76efaed) has 5 such rows so
 * the cost is ~5 cents on Opus. This script is idempotent — running
 * twice is a no-op because the second pass finds no rows matching
 * the `suggested_parent_node_id IS NULL` filter.
 *
 * Run as
 * ------
 *   DATABASE_URL=... ANTHROPIC_API_KEY=... \
 *     tsx packages/server/src/scripts/backfill-suggested-parent.ts
 *
 * Or with an explicit map filter:
 *   tsx packages/server/src/scripts/backfill-suggested-parent.ts \
 *     --map-id df1d3294-09a1-4d08-9099-0899b76efaed
 *
 * Not invoked automatically. The schema migration is idempotent and
 * runs every startup; the backfill is gated to one-off manual run so
 * a server restart can't spam the LLM.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, pool } from '../db/connection.js';
import { maps, triageDecisions } from '../db/schema.js';
import { buildMapContext } from '../sync/mapContext.js';
import { triageIssue } from '../sync/triage.js';

function parseIssueNumber(externalId: string): number {
  const idx = externalId.lastIndexOf('#');
  if (idx < 0) return 0;
  const n = parseInt(externalId.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

function buildIssueUrlFromExternalId(externalId: string): string {
  const idx = externalId.lastIndexOf('#');
  if (idx < 0) return '';
  const ownerRepo = externalId.slice(0, idx);
  const number = externalId.slice(idx + 1);
  return `https://github.com/${ownerRepo}/issues/${number}`;
}

interface BackfillRow {
  id: string;
  mapId: string;
  externalId: string;
  issueTitle: string;
  issueState: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mapIdFlagIdx = args.indexOf('--map-id');
  const targetMapId =
    mapIdFlagIdx >= 0 && args[mapIdFlagIdx + 1] ? args[mapIdFlagIdx + 1] : null;

  const dryRun = args.includes('--dry-run');

  console.log('[backfill] starting suggested_parent_node_id retro-fill');
  if (targetMapId) console.log(`[backfill]   filter: map_id=${targetMapId}`);
  if (dryRun) console.log('[backfill]   DRY RUN — no writes, no LLM calls');

  // Find every row that needs backfilling. Strict filter set: place
  // decision, no placed node, no existing suggestion. We DON'T touch
  // skip/uncertain rows (suggestion is irrelevant) or already-placed
  // rows (auto-apply already happened — suggestion ≠ placed but the
  // operator's view of "what to do next" is satisfied without it).
  const filters = [
    eq(triageDecisions.decision, 'place'),
    isNull(triageDecisions.placedNodeId),
    isNull(triageDecisions.suggestedParentNodeId),
  ];
  if (targetMapId) {
    filters.push(eq(triageDecisions.mapId, targetMapId));
  }
  const rows: BackfillRow[] = await db
    .select({
      id: triageDecisions.id,
      mapId: triageDecisions.mapId,
      externalId: triageDecisions.externalId,
      issueTitle: triageDecisions.issueTitle,
      issueState: triageDecisions.issueState,
    })
    .from(triageDecisions)
    .where(and(...filters));

  console.log(`[backfill] found ${rows.length} candidate row(s)`);

  // Group by mapId so we build mapContext once per map, not once per row.
  // Same optimisation the bulk-reclassify route uses. For one map with
  // 5 rows this saves 4 buildMapContext calls (a few ms each, but cleaner).
  const rowsByMap = new Map<string, BackfillRow[]>();
  for (const row of rows) {
    const existing = rowsByMap.get(row.mapId) ?? [];
    existing.push(row);
    rowsByMap.set(row.mapId, existing);
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [mapId, mapRows] of rowsByMap) {
    // Per-map gate: only backfill if the map still has triage_enabled.
    // A map that disabled triage between the auto-call and the
    // backfill shouldn't get fresh LLM calls — the operator opted out.
    const [m] = await db
      .select({ triageEnabled: maps.triageEnabled })
      .from(maps)
      .where(eq(maps.id, mapId));
    if (!m || m.triageEnabled !== true) {
      console.warn(
        `[backfill] skipping map ${mapId}: triage_enabled=${m?.triageEnabled} (need true)`,
      );
      skipped += mapRows.length;
      continue;
    }

    let mapContext;
    try {
      mapContext = await buildMapContext(mapId);
    } catch (err) {
      console.error(
        `[backfill] failed to build context for map ${mapId}:`,
        err instanceof Error ? err.message : err,
      );
      errors += mapRows.length;
      continue;
    }

    for (const row of mapRows) {
      try {
        if (dryRun) {
          console.log(
            `[backfill] DRY: would re-triage ${row.externalId} (decision ${row.id})`,
          );
          skipped++;
          continue;
        }

        const issueNumber = parseIssueNumber(row.externalId);
        const decision = await triageIssue({
          issue: {
            id: issueNumber,
            number: issueNumber,
            title: row.issueTitle,
            body: null,
            state: row.issueState === 'closed' ? 'closed' : 'open',
            labels: [],
            assignees: [],
            milestone: null,
            html_url: buildIssueUrlFromExternalId(row.externalId),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          mapContext,
        });

        // Always write the new suggestion (null on skip/uncertain),
        // because the row is by definition a stale low-confidence
        // place — if the new LLM call decides skip, we want the
        // suggestion column to reflect that. We do NOT rewrite
        // `decision` / `confidence` / `placedNodeId` here, because
        // this is a column-backfill, not a reclassify. The operator's
        // review queue still shows the original auto-decision; the
        // only thing that changes is the badge surfaces a usable
        // pre-selection.
        const newSuggestedParentNodeId =
          decision.decision === 'place' ? (decision.parentNodeId ?? null) : null;

        await db
          .update(triageDecisions)
          .set({ suggestedParentNodeId: newSuggestedParentNodeId })
          .where(eq(triageDecisions.id, row.id));

        if (newSuggestedParentNodeId) {
          console.log(
            `[backfill]   ${row.externalId}: suggested ${newSuggestedParentNodeId}`,
          );
          updated++;
        } else {
          console.log(
            `[backfill]   ${row.externalId}: new decision is ${decision.decision}, no parent suggestion`,
          );
          // Still counts as updated — we wrote NULL deliberately.
          updated++;
        }
      } catch (err) {
        console.error(
          `[backfill] ${row.externalId}: failed —`,
          err instanceof Error ? err.message : err,
        );
        errors++;
      }
    }
  }

  console.log(
    `[backfill] done: ${updated} updated / ${skipped} skipped / ${errors} errors`,
  );
  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
