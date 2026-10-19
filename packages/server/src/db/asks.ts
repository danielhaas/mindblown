/**
 * Asks store — the collector's open set per fleet plus the answer state.
 * Keyed by fleet since #479: a row is (fleet, ask id, map) with map null
 * for a fleet-level ask.
 *
 * A push replaces the OPEN set of what it covers — one map's rows when it
 * came through /api/maps/:id/asks, the whole fleet when it came through
 * /api/fleets/:id/asks. Rows the collector no longer sends were resolved
 * elsewhere (ticket closed, node unparked by hand) and vanish; rows already
 * answered/deferred/delegated keep their state while the collector keeps
 * sending them and survive its disappearance for ANSWER_RETENTION_DAYS
 * (the digest of a round must not lose the rows the round itself
 * resolved). The collector is the truth for what is open; MindBlown is the
 * truth for what Dan answered.
 */
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from './connection.js';
import { asks, asksPushes } from './schema.js';
import type { Ask, AskAnswerInput, AskDocumentMeta, AskRow, AskStatus, AskWrite } from '@mindblown/core';

/** Answered rows outlive the question this long — long enough for a weekly digest. */
export const ANSWER_RETENTION_DAYS = 14;

/**
 * Which rows a read returns: one map's (the map route, `mapId`), or the
 * rows of the maps the reader can view plus — for a reader who sees the
 * whole fleet (`fleetLevel`) — the fleet-level rows. Those are the
 * orchestrator writing about all projects, like a tick's prose.
 */
export type AskScope = { fleetId: string; mapId: string } | { fleetId: string; visibleMapIds: string[]; fleetLevel: boolean };

/** One row: an ask id is unique per (fleet, map). */
export interface AskKey {
  fleetId: string;
  mapId: string | null;
  askId: string;
}

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
  /** Pushed to the fleet route — its meta counts every project's questions. */
  fleetWide: boolean;
  /** The map route it came through (its counts are that project's); null = fleet-wide. */
  mapId: string | null;
}

// `map|ask` — a uuid never contains `|`, so the first one splits the pair
// unambiguously whatever the ask id holds. (Postgres text can't carry NUL.)
const keyOf = (askId: string, mapId: string | null) => `${mapId ?? ''}|${askId}`;
const rowKeySql = sql`(coalesce(${asks.mapId}::text, '') || '|' || ${asks.askId})`;

function scopeWhere(scope: AskScope): SQL {
  if ('mapId' in scope) return and(eq(asks.fleetId, scope.fleetId), eq(asks.mapId, scope.mapId))!;
  const parts: SQL[] = [];
  if (scope.visibleMapIds.length > 0) parts.push(inArray(asks.mapId, scope.visibleMapIds));
  if (scope.fleetLevel) parts.push(isNull(asks.mapId));
  if (parts.length === 0) return sql`false`;
  return and(eq(asks.fleetId, scope.fleetId), or(...parts))!;
}

function keyWhere(k: AskKey): SQL {
  return and(eq(asks.fleetId, k.fleetId), k.mapId === null ? isNull(asks.mapId) : eq(asks.mapId, k.mapId), eq(asks.askId, k.askId))!;
}

/**
 * Replace the open set the push covers: `mapId` = one map's rows (every
 * item belongs to it), null = the whole fleet (each item's own map).
 */
