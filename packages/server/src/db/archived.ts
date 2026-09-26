/**
 * Archived maps are frozen — the shared check and the error.
 *
 * Lives in its own module because both db/maps.ts and db/nodes.ts need
 * it and maps.ts already imports nodes.ts.
 *
 * Three layers use it, so "archived" means "nothing writes here":
 *   1. middleware/archiveGuard.ts refuses every mutating request on an
 *      archived map with 409 (humans, MCP agents, fleet pushes).
 *   2. Each unattended job (forge catch-up, drift audit, stale-claim
 *      sweep, trash GC, snapshots) filters archived maps out of its
 *      target query, and the cross-map node lookups the webhook
 *      branches use only see nodes on active maps (nodes.onActiveMap).
 *   3. createNode / updateNode / setExternalLinkState throw
 *      MapArchivedError as the backstop for anything the first two miss.
 */
import { eq } from 'drizzle-orm';
import { db } from './connection.js';
import { maps, nodes } from './schema.js';

/** Thrown by DB write paths that reach an archived map. Fastify maps
 *  `statusCode` to the response status when a route lets it escape. */
export class MapArchivedError extends Error {
  readonly statusCode = 409;
  readonly code = 'MAP_ARCHIVED';
  constructor(mapId: string) {
    super(`Map ${mapId} is archived — unarchive it before making changes`);
    this.name = 'MapArchivedError';
  }
}

type Handle = Pick<typeof db, 'select'>;

/**
 * True when the map is archived. A missing map is NOT archived — the
 * caller's own not-found path stays in charge of that (404, FK error).
 */
export async function isMapArchived(mapId: string, handle: Handle = db): Promise<boolean> {
  const [row] = await handle
    .select({ archivedAt: maps.archivedAt })
    .from(maps)
    .where(eq(maps.id, mapId));
  return row?.archivedAt != null;
}

/** Throws MapArchivedError when the map is archived. */
export async function assertMapWritable(mapId: string, handle: Handle = db): Promise<void> {
  if (await isMapArchived(mapId, handle)) throw new MapArchivedError(mapId);
}

/**
 * Same, keyed by node: one joined read. An unknown node passes — the
 * caller's own not-found handling follows.
 */
export async function assertNodeMapWritable(nodeId: string, handle: Handle = db): Promise<void> {
  const [row] = await handle
    .select({ mapId: nodes.mapId, archivedAt: maps.archivedAt })
    .from(nodes)
    .innerJoin(maps, eq(nodes.mapId, maps.id))
    .where(eq(nodes.id, nodeId));
  if (row && row.archivedAt != null) throw new MapArchivedError(row.mapId as string);
}
