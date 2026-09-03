/**
 * Asks store — the collector's open set per map plus the answer state.
 *
 * A push replaces the OPEN set: rows the collector no longer sends were
 * resolved elsewhere (ticket closed, node unparked by hand) and vanish;
 * rows already answered/deferred/delegated keep their state while the
 * collector keeps sending them (it will, until the next tick's map shows
 * the write) and go away with them. The collector is the truth for what
 * is open; MindBlown is the truth for what Dan answered.
 */
import { and, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from './connection.js';
import { asks, asksPushes } from './schema.js';
import type { Ask, AskAnswerInput, AskDocumentMeta, AskRow, AskStatus, AskWrite } from '@mindblown/core';

export interface AskListFilters {
  status?: AskStatus | 'all';
  hint?: string;
  answerer?: string;
  /** Rows answered at/after this ISO timestamp (answered/later/delegated only). */
  since?: string;
  limit?: number;
}

export interface AskPushResult {
  pushedAt: string;
  received: number;
  /** Open rows the collector stopped sending — resolved elsewhere. */
  removed: number;
  /** Rows that keep an answer state from an earlier round. */
  kept: number;
}

export interface AskPushMeta {
  pushedAt: string;
  meta: AskDocumentMeta;
}

export async function replaceAsks(mapId: string, items: Ask[], meta: AskDocumentMeta): Promise<AskPushResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const ids = items.map((a) => a.id);
    let removed = 0;
    if (ids.length > 0) {
      const gone = await tx.delete(asks).where(and(eq(asks.mapId, mapId), notInArray(asks.askId, ids))).returning({ askId: asks.askId });
      removed = gone.length;
    } else {
      const gone = await tx.delete(asks).where(eq(asks.mapId, mapId)).returning({ askId: asks.askId });
      removed = gone.length;
    }
    let kept = 0;
    for (const a of items) {
      const [row] = await tx
        .insert(asks)
        .values({ mapId, askId: a.id, payload: a, pushedAt: now, firstSeenAt: now })
        .onConflictDoUpdate({
          target: [asks.mapId, asks.askId],
          set: { payload: a, pushedAt: now },
        })
        .returning({ status: asks.status });
      if (row && row.status !== 'open') kept++;
    }
    await tx
      .insert(asksPushes)
      .values({ mapId, pushedAt: now, meta })
      .onConflictDoUpdate({ target: asksPushes.mapId, set: { pushedAt: now, meta } });
    return { pushedAt: now.toISOString(), received: items.length, removed, kept };
  });
}

export async function getPushMeta(mapId: string): Promise<AskPushMeta | null> {
  const [row] = await db.select().from(asksPushes).where(eq(asksPushes.mapId, mapId));
  if (!row) return null;
  return { pushedAt: row.pushedAt.toISOString(), meta: row.meta as AskDocumentMeta };
}

export async function listAsks(mapId: string, f: AskListFilters = {}): Promise<AskRow[]> {
  const conds = [eq(asks.mapId, mapId)];
  const status = f.status ?? 'open';
  if (status !== 'all') conds.push(eq(asks.status, status));
  if (f.since) {
    const d = new Date(f.since);
    if (!Number.isNaN(d.getTime())) conds.push(gte(asks.answeredAt, d));
  }
  if (f.hint) conds.push(sql`${asks.payload}->>'hint' = ${f.hint}`);
  if (f.answerer) conds.push(sql`lower(${asks.payload}->>'answerer') = ${f.answerer.toLowerCase()}`);
  let q = db.select().from(asks).where(and(...conds)).$dynamic();
  if (f.limit && f.limit > 0) q = q.limit(f.limit);
  const rows = await q;
  return rows.map(toRow);
}

export async function getAsk(mapId: string, askId: string): Promise<AskRow | null> {
  const [row] = await db.select().from(asks).where(and(eq(asks.mapId, mapId), eq(asks.askId, askId)));
  return row ? toRow(row) : null;
}

export interface AskAnswerPatch {
  status: AskStatus;
  answer: AskAnswerInput;
  answeredBy: string;
  answeredAt: Date;
  writes: AskWrite[];
  workerPending: boolean;
}

export async function setAnswer(mapId: string, askId: string, patch: AskAnswerPatch): Promise<AskRow | null> {
  const [row] = await db
    .update(asks)
    .set({
      status: patch.status,
      answer: patch.answer,
      answeredBy: patch.answeredBy,
      answeredAt: patch.answeredAt,
      writes: patch.writes,
      workerPending: patch.workerPending,
    })
    .where(and(eq(asks.mapId, mapId), eq(asks.askId, askId)))
    .returning();
  return row ? toRow(row) : null;
}

/** The fleet acknowledges it delivered the worker notes (claudia-side apply). */
export async function clearWorkerPending(mapId: string, askIds: string[]): Promise<number> {
  if (askIds.length === 0) return 0;
  const rows = await db
    .update(asks)
    .set({ workerPending: false })
    .where(and(eq(asks.mapId, mapId), inArray(asks.askId, askIds)))
    .returning({ askId: asks.askId });
  return rows.length;
}

function toRow(r: typeof asks.$inferSelect): AskRow {
  return {
    ask: r.payload as Ask,
    status: r.status as AskStatus,
    pushedAt: r.pushedAt.toISOString(),
    firstSeenAt: r.firstSeenAt.toISOString(),
    answer: (r.answer as AskAnswerInput | null) ?? null,
    answeredBy: r.answeredBy,
    answeredAt: r.answeredAt ? r.answeredAt.toISOString() : null,
    writes: (r.writes as AskWrite[]) ?? [],
    workerPending: r.workerPending,
  };
}