export async function replaceAsks(
  fleetId: string,
  mapId: string | null,
  items: Array<{ ask: Ask; mapId: string | null }>,
  meta: AskDocumentMeta,
): Promise<AskPushResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const covered = mapId ? and(eq(asks.fleetId, fleetId), eq(asks.mapId, mapId)) : eq(asks.fleetId, fleetId);
    const keys = items.map((i) => keyOf(i.ask.id, i.mapId));
    // Open rows the collector stopped sending were resolved elsewhere — gone.
    // Answered/deferred/delegated rows stay ANSWER_RETENTION_DAYS after the
    // answer even when the question vanished (the collector drops a question
    // the moment the node is unparked — i.e. right after the answer), so the
    // digest and the fold still show the round; then they are pruned.
    const notSent = keys.length > 0 ? sql`${rowKeySql} NOT IN ${keys}` : sql`true`;
    const gone = await tx
      .delete(asks)
      .where(
        and(
          covered,
          notSent,
          sql`(${asks.status} = 'open' OR ${asks.answeredAt} IS NULL OR ${asks.answeredAt} < now() - make_interval(days => ${ANSWER_RETENTION_DAYS}))`,
        ),
      )
      .returning({ askId: asks.askId });
    const removed = gone.length;
    let kept = 0;
    for (const { ask: a, mapId: itemMap } of items) {
      const [row] = await tx
        .insert(asks)
        .values({ fleetId, mapId: itemMap, askId: a.id, payload: a, pushedAt: now, firstSeenAt: now })
        .onConflictDoUpdate({
          target: [asks.fleetId, asks.askId, asks.mapId],
          set: { payload: a, pushedAt: now },
        })
        .returning({ status: asks.status });
      if (row && row.status !== 'open') kept++;
    }
    await tx
      .insert(asksPushes)
      .values({ fleetId, mapId, pushedAt: now, meta })
      .onConflictDoUpdate({ target: [asksPushes.fleetId, asksPushes.mapId], set: { pushedAt: now, meta } });
    return { pushedAt: now.toISOString(), received: items.length, removed, kept };
  });
}

/**
 * The newest push the scope may see: for a map, its own push or a
 * fleet-wide one; for the fleet, a fleet-wide push or one of a map the
 * reader can view — never another project's map-route push, whose meta
 * names its repo and counts its questions. A fleet-wide push's meta is
 * cut further by the caller for a reader who can't view every map.
 */
export async function getPushMeta(scope: AskScope): Promise<AskPushMeta | null> {
  const mine = 'mapId' in scope ? [scope.mapId] : scope.visibleMapIds;
  const maps = mine.length > 0 ? or(isNull(asksPushes.mapId), inArray(asksPushes.mapId, mine)) : isNull(asksPushes.mapId);
  const [row] = await db
    .select()
    .from(asksPushes)
    .where(and(eq(asksPushes.fleetId, scope.fleetId), maps))
    .orderBy(sql`${asksPushes.pushedAt} desc`)
    .limit(1);
  if (!row) return null;
  return { pushedAt: row.pushedAt.toISOString(), meta: row.meta as AskDocumentMeta, fleetWide: row.mapId === null, mapId: row.mapId };
}

export async function listAsks(scope: AskScope, f: AskListFilters = {}): Promise<AskRow[]> {
  const conds = [scopeWhere(scope)];
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

/**
 * The rows with this ask id in the scope — more than one only when two
 * projects' collectors reused an id and the scope spans both.
 */
export async function findAsks(scope: AskScope, askId: string): Promise<AskRow[]> {
  const rows = await db.select().from(asks).where(and(scopeWhere(scope), eq(asks.askId, askId)));
  return rows.map(toRow);
}

export async function getAsk(k: AskKey): Promise<AskRow | null> {
  const [row] = await db.select().from(asks).where(keyWhere(k));
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

export async function setAnswer(k: AskKey, patch: AskAnswerPatch): Promise<AskRow | null> {
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
    .where(keyWhere(k))
    .returning();
  return row ? toRow(row) : null;
}

/**
 * The fleet acknowledges it delivered the worker notes (claudia-side
 * apply). `mapId` = only that map's rows (the map route); null = every row
 * of the fleet with these ids.
 */
export async function clearWorkerPending(fleetId: string, mapId: string | null, askIds: string[]): Promise<number> {
  if (askIds.length === 0) return 0;
  const scope = mapId ? and(eq(asks.fleetId, fleetId), eq(asks.mapId, mapId)) : eq(asks.fleetId, fleetId);
  const rows = await db
    .update(asks)
    .set({ workerPending: false })
    .where(and(scope, inArray(asks.askId, askIds)))
    .returning({ askId: asks.askId });
  return rows.length;
}

function toRow(r: typeof asks.$inferSelect): AskRow {
  return {
    ask: r.payload as Ask,
    mapId: r.mapId,
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
