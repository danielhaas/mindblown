/**
 * Lint-dismissal persistence (plan-health panel, docs/plan-linter.md).
 * nodeId NULL = rule muted for the whole map.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './connection.js';
import { lintDismissals } from './schema.js';

export interface DismissalRow {
  id: string;
  mapId: string;
  nodeId: string | null;
  ruleId: string;
  dismissedBy: string | null;
  createdAt: Date;
}

export async function listDismissals(mapId: string): Promise<DismissalRow[]> {
  return db.select().from(lintDismissals).where(eq(lintDismissals.mapId, mapId));
}

function matchClause(mapId: string, ruleId: string, nodeId: string | null) {
  return and(
    eq(lintDismissals.mapId, mapId),
    eq(lintDismissals.ruleId, ruleId),
    nodeId == null ? isNull(lintDismissals.nodeId) : eq(lintDismissals.nodeId, nodeId),
  );
}

/**
 * Idempotent dismiss: returns the existing row when the same
 * (map, rule, node) dismissal already exists. Uniqueness is app-level —
 * a nullable node_id makes a DB unique constraint awkward pre-PG15, and
 * a lost race here just produces a duplicate row with identical effect.
 */
export async function upsertDismissal(
  mapId: string,
  ruleId: string,
  nodeId: string | null,
  dismissedBy: string | null,
): Promise<{ row: DismissalRow; created: boolean }> {
  const existing = await db.select().from(lintDismissals).where(matchClause(mapId, ruleId, nodeId));
  if (existing.length > 0) return { row: existing[0], created: false };
  const inserted = await db
    .insert(lintDismissals)
    .values({ mapId, nodeId, ruleId, dismissedBy })
    .returning();
  return { row: inserted[0], created: true };
}

export async function deleteDismissal(mapId: string, ruleId: string, nodeId: string | null): Promise<void> {
  await db.delete(lintDismissals).where(matchClause(mapId, ruleId, nodeId));
}
