/**
 * Ids in the URL are UUIDs — say so instead of crashing on the cast.
 *
 * `GET /api/maps/Loke-Support` (a map name where the id goes) used to reach
 * Postgres, fail with `invalid input syntax for type uuid` and come back as
 * a 500 the caller read as "MindBlown is broken". This hook looks at the
 * matched route's params before anything touches the DB: a uuid-typed
 * param that isn't a UUID is a 404 NOT_FOUND that names the id, says ids
 * are UUIDs and where to list them. Keyed on param names, so a new route
 * with `:mapId` / `:nodeId` / … gets it for free; a bare `:id` is typed
 * by the route's prefix (/api/maps/:id is a map, /api/versions/:id a
 * version, …).
 *
 * The safety net for spots this doesn't see (an id in a body or query):
 * registerInvalidInputErrorHandler turns Postgres 22P02
 * (invalid_text_representation) into a 400 instead of a 500.
 */
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

type Kind = { noun: string; list: (params: Record<string, string>) => string | null };

const mapScoped = (path: string) => (p: Record<string, string>) => {
  const mapId = p.mapId ?? p.id;
  return mapId && isUuid(mapId) ? `GET /api/maps/${mapId}/${path}` : null;
};

const MAP: Kind = { noun: 'map', list: () => 'GET /api/maps' };
const NODE: Kind = { noun: 'node', list: mapScoped('nodes') };
const VERSION: Kind = { noun: 'version', list: () => 'GET /api/versions?mapId=…' };
const CYCLE: Kind = { noun: 'cycle', list: () => 'GET /api/cycles?mapId=…' };
const FLEET: Kind = { noun: 'fleet', list: () => 'GET /api/fleets' };
const COMMENT: Kind = { noun: 'comment', list: () => null };
const DECISION: Kind = { noun: 'triage decision', list: mapScoped('triage-decisions') };
const WEBHOOK: Kind = { noun: 'webhook', list: mapScoped('webhooks') };
const API_KEY: Kind = { noun: 'API key', list: () => 'GET /api/api-keys' };
const PAIRING: Kind = { noun: 'fleet pairing', list: () => null };

/** Named params that are always uuid ids, whatever the route. */
const BY_NAME: Record<string, Kind> = {
  mapId: MAP,
  nodeId: NODE,
  versionId: VERSION,
  cycleId: CYCLE,
  fleetId: FLEET,
  commentId: COMMENT,
  decisionId: DECISION,
  webhookId: WEBHOOK,
};

/** A bare `:id` is typed by the resource right before it. */
const ID_BY_PREFIX: Array<[string, Kind]> = [
  ['/api/maps/:id', MAP],
  ['/api/versions/:id', VERSION],
  ['/api/cycles/:id', CYCLE],
  ['/api/comments/:id', COMMENT],
  ['/api/fleets/:id', FLEET],
  ['/api/api-keys/:id', API_KEY],
  ['/api/fleet-pairings/:id', PAIRING],
];

function kindOf(routeUrl: string, param: string): Kind | null {
  if (param !== 'id') return BY_NAME[param] ?? null;
  for (const [prefix, kind] of ID_BY_PREFIX) {
    if (routeUrl === prefix || routeUrl.startsWith(`${prefix}/`)) return kind;
  }
  return null;
}

/** The first uuid-typed param that isn't a UUID, as the 404 message; null when all are fine. Exported for the unit test. */
export function badIdMessage(req: FastifyRequest): string | null {
  const routeUrl = req.routeOptions?.url;
  if (!routeUrl || !routeUrl.startsWith('/api/')) return null;
  const params = (req.params ?? {}) as Record<string, string>;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    const kind = kindOf(routeUrl, name);
    if (!kind || isUuid(value)) continue;
    const list = kind.list(params);
    return `No ${kind.noun} '${value}' — ${kind.noun} ids are UUIDs${list ? `; list them with ${list}` : ''}`;
  }
  return null;
}

export async function registerUuidParamGuard(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    const message = badIdMessage(req);
    if (message) return reply.status(404).send({ error: { code: 'NOT_FOUND', message } });
  });
}

/** Postgres SQLSTATE of the error or anything in its cause chain (drizzle wraps the pg error). */
function pgCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

function pgMessage(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '22P02') return String((e as { message?: unknown }).message ?? '');
  }
  return '';
}

/**
 * Global error handler: a value Postgres can't parse (22P02 — a non-UUID
 * where a uuid goes, "abc" for an integer) is the caller's mistake, a 400
 * INVALID_INPUT — not a 500. Everything else goes on to Fastify's default
 * handler unchanged.
 */
export function registerInvalidInputErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (pgCode(err) === '22P02') {
      const detail = pgMessage(err);
      req.log.warn({ code: '22P02', detail }, 'invalid input reached the database');
      return reply.status(400).send({
        error: { code: 'INVALID_INPUT', message: `Invalid input${detail ? `: ${detail}` : ''} — ids are UUIDs` },
      });
    }
    throw err;
  });
}
