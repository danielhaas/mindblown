/** Rows of reporter_checks — the reporter's check of a deployed fix (services/reporterCheck.ts). */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ReporterCheckOutcome, ReporterCheckState } from '@mindblown/core';
import { db } from './connection.js';
import { reporterChecks } from './schema.js';

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

/** Every open check, for the timer. */
export async function listAllOpenChecks(): Promise<ReporterCheckRow[]> {
  return (await db.select().from(reporterChecks).where(ne(reporterChecks.state, 'done'))).map(toRow);
}

export async function getCheck(nodeId: string): Promise<ReporterCheckRow | null> {
  const [r] = await db.select().from(reporterChecks).where(eq(reporterChecks.nodeId, nodeId));
  return r ? toRow(r) : null;
}

/** Node ids that already have a row, any state — a ticket is checked once per finish. */
export async function nodesWithCheck(nodeIds: string[]): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await db.select({ nodeId: reporterChecks.nodeId }).from(reporterChecks).where(inArray(reporterChecks.nodeId, nodeIds));
  return new Set(rows.map((r) => r.nodeId));
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
