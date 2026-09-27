/**
 * Map access — the one place that decides whether a request may touch a map.
 *
 * Until #403 the map routes checked membership and the node routes did
 * not: `GET /api/maps/:id` asked `getPermission`, while `PUT
 * /api/maps/:id/nodes/:nodeId` took any node id from anyone. Worse, the
 * map check itself was skipped for a request with no user at all
 * (`if (userId) { … }`), which made every map anonymously readable —
 * probed on prod, 200 without a header. Nothing consumed that leniency:
 * the public-link token has no server route, and every real client (the
 * app, the mobile sheet, agents on API keys, the /mcp loopback) sends a
 * credential.
 *
 * So the rule is now one rule, applied through one helper:
 *
 *   - no user on the request → 401
 *   - user without the level on the map → 403
 *   - a `:nodeId` that belongs to a different map than `:id` → 404
 *
 * `guardMapRoutes` installs that as a preHandler on a route plugin whose
 * routes carry `:id` (and optionally `:nodeId`); GET/HEAD need `view`,
 * everything else `edit`. `guardMapIdInPayload` does the same for routes
 * that name the map in the body or query rather than the path (the AI
 * routes). Both are plugin-scoped: Fastify encapsulates hooks added
 * inside a plugin function, so they never leak to siblings.
 *
 * `getPermission` treats the map's creator as admin and reads
 * `map_permissions` for everyone else; the fleet user and every other
 * agent key are members of the maps they act on, so agent traffic is
 * unaffected — an agent that is *not* a member was already 403'd on the
 * map route and now is on the node routes too.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as permDb from '../db/permissions.js';

export type MapAccessLevel = permDb.PermissionLevel;

export interface MapAccessDenied {
  status: 401 | 403;
  code: 'UNAUTHORIZED' | 'FORBIDDEN';
  message: string;
}

const DENIED_MESSAGE: Record<MapAccessLevel, string> = {
  view: 'You do not have access to this map',
  edit: 'You need edit permission on this map',
  admin: 'You need admin permission on this map',
};

/**
 * Why this user may not act on this map at this level — or null when they
 * may. Pure decision, no reply: the route hook and the chat backend both
 * build on it and answer in their own shapes.
 */
export async function checkMapAccess(
  userId: string | undefined,
  mapId: string,
  level: MapAccessLevel,
): Promise<MapAccessDenied | null> {
  if (!userId) {
    return { status: 401, code: 'UNAUTHORIZED', message: 'Not authenticated' };
  }
  const perm = await permDb.getPermission(mapId, userId);
  if (!permDb.hasPermission(perm, level)) {
    return { status: 403, code: 'FORBIDDEN', message: DENIED_MESSAGE[level] };
  }
  return null;
}

/**
 * Enforce access inside a handler. Sends the 401/403 and answers false
 * when the caller must stop; true when the handler may go on.
 */
export async function requireMapAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  mapId: string,
  level: MapAccessLevel,
): Promise<boolean> {
  const denied = await checkMapAccess(req.userId, mapId, level);
  if (!denied) return true;
  await reply.status(denied.status).send({ error: { code: denied.code, message: denied.message } });
  return false;
}

function levelForMethod(method: string): MapAccessLevel {
  return method === 'GET' || method === 'HEAD' ? 'view' : 'edit';
}

/** The one node fact the route guard needs — `nodeDb.getNodeMapId`, passed in so this module stays free of the node layer. */
export type NodeMapLookup = (nodeId: string) => Promise<string | null>;

/**
 * Guard every route of a plugin whose path carries `:id` (the map) and,
 * where present, `:nodeId`. Reads need `view`, writes `edit`. A node that
 * exists but hangs on another map is a 404 — the same answer as a node
 * that does not exist, so a guessed id learns nothing. An unknown node
 * passes through: the handler answers its own 404.
 */
export function guardMapRoutes(app: FastifyInstance, opts: { nodeMapId: NodeMapLookup }): void {
  app.addHook('preHandler', async (req, reply) => {
    const params = req.params as { id?: string; nodeId?: string };
    if (!params.id) return;
    if (!(await requireMapAccess(req, reply, params.id, levelForMethod(req.method)))) return reply;
    if (params.nodeId) {
      const owner = await opts.nodeMapId(params.nodeId);
      if (owner && owner !== params.id) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Node ${params.nodeId} not found` },
        });
      }
    }
  });
}

/**
 * Guard routes that name the map in the body (`mapId`) or the query
 * (`?mapId=`) instead of the path. Every such request needs `view`; the
 * paths listed in `editPaths` need `edit`. A request that names no map
 * passes — the handler's own validation answers 400 for a missing mapId
 * where one is required, and some routes (config, ping) take none.
 */
export function guardMapIdInPayload(app: FastifyInstance, opts: { editPaths: ReadonlySet<string> }): void {
  app.addHook('preHandler', async (req, reply) => {
    const body = (req.body ?? {}) as { mapId?: unknown };
    const query = (req.query ?? {}) as { mapId?: unknown };
    const mapId = typeof body.mapId === 'string' ? body.mapId : typeof query.mapId === 'string' ? query.mapId : '';
    if (!mapId) return;
    const path = req.url.split('?')[0];
    const level: MapAccessLevel = opts.editPaths.has(path) ? 'edit' : 'view';
    if (!(await requireMapAccess(req, reply, mapId, level))) return reply;
  });
}
