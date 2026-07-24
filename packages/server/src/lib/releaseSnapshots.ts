import { sql, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { releaseSnapshots, maps as mapsTable } from '../db/schema.js';
import * as mapDb from '../db/maps.js';
import * as versionDb from '../db/versions.js';
import { computeReleaseForecast } from './releaseForecast.js';
import { measureMapVelocity } from './velocityMeasure.js';
import type { ReleaseForecastResult } from './releaseForecast.js';

/**
 * Upsert today's snapshot row per (map, version) for a single map.
 *
 * Takes an optional precomputed forecast so the HTTP route can
 * write a snapshot without recomputing — the ?refresh=1 flow on
 * GET /api/maps/:id/release-forecast uses this.
 *
 * The UNIQUE (map_id, version_id, snapshot_date) constraint makes
 * repeated calls in the same calendar day idempotent: we overwrite
 * the existing row with the latest numbers.
 */
export async function snapshotReleaseForecastForMap(
  mapId: string,
  forecast?: ReleaseForecastResult,
): Promise<number> {
  let result: ReleaseForecastResult | null = forecast ?? null;

  if (!result) {
    const data = await mapDb.getMap(mapId);
    if (!data) return 0;
    const versions = await versionDb.listVersions(data.map.id);
    // Measured rates make the snapshot record what the forecast actually
    // said (net-rate velocity + ticket model), not a knob-based shadow of
    // it. Measurement failure degrades to knobs — never blocks the cron.
    const rates = await measureMapVelocity(mapId, data, 56, undefined, {
      freshThroughput: true, // hourly cron re-crawls and keeps the cache warm
    })
      .then((m) => m.rates)
      .catch(() => undefined);
    result = computeReleaseForecast(data.map, data.nodes, versions, new Date(), rates);
  }

  const snapshotDate = new Date().toISOString().slice(0, 10);
  let written = 0;

  for (const row of result.releases) {
    // Only snapshot rows that have *some* data — skip empty versions
    // (0 leaves) to keep the history lean.
    if (row.leaves === 0) continue;

    await db
      .insert(releaseSnapshots)
      .values({
        mapId,
        versionId: row.versionId,
        versionName: row.versionName,
        snapshotDate,
        targetDate: row.targetDate,
        plannedFinishDate: row.plannedFinishDate,
        velocityAdjustedFinishDate: row.velocityAdjustedFinishDate,
        ticketModelFinishDate: row.ticketModelFinishDate,
        remainingTickets: row.remainingTickets,
        remainingEffort: row.remainingEffort,
        totalEffort: row.totalEffort,
        leaves: row.leaves,
      })
      .onConflictDoUpdate({
        target: [
          releaseSnapshots.mapId,
          releaseSnapshots.versionId,
          releaseSnapshots.snapshotDate,
        ],
        set: {
          versionName: row.versionName,
          targetDate: row.targetDate,
          plannedFinishDate: row.plannedFinishDate,
          velocityAdjustedFinishDate: row.velocityAdjustedFinishDate,
          ticketModelFinishDate: row.ticketModelFinishDate,
          remainingTickets: row.remainingTickets,
          remainingEffort: row.remainingEffort,
          totalEffort: row.totalEffort,
          leaves: row.leaves,
          createdAt: new Date(),
        },
      });

    written++;
  }

  return written;
}

/**
 * Iterate every non-archived map in the database and snapshot each.
 * Called from server startup (catch-up) and hourly from setInterval.
 * Failures on any one map are logged and skipped — a bad map can't
 * block the rest of the cron.
 */
export async function snapshotAllMaps(): Promise<{ maps: number; rows: number }> {
  const allMaps = await db
    .select({ id: mapsTable.id })
    .from(mapsTable)
    .where(sql`${mapsTable.archivedAt} IS NULL`);

  let mapsProcessed = 0;
  let totalRows = 0;

  for (const m of allMaps) {
    try {
      const written = await snapshotReleaseForecastForMap(m.id);
      mapsProcessed++;
      totalRows += written;
    } catch (err) {
      console.error(`[release-snapshot] Failed for map ${m.id}:`, err);
    }
  }

  return { maps: mapsProcessed, rows: totalRows };
}
