/**
 * Trash garbage collection (#107).
 *
 * Soft-deleted nodes (deleted_at IS NOT NULL) live in the Trash for a
 * retention window so the user can restore them. After the window, this
 * job hard-deletes the rows and — to preserve the pre-#107 UX — closes any
 * linked GitHub issues as `not_planned` at the moment of hard delete.
 *
 * Why GH closure is here and not in the soft-delete path:
 *   The soft-delete UI is reversible. Closing the GH issue eagerly would
 *   require a reopen on restore, which is extra failure surface and
 *   creates noisy issue activity for a user who's just clicking "Undo".
 *   The retention window collapses the "did the user really mean it?"
 *   question — by the time GC runs, the user has had ~30 days to undo,
 *   so the GH closure is on solid ground.
 */

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import type { ExternalLink } from '@mindblown/core';
import { closeGitHubIssue } from '@mindblown/integrations';
import { getGitHubContextForMap } from '../lib/githubContext.js';

export interface TrashGcSummary {
  inspected: number;
  hardDeleted: number;
  githubClosed: number;
  githubFailed: number;
  errors: string[];
}

/**
 * Run one GC pass.
 *
 * Picks up rows whose `deleted_at < now() - retentionDays`, closes their
 * linked GitHub issues (best-effort, fire-and-await), then DELETEs them.
 * Safe to run repeatedly — each tick only sees rows past the cutoff that
 * the previous tick didn't already remove.
 */
export async function runTrashGc(retentionDays: number): Promise<TrashGcSummary> {
  const summary: TrashGcSummary = {
    inspected: 0,
    hardDeleted: 0,
    githubClosed: 0,
    githubFailed: 0,
    errors: [],
  };

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  // Pull full rows so we can read externalLinks + mapId for the GH closure
  // pass. The set is bounded by retentionDays, so volumes stay tiny.
  const rows = await db
    .select({
      id: nodes.id,
      mapId: nodes.mapId,
      externalLinks: nodes.externalLinks,
    })
    .from(nodes)
    .where(and(isNotNull(nodes.deletedAt), sql`${nodes.deletedAt} < ${cutoff}`));

  summary.inspected = rows.length;
  if (rows.length === 0) return summary;

  // Group GH links by mapId so we resolve each map's token once. Skip rows
  // with no GH-syncEnabled link.
  const linksByMap = new Map<string, ExternalLink[]>();
  for (const row of rows) {
    const links = ((row.externalLinks as ExternalLink[]) ?? []).filter(
      (l) => l.provider === 'github' && l.syncEnabled,
    );
    if (links.length === 0) continue;
    const existing = linksByMap.get(row.mapId as string) ?? [];
    existing.push(...links);
    linksByMap.set(row.mapId as string, existing);
  }

  for (const [mapId, links] of linksByMap) {
    let ghCtx;
    try {
      ghCtx = await getGitHubContextForMap(mapId);
    } catch (err) {
      // Token mint failures, etc. Log but keep going — DB hard-delete
      // still proceeds; orphan GH issues are recoverable manually.
      summary.errors.push(`map ${mapId} ghCtx: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!ghCtx) continue;

    for (const link of links) {
      try {
        await closeGitHubIssue(link, ghCtx.token, 'not_planned');
        summary.githubClosed++;
      } catch (err) {
        summary.githubFailed++;
        summary.errors.push(
          `${link.externalId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Hard-delete the rows. We delete after the GH closure pass so a
  // closure failure doesn't strand a row in the Trash forever — the user
  // has already had the full retention window; GH state can be reconciled
  // out-of-band. Per-row failure surfaces in `errors`.
  const ids = rows.map((r) => r.id);
  await db.delete(nodes).where(inArray(nodes.id, ids));
  summary.hardDeleted = ids.length;

  return summary;
}
