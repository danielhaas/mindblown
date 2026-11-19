/**
 * One-shot backfill of the approval stamp (#492) for the nodes that existed
 * before it. The pull queue is fail-closed — it runs only approved nodes —
 * so without this every existing ticket would stop.
 *
 * Decision (Dan, 28.10.2026): an open node is approved when its reporter
 * counts as trusted today (unknown reporter = pre-#490, or on the map's
 * trusted list); one from a known or external reporter is proposed. Done
 * nodes are approved: there is nothing left to approve, and a reopened one
 * should not freeze. `by: null` = by migration. The map root gets no stamp.
 *
 * Runs after the DDL migrations because it needs the trust policy logic
 * (services/trustPolicy.ts), not only SQL. Recorded in data_migrations, so a
 * later policy change never re-stamps.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { buildIsDonePredicate, type NodeApproval, type NodeReporter, type StatusDef } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps, nodes } from '../db/schema.js';
import { approvalFor, loadTrustContext } from './trustPolicy.js';

const MIGRATION_ID = 'backfill_node_approval_v1';

export interface ApprovalBackfillRow {
  id: string;
  status: string | null;
  reportedBy: NodeReporter | null;
}

/** The stamp for one existing node. Pure apart from the loaded trust context. */
export function backfillStamp(
  row: ApprovalBackfillRow,
  isDone: (status: string | null) => boolean,
  approve: (reportedBy: NodeReporter) => NodeApproval,
  at: string,
): NodeApproval {
  if (isDone(row.status) || row.reportedBy === null) return { state: 'approved', merge: 'auto', by: null, at };
  return { ...approve(row.reportedBy), at };
}

export async function backfillApprovals(): Promise<void> {
  const done = await db.execute(sql`SELECT 1 FROM data_migrations WHERE id = ${MIGRATION_ID}`);
  if (done.rows.length > 0) return;

  const now = new Date();
  const at = now.toISOString();
  const counts = { approved: 0, proposed: 0 };
  const mapRows = await db.select({ id: maps.id, statusWorkflow: maps.statusWorkflow }).from(maps);
  for (const map of mapRows) {
    // Deleted rows too: a node restored from the trash must not come back unstamped.
    const rows = await db
      .select({ id: nodes.id, status: nodes.status, reportedBy: nodes.reportedBy })
      .from(nodes)
      .where(and(eq(nodes.mapId, map.id), isNull(nodes.approval), isNotNull(nodes.parentId)));
    if (rows.length === 0) continue;
    const ctx = await loadTrustContext(map.id);
    if (!ctx) continue;
    const isDone = buildIsDonePredicate((map.statusWorkflow as StatusDef[]) ?? []);
    const byStamp = new Map<string, string[]>();
    for (const r of rows) {
      const stamp = backfillStamp(r as ApprovalBackfillRow, isDone, (rep) => approvalFor(ctx, rep, now), at);
      counts[stamp.state === 'approved' ? 'approved' : 'proposed']++;
      const key = JSON.stringify(stamp);
      (byStamp.get(key) ?? byStamp.set(key, []).get(key)!).push(r.id);
    }
    // No updated_at bump: the stamp is not an edit, and the stalled signals read updated_at.
    for (const [key, ids] of byStamp) {
      await db
        .update(nodes)
        .set({ approval: JSON.parse(key) as NodeApproval })
        .where(and(inArray(nodes.id, ids), isNull(nodes.approval)));
    }
  }
  await db.execute(sql`INSERT INTO data_migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`);
  console.log(`[db] Approval backfill (#492): ${counts.approved} approved, ${counts.proposed} proposed.`);
}
