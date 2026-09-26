/**
 * Archived maps: no automated action.
 *
 * Lives in its own module because both db/maps.ts and db/nodes.ts need
 * it and maps.ts already imports nodes.ts.
 *
 * Two layers make "archived" mean "nothing happens here by itself":
 *   1. middleware/archiveGuard.ts refuses every mutating request on an
 *      archived map with 409 unless it comes from a person's browser
 *      session (MCP agents, pull queue, collectors, orchestrators).
 *   2. Each unattended job filters archived maps out of its target
 *      query (forge catch-up, drift audit, stale-claim sweep, trash GC,
 *      snapshots, manual forecast refresh, reopen re-triage), and the
 *      cross-map node lookups the webhook branches use only see nodes
 *      on active maps (nodes.onActiveMap).
 *
 * Deliberately NOT frozen for people: the owner can still open the map,
 * edit by hand, and unarchive it. Triage-decision metadata (an issue's
 * open/closed mirror) keeps syncing too — it is an audit trail of the
 * forge, not an action on the plan.
 *
 * There is no third layer in the node write functions on purpose: they
 * cannot tell a person from a robot, so a backstop there would 500 a
 * person's edit. The accepted residual is the race between a job's
 * target query and its writes when the map is archived in between —
 * one tick, then quiet. Don't re-add the backstop for that.
 */
import { eq } from 'drizzle-orm';
import { db } from './connection.js';
import { maps } from './schema.js';

/**
 * True when the map is archived. A missing map is NOT archived — the
 * caller's own not-found path stays in charge of that (404, FK error).
 */
export async function isMapArchived(mapId: string): Promise<boolean> {
  const [row] = await db
    .select({ archivedAt: maps.archivedAt })
    .from(maps)
    .where(eq(maps.id, mapId));
  return row?.archivedAt != null;
}
