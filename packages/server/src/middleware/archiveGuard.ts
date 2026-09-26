/**
 * Archived maps: no automated action.
 *
 * One preHandler, registered right after auth. A request that would
 * write to an archived map is refused with 409 MAP_ARCHIVED unless it
 * comes from a person in the browser (`req.actor === 'person'`, i.e. an
 * interactive session JWT — see middleware/auth.ts). Everything else —
 * MCP tool calls (they ride the /mcp loopback JWT, marked
 * `kind: 'loopback'`), API keys, headless tokens, the pull queue, the
 * asks collector, fleet orchestrators, unauthenticated pushes — is
 * turned away. Reads are untouched.
 *
 * Why humans pass: "archived" here means "on hold, nothing happens by
 * itself". The owner can still open the map, fix a title, leave a note,
 * or unarchive it. What must stop is the machinery: issue ingest and
 * triage, dispatch and claims, sprint rollover, housekeeping — see
 * db/archived.ts for the job-side filters that back this hook.
 *
 * Exemptions for non-human callers, all on purpose:
 *   - PUT /api/maps/:id whose body is only `{archived}` (an agent may
 *     unarchive, and re-sending archived:true must stay idempotent).
 *   - DELETE /api/maps/:id.
 *   - Fleet telemetry (fleet-status, fleet-ticks): inbound reporting
 *     about the fleet, not an action on the plan; refusing it would
 *     only make every satellite log a 409 per tick.
 *   - POST …/simulate: a what-if read that happens to be a POST.
 *
 * This hook runs before any route's permission check, so a 409 says
 * "that map is archived", not "you may see it" — never read
 * MAP_ARCHIVED as proof of access.
 *
 * The map is resolved from the URL (/api/maps/:id/…), from the body
 * where the route takes a mapId (POST /api/versions, POST /api/cycles,
 * /api/ai/*), and by lookup for version-, cycle- and comment-keyed
 * routes. The forge webhook is not handled here: its branches find
 * nodes by external id, and those lookups exclude archived maps
 * (nodes.onActiveMap).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as mapDb from '../db/maps.js';
import * as versionDb from '../db/versions.js';
import * as cycleDb from '../db/cycles.js';
import * as commentDb from '../db/comments.js';
import * as nodeDb from '../db/nodes.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Map-scoped sub-paths that are not actions on the plan. */
const EXEMPT_SUBPATH = /^\/(fleet-status(\/|$)|fleet-ticks(\/|$)|simulate$)/;

function bodyMapId(req: FastifyRequest): string | null {
  const b = req.body as { mapId?: unknown } | null | undefined;
  return b && typeof b.mapId === 'string' ? b.mapId : null;
}

/**
 * Which map this request would write to, or null when it is not a
 * map write we gate (map create, auth, api keys, media, exemptions).
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
        const b = req.body as Record<string, unknown> | null | undefined;
        if (b && typeof b === 'object' && typeof b.archived === 'boolean') {
          if (b.archived === false) return null;
          const keys = Object.keys(b);
          if (keys.length === 1) return null; // {archived:true} re-sent: idempotent
        }
      }
      return id;
    }
    if (EXEMPT_SUBPATH.test(rest)) return null;
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

  const commentMatch = /^\/api\/comments\/([^/]+)$/.exec(path);
  if (commentMatch) {
    const c = await commentDb.getComment(commentMatch[1]);
    if (!c) return null;
    const node = await nodeDb.getNode(c.nodeId as string);
    return node?.mapId ?? null;
  }

  if (path.startsWith('/api/ai/')) return bodyMapId(req);

  return null;
}

export function archivedReply(reply: FastifyReply, mapId: string): FastifyReply {
  return reply.status(409).send({
    error: {
      code: 'MAP_ARCHIVED',
      message: `Map ${mapId} is archived — on hold, no automated or agent action until a person unarchives it (PUT /api/maps/${mapId} with {"archived": false})`,
    },
  });
}

export async function registerArchiveGuard(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    if (req.actor === 'person') return; // an interactive session, not a robot on a JWT
    const mapId = await resolveTargetMapId(req);
    if (!mapId) return;
    if (await mapDb.isMapArchived(mapId)) return archivedReply(reply, mapId);
  });
}
