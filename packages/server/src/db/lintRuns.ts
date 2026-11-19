/**
 * The daily self-check's runs (lint/daily.ts): one row per map and local
 * day. A second run the same day replaces the row, so the newest row is
 * always what the map looks like now — its asks are the lint-<rule>-<node>
 * rows on the Questions card (services/derivedAsks.ts).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { LintRun } from '@mindblown/core';
import { db } from './connection.js';
import { lintRuns, maps } from './schema.js';

type Row = typeof lintRuns.$inferSelect;

function toRun(r: Row, mapName?: string): LintRun {
  return {
    mapId: r.mapId,
    ...(mapName !== undefined ? { mapName } : {}),
    day: r.day,
    ranAt: r.ranAt.toISOString(),
    fixed: (r.fixed ?? []) as LintRun['fixed'],
    asked: (r.asked ?? []) as LintRun['asked'],
    digest: (r.digest ?? {}) as LintRun['digest'],
    error: r.error ?? null,
  };
}

export async function saveRun(run: Omit<LintRun, 'mapName'>): Promise<void> {
  const values = {
    mapId: run.mapId,
    day: run.day,
    ranAt: new Date(run.ranAt),
    fixed: run.fixed,
    asked: run.asked,
    digest: run.digest,
    error: run.error,
  };
  await db
    .insert(lintRuns)
    .values(values)
    .onConflictDoUpdate({ target: [lintRuns.mapId, lintRuns.day], set: { ranAt: values.ranAt, fixed: values.fixed, asked: values.asked, digest: values.digest, error: values.error } });
}

/** Whether the map has a run on this day already. */
export async function hasRun(mapId: string, day: string): Promise<boolean> {
  const rows = await db.select({ day: lintRuns.day }).from(lintRuns).where(and(eq(lintRuns.mapId, mapId), eq(lintRuns.day, day))).limit(1);
  return rows.length > 0;
}

/** The newest run of each map (maps without one are absent). */
export async function latestRuns(mapIds: string[]): Promise<Map<string, LintRun>> {
  const out = new Map<string, LintRun>();
  if (mapIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([lintRuns.mapId])
    .from(lintRuns)
    .where(inArray(lintRuns.mapId, mapIds))
    .orderBy(lintRuns.mapId, desc(lintRuns.ranAt));
  for (const r of rows) out.set(r.mapId, toRun(r));
  return out;
}

/** Runs of these maps from `sinceDay` on, newest first, with the map's name. */
export async function listRuns(mapIds: string[], sinceDay: string, limit = 200): Promise<LintRun[]> {
  if (mapIds.length === 0) return [];
  const rows = await db
    .select({ run: lintRuns, name: maps.name })
    .from(lintRuns)
    .innerJoin(maps, eq(maps.id, lintRuns.mapId))
    .where(and(inArray(lintRuns.mapId, mapIds), gte(lintRuns.day, sinceDay)))
    .orderBy(desc(lintRuns.day), sql`${maps.name}`)
    .limit(limit);
  return rows.map((r) => toRun(r.run, r.name));
}
