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
 *   - a `:nodeId` that belongs to a different map than the URL's → 404
 *
 * `guardMapRoutes` installs that as a preHandler on a route plugin. It
 * reads the *route pattern* (`req.routeOptions.url`), never the raw URL —
 * a percent-encoded path routes to the same handler but looks different
 * as text — and acts only on routes under `/api/maps/:id` or
 * `/api/maps/:mapId`; anything else in the plugin (a webhook, a list
 * route without a map) is left alone. GET/HEAD need `view`, everything
 * else `edit`, unless the route says otherwise through its config:
 *
 *     app.post('/api/maps/:id/simulate', { config: { mapAccess: 'view' } }, …)
 *     app.get('/api/maps/:id/calendar.ics', { config: { mapAccess: 'public' } }, …)
 *
 * `guardMapIdInPayload` does the same for routes that name the map in the
 * body or query rather than the path (the AI routes): `view` unless the
 * route's config says `edit`. Both hooks are plugin-scoped: Fastify
 * encapsulates hooks added inside a plugin function, so they never leak
 * to siblings.
 *
 * `getPermission` treats the map's creator as admin and reads
 * `map_permissions` for everyone else. The fleet user and every other
 * agent key are members of the maps they act on (checked on prod before
 * this shipped: the fleet user sees every map Dan sees), so agent traffic
 * is unaffected.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as permDb from '../db/permissions.js';

export type MapAccessLevel = permDb.PermissionLevel;

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The level this route needs on its map, overriding the method
     * default (view for GET/HEAD, edit otherwise). `public` skips the
     * guard — for a route with its own credential, like the calendar
     * feed's HMAC token.
     */
    mapAccess?: MapAccessLevel | 'public';
  }
}

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
 * may. Pure decision, no reply: the route hooks, the archive guard and
 * the chat backend all build on it and answer in their own shapes.
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

function sendDenied(reply: FastifyReply, denied: MapAccessDenied): FastifyReply {
  return reply.status(denied.status).send({ error: { code: denied.code, message: denied.message } });
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
  await sendDenied(reply, denied);
  return false;
}

function levelForMethod(method: string): MapAccessLevel {
  return method === 'GET' || method === 'HEAD' ? 'view' : 'edit';
}

/** The one node fact the route guard needs — `nodeDb.getNodeMapId`, passed in so this module stays free of the node layer. */
export type NodeMapLookup = (nodeId: string) => Promise<string | null>;

/** Route patterns the guard acts on, and which param names the map. */
const MAP_ROUTE_PATTERN = /^\/api\/maps\/:(id|mapId)(?:\/|$)/;

/**
 * Guard a route plugin. Every route whose pattern starts with
 * `/api/maps/:id` or `/api/maps/:mapId` needs the caller to hold the
 * route's level on that map; a route whose pattern also carries `:nodeId`
 * is a 404 when that node hangs on another map — the same answer as "no
 * such node", so a guessed id learns nothing. An unknown node passes
 * through: the handler answers its own 404.
 *
 * `nodeMapId` is required as soon as the plugin has a `:nodeId` route;
 * a plugin without one may omit it. Forgetting it is loud (a 500 on the
 * first such request), not a silent pass.
 */
export function guardMapRoutes(app: FastifyInstance, opts: { nodeMapId?: NodeMapLookup } = {}): void {
  app.addHook('preHandler', async (req, reply) => {
    const pattern = req.routeOptions.url ?? '';
    const match = MAP_ROUTE_PATTERN.exec(pattern);
    if (!match) return;
    const configured = req.routeOptions.config?.mapAccess;
    if (configured === 'public') return;

    const params = req.params as Record<string, string | undefined>;
    const mapId = params[match[1]];
    if (!mapId) return;
    const level = configured ?? levelForMethod(req.method);

    const nodeId = pattern.includes(':nodeId') ? params.nodeId : undefined;
    if (nodeId && !opts.nodeMapId) {
      throw new Error(`guardMapRoutes: ${pattern} carries :nodeId but the plugin passed no nodeMapId lookup`);
    }
    // The permission and the node's map are independent facts; ask for
    // both at once. Skipped for an anonymous request, which is a 401
    // without any query.
    const [denied, owner] = await Promise.all([
      checkMapAccess(req.userId, mapId, level),
      req.userId && nodeId && opts.nodeMapId ? opts.nodeMapId(nodeId) : Promise.resolve(null),
    ]);
    if (denied) return sendDenied(reply, denied);
    if (owner && owner !== mapId) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Node ${nodeId} not found` },
      });
    }
  });
}

/**
 * Guard routes that name the map in the body (`mapId`) or the query
 * (`?mapId=`) instead of the path. Every such request needs `view`, or
 * the level the route's config names. A request that names no map passes
 * — the handler's own validation answers 400 where one is required, and
 * some routes (config, ping) take none. A `mapId` that is present but not
 * a string is a 400 here, so no handler ever sees an unchecked one.
 */
export function guardMapIdInPayload(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const configured = req.routeOptions.config?.mapAccess;
    if (configured === 'public') return;
    const body = (req.body ?? {}) as { mapId?: unknown };
    const query = (req.query ?? {}) as { mapId?: unknown };
    const raw = body.mapId ?? query.mapId;
    if (raw == null) return;
    if (typeof raw !== 'string' || !raw) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'mapId must be a string' },
      });
    }
    const denied = await checkMapAccess(req.userId, raw, configured ?? 'view');
    if (denied) return sendDenied(reply, denied);
  });
}
