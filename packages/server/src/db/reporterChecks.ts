/** Rows of reporter_checks — the reporter's check of a deployed fix (services/reporterCheck.ts). */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { ReporterCheckOutcome, ReporterCheckState } from '@mindblown/core';
import { db } from './connection.js';
import { maps, reporterChecks } from './schema.js';

export interface ReporterCheckRow {
  nodeId: string;
  mapId: string;
  issueRef: string;
  issueUrl: string;
  reporter: string;
  state: ReporterCheckState;
  outcome: ReporterCheckOutcome | null;
  createdAt: Date;
  askedAt: Date | null;
  remindedAt: Date | null;
  replyAt: Date | null;
  replyUrl: string | null;
  replyExcerpt: string | null;
  doneAt: Date | null;
}

type Raw = typeof reporterChecks.$inferSelect;
const toRow = (r: Raw): ReporterCheckRow => ({ ...r, state: r.state as ReporterCheckState, outcome: r.outcome as ReporterCheckOutcome | null });

/** The open checks (not done) on these maps. */
export async function listOpenChecks(mapIds: string[]): Promise<ReporterCheckRow[]> {
  if (mapIds.length === 0) return [];
  const rows = await db.select().from(reporterChecks).where(and(inArray(reporterChecks.mapId, mapIds), ne(reporterChecks.state, 'done')));
  return rows.map(toRow);
}

/** Every open check on a map that is not archived (on hold = no forge writes), for the timer. */
export async function listAllOpenChecks(): Promise<ReporterCheckRow[]> {
  const rows = await db
    .select({ r: reporterChecks })
    .from(reporterChecks)
    .innerJoin(maps, eq(maps.id, reporterChecks.mapId))
    .where(and(ne(reporterChecks.state, 'done'), isNull(maps.archivedAt)));
  return rows.map((x) => toRow(x.r));
}

export async function getCheck(nodeId: string): Promise<ReporterCheckRow | null> {
  const [r] = await db.select().from(reporterChecks).where(eq(reporterChecks.nodeId, nodeId));
  return r ? toRow(r) : null;
}

/** The rows these nodes already have, any state — by node id. */
export async function checksOf(nodeIds: string[]): Promise<Map<string, Pick<ReporterCheckRow, 'state' | 'doneAt'>>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await db
    .select({ nodeId: reporterChecks.nodeId, state: reporterChecks.state, doneAt: reporterChecks.doneAt })
    .from(reporterChecks)
    .where(inArray(reporterChecks.nodeId, nodeIds));
  return new Map(rows.map((r) => [r.nodeId, { state: r.state as ReporterCheckState, doneAt: r.doneAt }]));
}

/**
 * Is this issue open because we reopened it to ask its reporter? The
 * webhook then skips what a reopen normally triggers (rollback off done,
 * re-triage, inbox ingest).
 */
export async function askingOnIssue(issueRef: string): Promise<boolean> {
  try {
    const [r] = await db
      .select({ n: sql<number>`1` })
      .from(reporterChecks)
      .where(and(eq(reporterChecks.issueRef, issueRef), inArray(reporterChecks.state, ['asked', 'replied'])));
    return !!r;
  } catch (err) {
    console.warn(`[reporter-check] could not read the check of ${issueRef}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Start a check; a node that already has one keeps it. True when a row was written. */
export async function insertCheck(row: Pick<ReporterCheckRow, 'nodeId' | 'mapId' | 'issueRef' | 'issueUrl' | 'reporter'>): Promise<boolean> {
  const out = await db
    .insert(reporterChecks)
    .values({ ...row, state: 'waiting-deploy' })
    .onConflictDoNothing({ target: reporterChecks.nodeId })
    .returning({ nodeId: reporterChecks.nodeId });
  return out.length > 0;
}

type Patch = Partial<Omit<ReporterCheckRow, 'nodeId' | 'mapId' | 'issueRef' | 'issueUrl' | 'reporter' | 'createdAt'>>;

/**
 * Move a check on only if it is still in one of `from` — the timer, a
 * deploy signal and a person's click can race; the loser gets false and
 * writes nothing to the forge.
 */
export async function updateCheck(nodeId: string, from: ReporterCheckState[], patch: Patch): Promise<boolean> {
  const out = await db
    .update(reporterChecks)
    .set(patch)
    .where(and(eq(reporterChecks.nodeId, nodeId), inArray(reporterChecks.state, from)))
    .returning({ nodeId: reporterChecks.nodeId });
  return out.length > 0;
}

/** Remove a check (a reopened ticket that finishes again starts a new one). */
export async function deleteCheck(nodeId: string): Promise<void> {
  await db.delete(reporterChecks).where(eq(reporterChecks.nodeId, nodeId));
}

/**
 * MindBlown's issue sync must not close this issue while the reporter's
 * check is open. A failed read does not hold: an early close is the
 * lesser harm than an issue MindBlown can never close.
 */
export async function issueCloseHeld(nodeId: string): Promise<boolean> {
  try {
    return await hasOpenCheck(nodeId);
  } catch (err) {
    console.warn(`[reporter-check] could not read the check of ${nodeId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** True while a check holds the issue open: anything but done. */
export async function hasOpenCheck(nodeId: string): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`1` })
    .from(reporterChecks)
    .where(and(eq(reporterChecks.nodeId, nodeId), ne(reporterChecks.state, 'done')));
  return !!r;
}
