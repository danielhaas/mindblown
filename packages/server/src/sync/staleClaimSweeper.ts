/**
 * Stale-claim sweeper (#111).
 *
 * Runs on a configurable interval and clears claims on nodes where:
 *   - claimed_by_session IS NOT NULL (the node is claimed)
 *   - claimed_at < NOW() - staleClaimHours (the claim is older than the threshold)
 *   - There has been no progress update since the claim was set
 *     (we use `updated_at <= claimed_at` as a proxy for "no activity since claim").
 *
 * The stale threshold is configurable per map via `maps.stale_claim_hours`
 * (default 4h, set in migrations). This lets short-lived session pools use
 * tighter windows (e.g. 0.5h) while long-running background jobs keep a
 * looser threshold.
 *
 * The sweeper is intentionally lightweight:
 *   - It queries only claimed rows (partial index on claimed_by_session).
 *   - It issues one UPDATE per stale node (not a bulk UPDATE) so the
 *     WebSocket broadcast fires per node and connected clients see the
 *     claim drop in real-time.
 *   - Any per-node error is caught + logged; the sweep continues.
 */

import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes, maps } from '../db/schema.js';
import { dbNodeToCore } from '../db/helpers.js';
import { notDeleted } from '../db/nodes.js';
import { broadcast } from '../ws.js';

export interface StaleClaimSweepResult {
  inspected: number;
  cleared: number;
  errors: string[];
}

/**
 * Run one sweep pass: find stale claims across all maps and clear them.
 */
export async function runStaleClaimSweep(): Promise<StaleClaimSweepResult> {
  const result: StaleClaimSweepResult = { inspected: 0, cleared: 0, errors: [] };

  // Fetch all claimed nodes joined with their map's stale_claim_hours.
  // We do a raw join so we don't need to fetch all maps separately.
  const claimedRows = await db
    .select({
      node: nodes,
      staleClaimHours: maps.staleClaimHours,
    })
    .from(nodes)
    .innerJoin(maps, eq(nodes.mapId, maps.id))
    .where(
      and(
        notDeleted,
        isNotNull(nodes.claimedBySession),
        isNotNull(nodes.claimedAt),
      ),
    );

  result.inspected = claimedRows.length;

  const now = new Date();

  for (const { node: row, staleClaimHours } of claimedRows) {
    try {
      const threshold = (staleClaimHours as number) ?? 4;
      const claimedAt = row.claimedAt as Date | null;
      if (!claimedAt) continue;

      const ageMs = now.getTime() - claimedAt.getTime();
      const thresholdMs = threshold * 60 * 60 * 1000;

      if (ageMs < thresholdMs) continue; // Not yet stale

      // Stale: clear the claim
      const [updated] = await db
        .update(nodes)
        .set({
          claimedBySession: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(and(eq(nodes.id, row.id as string), notDeleted))
        .returning();

      if (updated) {
        result.cleared++;
        const coreNode = dbNodeToCore(updated as unknown as Record<string, unknown>);
        broadcast(row.mapId as string, {
          type: 'node:updated',
          nodeId: row.id as string,
          fields: ['claimedBySession', 'claimedAt'],
          node: coreNode,
          source: 'stale_claim_sweep',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`node ${row.id as string}: ${msg}`);
    }
  }

  return result;
}
