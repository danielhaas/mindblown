/**
 * Work-start sync: inbound GitHub signals that someone STARTED working
 * on a ticket → flip the linked node into the map's in-progress status.
 *
 * The existing sync only moves status at the END of the lifecycle
 * (issue closed / PR merged → done), so a ticket that is actively being
 * worked looks identical to untouched backlog — on the kanban board it
 * sits in "Unset"/"Todo" until the moment it jumps to "Done".
 *
 * Signals that count as "work started":
 *   - a PR referencing the issue via `Closes #N` is opened / reopened /
 *     marked ready-for-review / pushed to (webhook path)
 *   - the issue is assigned (webhook path)
 *   - catchup backstop: an open issue with assignees (poll path — heals
 *     assignments missed while webhooks were down)
 *
 * Deliberately conservative: only nodes whose status is NULL or resolves
 * to a `todo`-category status are transitioned. Nodes that are done,
 * already in progress (possibly a custom state like "In Review"), or
 * carry an unrecognized status string are left alone. percentComplete
 * is never touched — progress stays owned by the close/reopen sync and
 * the user.
 */

import { eq } from 'drizzle-orm';
import { resolveStatusDef } from '@mindblown/core';
import type { ExternalLink, StatusDef } from '@mindblown/core';

import { db } from '../db/connection.js';
import { nodes, maps } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { broadcast } from '../ws.js';

/**
 * Decide the status to write for a work-start signal, or null for
 * "leave the node alone". Pure — exported for unit tests.
 *
 * Rules:
 *   - percentComplete === 100 → null (done-by-progress; the close sync
 *     owns that state even when `status` lags behind)
 *   - status resolves to a non-`todo` category (in_progress, done) → null
 *   - status is a non-null string the workflow doesn't know → null
 *     (custom value someone set on purpose; don't clobber it)
 *   - otherwise → the map's first in_progress-category status id,
 *     falling back to the literal 'in_progress' when the workflow has
 *     no in_progress entry (matches the reopen-fallback convention in
 *     githubCatchup.computeStateUpdates).
 */
export function computeWorkStartStatus(
  status: string | null,
  percentComplete: number | null,
  workflow: StatusDef[],
): string | null {
  if (percentComplete === 100) return null;
  const def = resolveStatusDef(workflow, status);
  if (status != null && !def) return null;
  if (def && def.category !== 'todo') return null;

  const target = workflow
    .filter((s) => s.category === 'in_progress')
    .sort((a, b) => a.position - b.position)[0];
  return target?.id ?? 'in_progress';
}

interface MatchedNode {
  id: string;
  mapId: string;
  status: string | null;
  percentComplete: number | null;
}

/**
 * Transition every node linked to one of `externalIds` (github
 * `owner/repo#N` keys) into its map's in-progress status, subject to
 * the computeWorkStartStatus guards. Broadcasts `node:updated` with the
 * given `source` for each write. Returns the number of nodes updated.
 *
 * Errors from individual node writes propagate — callers (webhook
 * blocks, catchup) wrap the whole call in try/catch and treat the
 * transition as best-effort.
 */
export async function markWorkStarted(
  externalIds: string[],
  source: string,
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const wanted = new Set(externalIds);

  const rows = await db
    .select({
      id: nodes.id,
      mapId: nodes.mapId,
      status: nodes.status,
      percentComplete: nodes.percentComplete,
      externalLinks: nodes.externalLinks,
    })
    .from(nodes)
    .where(nodeDb.notDeleted);

  const matched: MatchedNode[] = [];
  for (const row of rows) {
    const links = (row.externalLinks as ExternalLink[]) ?? [];
    if (links.some((l) => l.provider === 'github' && l.externalId && wanted.has(l.externalId))) {
      matched.push({
        id: row.id,
        mapId: row.mapId,
        status: (row.status as string | null) ?? null,
        percentComplete: (row.percentComplete as number | null) ?? null,
      });
    }
  }
  if (matched.length === 0) return 0;

  // One workflow lookup per distinct map in the batch.
  const workflows = new Map<string, StatusDef[]>();
  for (const m of matched) {
    if (workflows.has(m.mapId)) continue;
    const [mapRow] = await db
      .select({ statusWorkflow: maps.statusWorkflow })
      .from(maps)
      .where(eq(maps.id, m.mapId));
    workflows.set(m.mapId, (mapRow?.statusWorkflow as StatusDef[]) ?? []);
  }

  let updated = 0;
  for (const m of matched) {
    const next = computeWorkStartStatus(m.status, m.percentComplete, workflows.get(m.mapId) ?? []);
    if (next == null || next === m.status) continue;
    const node = await nodeDb.updateNode(m.id, { status: next });
    if (!node) continue;
    updated += 1;
    broadcast(node.mapId, {
      type: 'node:updated',
      nodeId: m.id,
      fields: ['status'],
      node,
      source,
    });
  }
  return updated;
}
