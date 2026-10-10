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
 *
 * The close is gated like every other outbound close (#311) — see
 * `gcVerdict`. A row whose issue is still undecided stays in the Trash
 * until it is: hard-deleting it would leave an open issue with no node,
 * which the ingest re-imports as a new todo on the issue's next edit.
 */

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes } from '../db/schema.js';
import { onActiveMap } from '../db/nodes.js';
import type { ExternalLink, LinkedPrState } from '@mindblown/core';
import { isForgeLink, issueCloseAction } from '@mindblown/core';
import {
  closeGitHubIssue,
  getGitHubIssue,
  parseExternalId,
  probeIssueLanded,
  type ForgeClient,
} from '@mindblown/integrations';
import { getGitHubContextForMap } from '../lib/githubContext.js';

export interface TrashGcSummary {
  inspected: number;
  hardDeleted: number;
  githubClosed: number;
  githubFailed: number;
  /** Links whose issue was left as it is: already closed, or another repo than the map's (#311). */
  githubSkipped: number;
  /** Links whose PR has not landed yet: their row stays in the Trash and is retried next run (#311). */
  githubHeld: number;
  errors: string[];
}

/**
 * Run one GC pass.
 *
 * Picks up rows whose `deleted_at < now() - retentionDays`, settles their
 * linked issues through the close gate, then DELETEs the settled rows.
 * A row whose issue is still undecided — a PR in flight on it, a release
 * merge waiting for its forward-port, or a forge call that failed — stays
 * in the Trash and is retried next run: deleting it would leave an open
 * issue with no node at all, which the next edit of the issue re-imports
 * as a fresh todo node (#311). Safe to run repeatedly.
 */
export async function runTrashGc(retentionDays: number): Promise<TrashGcSummary> {
  const summary: TrashGcSummary = {
    inspected: 0,
    hardDeleted: 0,
    githubClosed: 0,
    githubFailed: 0,
    githubSkipped: 0,
    githubHeld: 0,
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
      linkedPr: nodes.linkedPr,
      completedAt: nodes.completedAt,
    })
    .from(nodes)
    // An archived map's trash is left alone too: GC would close issues
    // on the forge, and "archived" promises no outward action at all.
    .where(and(isNotNull(nodes.deletedAt), sql`${nodes.deletedAt} < ${cutoff}`, onActiveMap));

  summary.inspected = rows.length;
  if (rows.length === 0) return summary;

  // Rows whose issue could not be settled this run.
  const keep = new Set<string>();
  const ctxByMap = new Map<string, Awaited<ReturnType<typeof getGitHubContextForMap>> | 'error'>();

  for (const row of rows) {
    const links = ((row.externalLinks as ExternalLink[]) ?? []).filter(
      (l) => isForgeLink(l) && l.syncEnabled,
    );
    if (links.length === 0) continue;

    const mapId = row.mapId as string;
    if (!ctxByMap.has(mapId)) {
      try {
        ctxByMap.set(mapId, await getGitHubContextForMap(mapId));
      } catch (err) {
        ctxByMap.set(mapId, 'error');
        summary.errors.push(`map ${mapId} ghCtx: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ctx = ctxByMap.get(mapId);
    if (ctx === 'error') {
      // No client this run (token mint failed…): retry next run.
      keep.add(row.id);
      continue;
    }
    if (!ctx) continue; // the map is not bound to a forge any more

    const completedAt = row.completedAt ? new Date(row.completedAt as Date).toISOString() : null;
    for (const link of links) {
      try {
        const verdict = await gcVerdict(link, row.linkedPr as LinkedPrState | null, completedAt, ctx);
        if (verdict.kind === 'close') {
          await closeGitHubIssue(link, ctx.forge, verdict.reason);
          summary.githubClosed++;
        } else if (verdict.kind === 'hold') {
          summary.githubHeld++;
          keep.add(row.id);
          console.log(`[trash-gc] ${link.externalId}: kept in Trash — ${verdict.because}`);
        } else {
          summary.githubSkipped++;
          console.log(`[trash-gc] ${link.externalId}: issue left as it is — ${verdict.because}`);
        }
      } catch (err) {
        summary.githubFailed++;
        keep.add(row.id);
        summary.errors.push(`${link.externalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const ids = rows.map((r) => r.id).filter((id) => !keep.has(id));
  if (ids.length > 0) await db.delete(nodes).where(inArray(nodes.id, ids));
  summary.hardDeleted = ids.length;

  return summary;
}

type GcVerdict =
  | { kind: 'close'; reason: 'completed' | 'not_planned' }
  | { kind: 'hold'; because: string }
  | { kind: 'leave'; because: string };

/**
 * What GC may do with one link's issue (#311) — the same decision the
 * live outbound close makes (`issueCloseAction`, core/linkedPr.ts), with
 * not_planned as the "nobody delivered it" outcome instead of a hold:
 *   - merge evidence on the link or a default-branch merge in the mirror →
 *     close as completed (work shipped, even without a Closes ref);
 *   - a PR the gate says has not landed (in flight, or merged to a release
 *     branch) → hold: keep the row, retry next run;
 *   - otherwise ask the forge: already closed → leave its close alone; a
 *     PR in flight the mirror missed → hold; landed → completed; nothing →
 *     not_planned.
 * A link to another repo than the map's is left alone: the map's client
 * speaks for the map's repo only.
 */
async function gcVerdict(
  link: ExternalLink,
  linkedPr: LinkedPrState | null,
  completedAt: string | null,
  ctx: { owner: string; repo: string; forge: ForgeClient },
): Promise<GcVerdict> {
  const parsed = parseExternalId(link.externalId);
  if (!parsed || parsed.owner !== ctx.owner || parsed.repo !== ctx.repo) {
    return { kind: 'leave', because: `not the map's repo (${ctx.owner}/${ctx.repo})` };
  }
  const action = issueCloseAction(linkedPr, link, completedAt);
  if (action.kind === 'hold') return { kind: 'hold', because: `PR not landed (${action.because})` };

  const issue = await getGitHubIssue(parsed.owner, parsed.repo, parsed.issueNumber, ctx.forge);
  if (issue.state === 'closed') return { kind: 'leave', because: 'already closed' };
  if (action.kind === 'close') return { kind: 'close', reason: 'completed' };

  const probe = await probeIssueLanded(parsed.owner, parsed.repo, parsed.issueNumber, ctx.forge);
  if (probe.inFlight) return { kind: 'hold', because: 'a PR is in flight on the forge' };
  return { kind: 'close', reason: probe.landed ? 'completed' : 'not_planned' };
}
