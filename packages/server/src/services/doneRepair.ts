/**
 * One-time repair for done nodes written before "done is 100 %" (db/nodes.ts
 * doneLeafProgress) and "done ends the worker's own wait note":
 *
 *   - a done leaf below 100 % → 100 %
 *   - a done node carrying a fleet worker's own note ("Fleet worker <session>: …")
 *     → note cleared, `blocked` tag removed. A person's blocker stays.
 *
 * `repairDoneNodes({ dryRun: true })` only counts (scripts/repair-done-nodes.ts,
 * the default there). On startup `runDoneRepairOnce` applies it once, recorded
 * in data_migrations, and logs the counts per map.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { BLOCKED_TAG, WORKER_WAIT_NOTE, buildIsDonePredicate, type StatusDef } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps, nodes } from '../db/schema.js';

const MIGRATION_ID = 'repair_done_nodes_v1';

export interface DoneRepairRow {
  id: string;
  status: string | null;
  percentComplete: number | null;
  childrenOrder: string[] | null;
  blockedReason: string | null;
  tags: string[] | null;
}

export interface DoneRepairPlan {
  /** Done leaves below 100 %. */
  progress: string[];
  /** Done nodes with a worker note: the tags they keep. */
  notes: Array<{ id: string; tags: string[] }>;
}

/** What to change on one map's live nodes. Pure. */
export function planDoneRepair(rows: DoneRepairRow[], isDone: (status: string | null) => boolean): DoneRepairPlan {
  const plan: DoneRepairPlan = { progress: [], notes: [] };
  for (const r of rows) {
    if (!isDone(r.status)) continue;
    const isLeaf = (r.childrenOrder ?? []).length === 0;
    if (isLeaf && (r.percentComplete ?? 0) < 100) plan.progress.push(r.id);
    if (WORKER_WAIT_NOTE.test((r.blockedReason ?? '').trim())) {
      plan.notes.push({ id: r.id, tags: (r.tags ?? []).filter((t) => t !== BLOCKED_TAG) });
    }
  }
  return plan;
}

export interface DoneRepairCount {
  mapId: string;
  mapName: string;
  progress: number;
  notes: number;
}

/** Repair every map (dryRun: count only). Returns the maps with something to repair. */
export async function repairDoneNodes(opts: { dryRun: boolean }): Promise<DoneRepairCount[]> {
  const counts: DoneRepairCount[] = [];
  const mapRows = await db.select({ id: maps.id, name: maps.name, statusWorkflow: maps.statusWorkflow }).from(maps);
  for (const map of mapRows) {
    const rows = await db
      .select({
        id: nodes.id,
        status: nodes.status,
        percentComplete: nodes.percentComplete,
        childrenOrder: nodes.childrenOrder,
        blockedReason: nodes.blockedReason,
        tags: nodes.tags,
      })
      .from(nodes)
      .where(and(eq(nodes.mapId, map.id), isNull(nodes.deletedAt)));
    const plan = planDoneRepair(rows as DoneRepairRow[], buildIsDonePredicate((map.statusWorkflow as StatusDef[]) ?? []));
    if (plan.progress.length === 0 && plan.notes.length === 0) continue;
    counts.push({ mapId: map.id, mapName: map.name as string, progress: plan.progress.length, notes: plan.notes.length });
    if (opts.dryRun) continue;
    if (plan.progress.length > 0) {
      await db.update(nodes).set({ percentComplete: 100 }).where(inArray(nodes.id, plan.progress));
    }
    for (const n of plan.notes) {
      await db.update(nodes).set({ blockedReason: null, tags: n.tags }).where(eq(nodes.id, n.id));
    }
  }
  const verb = opts.dryRun ? 'would set' : 'set';
  for (const c of counts) {
    console.log(`[db] Done repair, map "${c.mapName}" (${c.mapId}): ${verb} ${c.progress} done leaves to 100 %, ${opts.dryRun ? 'would clear' : 'cleared'} ${c.notes} worker notes.`);
  }
  if (counts.length === 0) console.log('[db] Done repair: nothing to repair.');
  return counts;
}

/** Apply the repair once (startup), recorded in data_migrations. */
export async function runDoneRepairOnce(): Promise<void> {
  const done = await db.execute(sql`SELECT 1 FROM data_migrations WHERE id = ${MIGRATION_ID}`);
  if (done.rows.length > 0) return;
  await repairDoneNodes({ dryRun: false });
  await db.execute(sql`INSERT INTO data_migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`);
}
