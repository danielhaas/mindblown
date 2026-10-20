/**
 * Repo credential handouts (#507) — the trail of which fleet fetched which
 * project's repo credentials, and when. Never the token.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { fleetRepoHandouts, maps } from './schema.js';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export async function recordHandout(fleetId: string, mapId: string, repo: string, now = new Date()): Promise<void> {
  await db.insert(fleetRepoHandouts).values({ fleetId, mapId, repo, createdAt: now });
  // This fleet's old rows only — the index leads with fleet_id.
  await db
    .delete(fleetRepoHandouts)
    .where(and(eq(fleetRepoHandouts.fleetId, fleetId), lt(fleetRepoHandouts.createdAt, new Date(now.getTime() - KEEP_MS))));
}

export interface HandoutSummary {
  mapId: string;
  mapName: string;
  repo: string;
  count: number;
  lastAt: string;
}

/** Per map and repo since `since`: how often, and the latest. Newest first. */
export async function summarizeHandouts(fleetId: string, since: Date): Promise<HandoutSummary[]> {
  const rows = await db
    .select({
      mapId: fleetRepoHandouts.mapId,
      mapName: maps.name,
      repo: fleetRepoHandouts.repo,
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date>`max(${fleetRepoHandouts.createdAt})`,
    })
    .from(fleetRepoHandouts)
    .innerJoin(maps, eq(maps.id, fleetRepoHandouts.mapId))
    .where(and(eq(fleetRepoHandouts.fleetId, fleetId), gte(fleetRepoHandouts.createdAt, since)))
    .groupBy(fleetRepoHandouts.mapId, maps.name, fleetRepoHandouts.repo)
    .orderBy(desc(sql`max(${fleetRepoHandouts.createdAt})`));
  return rows.map((r) => ({ ...r, count: Number(r.count), lastAt: new Date(r.lastAt).toISOString() }));
}
