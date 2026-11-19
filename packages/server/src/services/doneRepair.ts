/**
 * Repair for done nodes written before "done is 100 %" (db/nodes.ts
 * doneLeafProgress) and "done ends the worker's own wait note":
 *
 *   - a done leaf below 100 % → 100 %
 *   - a done node carrying a fleet worker's own note ("Fleet worker <session>: …")
 *     → note cleared, `blocked` tag removed. A person's blocker stays.
 *
 * Opt-in, per map, never on startup: scripts/repair-done-nodes.ts previews it
 * (dry run, the default) and applies it only to the maps named with --map.
 * Another owner's "done below 100 %" may be deliberate, and archived maps get
 * no robot writes.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { BLOCKED_TAG, WORKER_WAIT_NOTE, buildIsDonePredicate, type StatusDef } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps, nodes } from '../db/schema.js';

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
  archived: boolean;
  progress: number;
  notes: number;
}

/**
 * Preview (dryRun) or apply the repair. Applying needs explicit `mapIds` —
 * there is no "all maps" apply — and refuses archived maps before writing
 * anything. A dry run without `mapIds` lists every map with something to
 * repair. Returns the maps with something to repair.
 */
export async function repairDoneNodes(opts: { dryRun: boolean; mapIds?: string[] }): Promise<DoneRepairCount[]> {
  const mapIds = [...new Set(opts.mapIds ?? [])];
  if (!opts.dryRun && mapIds.length === 0) {
    throw new Error('Done repair: --apply needs at least one --map <id>; there is no all-maps apply.');
  }
  const fields = { id: maps.id, name: maps.name, statusWorkflow: maps.statusWorkflow, archivedAt: maps.archivedAt };
  const mapRows =
    mapIds.length > 0 ? await db.select(fields).from(maps).where(inArray(maps.id, mapIds)) : await db.select(fields).from(maps);
  if (mapIds.length > 0) {
    const missing = mapIds.filter((id) => !mapRows.some((m) => m.id === id));
    if (missing.length > 0) throw new Error(`Done repair: no such map ${missing.join(', ')}.`);
    const archived = mapRows.filter((m) => m.archivedAt != null);
    if (!opts.dryRun && archived.length > 0) {
      throw new Error(
        `Done repair: refusing archived map${archived.length > 1 ? 's' : ''} ${archived.map((m) => `"${m.name}" (${m.id})`).join(', ')}; nothing written.`,
      );
    }
  }
  const counts: DoneRepairCount[] = [];
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
    counts.push({
      mapId: map.id,
      mapName: map.name as string,
      archived: map.archivedAt != null,
      progress: plan.progress.length,
      notes: plan.notes.length,
    });
    if (opts.dryRun) continue;
    if (plan.progress.length > 0) {
      await db.update(nodes).set({ percentComplete: 100 }).where(inArray(nodes.id, plan.progress));
    }
    for (const n of plan.notes) {
      await db.update(nodes).set({ blockedReason: null, tags: n.tags }).where(eq(nodes.id, n.id));
    }
  }
  for (const c of counts) {
    const verb = opts.dryRun ? 'would set' : 'set';
    const archived = c.archived ? ' [archived: --apply refuses it]' : '';
    console.log(
      `[db] Done repair, map "${c.mapName}" (${c.mapId})${archived}: ${verb} ${c.progress} done leaves to 100 %, ${opts.dryRun ? 'would clear' : 'cleared'} ${c.notes} worker notes.`,
    );
  }
  if (counts.length === 0) console.log('[db] Done repair: nothing to repair.');
  return counts;
}
