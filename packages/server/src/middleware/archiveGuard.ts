/**
 * Archived maps are frozen.
 *
 * One preHandler, registered right after auth, refuses every mutating
 * request that targets an archived map with 409 MAP_ARCHIVED — human,
 * agent (MCP tools all go through these routes), fleet push or
 * collector alike. Two exceptions, both on the map row itself: the
 * unarchive write (PUT /api/maps/:id with archived:false) and deleting
 * the map. Reads are untouched.
 *
 * The map is resolved from the URL where it is there (/api/maps/:id/…),
 * from the body where the route takes a mapId (POST /api/versions,
 * POST /api/cycles, /api/ai/*), and by lookup for version- and
 * cycle-keyed routes. The forge webhook is not handled here: its
 * branches find nodes by external id, and those lookups exclude
 * archived maps (see db/nodes.ts) with the node-write backstop behind.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as mapDb from '../db/maps.js';
import * as versionDb from '../db/versions.js';
import * as cycleDb from '../db/cycles.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function bodyMapId(req: FastifyRequest): string | null {
  const b = req.body as { mapId?: unknown } | null | undefined;
  return b && typeof b.mapId === 'string' ? b.mapId : null;
}

/**
 * Which map this request would write to, or null when it is not a
 * map write we gate (map create, auth, api keys, media, …).
 * Exported for the unit test.
 */
export async function resolveTargetMapId(req: FastifyRequest): Promise<string | null> {
  const path = req.url.split('?')[0];

  const mapMatch = /^\/api\/maps\/([^/]+)(\/.*)?$/.exec(path);
  if (mapMatch) {
    const [, id, rest] = mapMatch;
    if (id === 'sync') return null; // /api/maps/sync/audit-drift — the job filters per map
    if (!rest) {
      if (req.method === 'DELETE') return null;
      if (req.method === 'PUT') {
        const b = req.body as { archived?: unknown } | null | undefined;
        if (b && b.archived === false) return null;
      }
    }
    return id;
  }

  const versionMatch = /^\/api\/versions(?:\/([^/]+))?(\/.*)?$/.exec(path);
  if (versionMatch) {
    const [, id] = versionMatch;
    if (!id) return bodyMapId(req);
    const v = await versionDb.getVersion(id);
    return v?.mapId ?? null;
  }

  const cycleMatch = /^\/api\/cycles(?:\/([^/]+))?(\/.*)?$/.exec(path);
  if (cycleMatch) {
    const [, id] = cycleMatch;
    if (!id) return bodyMapId(req);
    const c = await cycleDb.getCycle(id);
    return c?.mapId ?? null;
  }

  if (path.startsWith('/api/ai/')) return bodyMapId(req);

  return null;
}

export function archivedReply(reply: FastifyReply, mapId: string): FastifyReply {
  return reply.status(409).send({
    error: {
      code: 'MAP_ARCHIVED',
      message: `Map ${mapId} is archived — nothing changes on it until it is unarchived (PUT /api/maps/${mapId} with {"archived": false})`,
    },
  });
}

export async function registerArchiveGuard(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    const mapId = await resolveTargetMapId(req);
    if (!mapId) return;
    if (await mapDb.isMapArchived(mapId)) return archivedReply(reply, mapId);
  });
}
