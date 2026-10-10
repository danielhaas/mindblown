/**
 * Triage decision lifecycle (#313): the review queue drains itself.
 *
 * Nothing ever emptied `triage_decisions.reviewed = false` — 1,640+ rows on
 * one map, growing daily, and in practice nobody reviews them (Dan,
 * 10.10.2026). A row that needs no human decision is confirmed here, once a
 * day, on every map that is not archived (an archived map is frozen):
 *
 *   - **foreign** — the row's repo is not the repo the map is bound to. These
 *     are leftovers of the workspace-repo leak fixed in #421 (another
 *     project's issues triaged against this map); there is nothing to decide.
 *   - **skip, settled** — a skip on an issue that is closed, or a skip older
 *     than EXPIRE_DAYS. The model said "not this map" and nobody objected.
 *   - **uncertain on a closed issue with no node** — the question went away
 *     with the issue.
 *   - **place, settled** — the node exists, and the issue is closed or the
 *     placement is older than EXPIRE_DAYS. Moving it is still possible any
 *     time; the queue just stops asking.
 *
 * Confirmed = `reviewed = true`, `reviewed_at = now`, `reviewed_by = NULL`
 * (no person — that is how an auto-confirmation reads in the history). A
 * re-triage of the issue (edited, reopened) upserts the row as unreviewed
 * again, so nothing is lost: the issue comes back if it changes.
 *
 * Not touched: recent placements, place rows whose node never landed (the
 * 23.07.2026 incident class — those are a bug, not a review), uncertain rows
 * that parked a node in the Inbox (the node is the open question), and
 * archived maps.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps, triageDecisions } from '../db/schema.js';

/** A skip on an open issue is settled after this long. */
export const TRIAGE_SKIP_EXPIRE_DAYS = Number(process.env.TRIAGE_SKIP_EXPIRE_DAYS ?? 14);

export interface TriageLifecycleResult {
  foreign: number;
  skipsSettled: number;
  uncertainClosed: number;
  placedSettled: number;
}

export async function runTriageLifecycle(now: Date = new Date()): Promise<TriageLifecycleResult> {
  const cutoff = new Date(now.getTime() - TRIAGE_SKIP_EXPIRE_DAYS * 86_400_000);
  const confirm = { reviewed: true, reviewedAt: now, reviewedBy: null };
  // Pending rows on maps that are not archived.
  const pendingOnLiveMap = and(
    eq(triageDecisions.reviewed, false),
    sql`${triageDecisions.mapId} IN (SELECT ${maps.id} FROM ${maps} WHERE ${maps.archivedAt} IS NULL)`,
  );

  const foreign = await db
    .update(triageDecisions)
    .set(confirm)
    .where(
      and(
        pendingOnLiveMap,
        sql`EXISTS (
          SELECT 1 FROM ${maps}
          WHERE ${maps.id} = ${triageDecisions.mapId}
            AND ${maps.githubRepoOwner} IS NOT NULL AND ${maps.githubRepoName} IS NOT NULL
            AND split_part(${triageDecisions.externalId}, '#', 1) <> ${maps.githubRepoOwner} || '/' || ${maps.githubRepoName}
        )`,
      ),
    )
    .returning({ id: triageDecisions.id });

  const skipsSettled = await db
    .update(triageDecisions)
    .set(confirm)
    .where(
      and(
        pendingOnLiveMap,
        eq(triageDecisions.decision, 'skip'),
        or(eq(triageDecisions.issueState, 'closed'), lt(triageDecisions.decidedAt, cutoff)),
      ),
    )
    .returning({ id: triageDecisions.id });

  const uncertainClosed = await db
    .update(triageDecisions)
    .set(confirm)
    .where(
      and(
        pendingOnLiveMap,
        eq(triageDecisions.decision, 'uncertain'),
        eq(triageDecisions.issueState, 'closed'),
        isNull(triageDecisions.placedNodeId),
      ),
    )
    .returning({ id: triageDecisions.id });

  const placedSettled = await db
    .update(triageDecisions)
    .set(confirm)
    .where(
      and(
        pendingOnLiveMap,
        eq(triageDecisions.decision, 'place'),
        sql`${triageDecisions.placedNodeId} IS NOT NULL`,
        or(eq(triageDecisions.issueState, 'closed'), lt(triageDecisions.decidedAt, cutoff)),
      ),
    )
    .returning({ id: triageDecisions.id });

  return {
    foreign: foreign.length,
    skipsSettled: skipsSettled.length,
    uncertainClosed: uncertainClosed.length,
    placedSettled: placedSettled.length,
  };
}
