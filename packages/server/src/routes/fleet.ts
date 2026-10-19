/**
 * Leidang fleet telemetry routes — keyed by fleet since #479.
 *
 *   PUT  /api/fleets/:id/fleet-status/:host  — satellite rollup (v1 or v2)
 *   POST /api/fleets/:id/fleet-ticks         — orchestrator decision
 *   GET  /api/fleets/:id/fleet               — every host and tick of the fleet
 *
 * The map routes the deployed satellites push to keep working and forward
 * to the map's fleet; a push for a map without a fleet is a 409:
 *
 *   PUT  /api/maps/:id/fleet-status/:host  — satellite rollup (rollup.sh, every ~2 min)
 *   POST /api/maps/:id/fleet-ticks         — orchestrator decision (every ~30 min)
 *   GET  /api/maps/:id/fleet               — the map's fleet, hosts narrowed to this map
 *        ?since=<ISO>&until=<ISO>&limit=<n>  — tick history for a window (Verlauf)
 *
 * Auth: the map routes stay like every map route — pushes need edit on the
 * map (#405), the read view. The fleet routes take the fleet owner or edit
 * on a connected map for pushes, the fleet read rule for reads
 * (services/fleetTelemetry.ts). Claims on maps the reader can't view are
 * redacted on every read. The archive guard still lets pushes through on
 * an archived map (inbound reporting, not a plan edit).
 * Payloads are stored verbatim after a minimal shape check; the reading
 * (staleness, dead workers, silent satellites) is core `fleet.ts`,
 * shared with the card.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseRollup, parseTick, parseTickWindow } from '@mindblown/core';
import type { FleetRollup, FleetTickPayload } from '@mindblown/core';
import { guardMapRoutes } from '../lib/mapAccess.js';
import * as telemetry from '../services/fleetTelemetry.js';

/** Hostnames as `hostname -s` / config `host` produce them. The PK is (fleet, host) — no free-form keys. */
const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A 10-worker rollup is ~15 kB; this leaves room for blocked_nodes histories, not for abuse. */
const PUSH_BODY_LIMIT = 256 * 1024;

type Fail = { status: number; code: string; message: string };
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'code' in x;
const send = (reply: FastifyReply, e: Fail) => reply.status(e.status).send({ error: { code: e.code, message: e.message } });
const invalid = (message: string): Fail => ({ status: 400, code: 'VALIDATION_ERROR', message });

/** Shape checks shared by both rollup routes; `mapId` = the map route's id. */
function readRollup(req: FastifyRequest<{ Params: { host: string } }>, mapId: string | null): FleetRollup | Fail {
  if (!HOST_RE.test(req.params.host)) return invalid('host must match [A-Za-z0-9._-]{1,64}');
  const rollup = parseRollup(req.body);
  if (!rollup) return invalid('Body must be a rollup document: host, generated_at (ISO), workers[] (v2: maps[] of map ids)');
  if (rollup.host !== req.params.host) return invalid(`URL host "${req.params.host}" does not match body host "${rollup.host}"`);
  if (mapId && rollup.map_id && rollup.map_id !== mapId) return invalid(`Rollup is for map ${rollup.map_id}, not ${mapId}`);
  if (mapId && rollup.maps && rollup.maps.length > 0 && !rollup.maps.includes(mapId)) {
    return invalid(`Rollup pushed through map ${mapId} does not list it in maps[]`);
  }
  return rollup;
}

/** The decision plus its display timestamp, clamped to now (a wrong orchestrator clock cannot show a tick from the future). */
function readTick(body: unknown): { payload: FleetTickPayload; tickAt: Date } | Fail {
  const payload = parseTick(body);
  if (!payload) return invalid('Body must be a decision object');
  // Display field only (ordering/retention use received_at).
  const now = new Date();
  const raw = (body as { tickAt?: unknown }).tickAt;
  const at = typeof raw === 'string' ? new Date(raw) : now;
  const tickAt = Number.isNaN(at.getTime()) || at.getTime() > now.getTime() ? now : at;
  delete (payload as { tickAt?: unknown }).tickAt;
  return { payload, tickAt };
}

function rollupReply(row: Awaited<ReturnType<typeof telemetry.pushRollup>>, workers: number, fleetId: string) {
  return isFail(row) ? row : { host: row.host, generatedAt: row.generatedAt, receivedAt: row.receivedAt, workers, fleetId, mapIds: row.mapIds };
}

function readReply(read: telemetry.TelemetryRead, window: Exclude<ReturnType<typeof parseTickWindow>, { error: string }>) {
  return {
    fleetId: read.fleetId,
    hosts: read.hosts,
    ticks: read.ticks,
    now: new Date().toISOString(),
    // Echoed so the client knows what it got — a clamped limit or a
    // defaulted one is otherwise invisible in a list of ticks.
    window: { since: window.since?.toISOString() ?? null, until: window.until?.toISOString() ?? null, limit: window.limit },
  };
}

type WindowQuery = { since?: unknown; until?: unknown; limit?: unknown };

/** The deployed satellites' routes, forwarding to the map's fleet. */
export async function fleetRoutes(app: FastifyInstance): Promise<void> {
  // Read: view (#403). Pushes: edit (#405).
  guardMapRoutes(app);

  app.put<{ Params: { id: string; host: string } }>('/api/maps/:id/fleet-status/:host', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    const rollup = readRollup(req, req.params.id);
    if (isFail(rollup)) return send(reply, rollup);
    const fleetId = await telemetry.fleetForMapPush(req.params.id);
    if (isFail(fleetId)) return send(reply, fleetId);
    // The guard checked edit on this map; a v2 rollup may name more.
    if (rollup.maps && rollup.maps.length > 0) {
      const denied = await telemetry.authorizeRollupPush(req.userId!, fleetId, rollup.maps);
      if (denied) return send(reply, denied);
    }
    const out = rollupReply(await telemetry.pushRollup(fleetId, rollup, req.params.id), rollup.workers.length, fleetId);
    return isFail(out) ? send(reply, out) : reply.send(out);
  });

  app.post<{ Params: { id: string } }>('/api/maps/:id/fleet-ticks', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    const tick = readTick(req.body);
    if (isFail(tick)) return send(reply, tick);
    const fleetId = await telemetry.fleetForMapPush(req.params.id);
    if (isFail(fleetId)) return send(reply, fleetId);
    // Every cockpit of the fleet shows the tick, not only this map's.
    const denied = await telemetry.authorizeTickPush(req.userId!, fleetId);
    if (denied) return send(reply, denied);
    const row = await telemetry.pushTick(fleetId, tick.payload, tick.tickAt, req.params.id);
    return reply.status(201).send({ id: row.id, tickAt: row.tickAt, receivedAt: row.receivedAt, fleetId });
  });

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>('/api/maps/:id/fleet', async (req, reply) => {
    // Window rules (defaults, clamp, refusal of garbage) are core's, shared
    // with the chat backend so `fleet_status since=` reads the same on both.
    const window = parseTickWindow(req.query ?? {});
    if ('error' in window) return send(reply, invalid(window.error));
    const scope = await telemetry.mapReadScope(req.userId!, req.params.id);
    const read = 'visible' in scope ? await telemetry.readTelemetry(scope, window, req.params.id) : { fleetId: null, hosts: [], ticks: [] };
    return reply.send(readReply(read, window));
  });
}

/** The fleet's own routes (#479) — what a v2 satellite and the fleet orchestrator push to. */
export async function fleetTelemetryRoutes(app: FastifyInstance): Promise<void> {
  const unauthorized = (reply: FastifyReply) => reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });

  app.put<{ Params: { id: string; host: string } }>('/api/fleets/:id/fleet-status/:host', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const rollup = readRollup(req, null);
    if (isFail(rollup)) return send(reply, rollup);
    // Without maps[] the rollup would serve no map and show on no card.
    if (!rollup.maps || rollup.maps.length === 0) {
      return send(reply, invalid('A rollup pushed to the fleet route names the maps it serves (maps[], v2); a v1 rollup goes to /api/maps/:id/fleet-status/:host'));
    }
    const denied = await telemetry.authorizeRollupPush(req.userId, req.params.id, rollup.maps);
    if (denied) return send(reply, denied);
    const out = rollupReply(await telemetry.pushRollup(req.params.id, rollup, null), rollup.workers.length, req.params.id);
    return isFail(out) ? send(reply, out) : reply.send(out);
  });

  app.post<{ Params: { id: string } }>('/api/fleets/:id/fleet-ticks', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const denied = await telemetry.authorizeTickPush(req.userId, req.params.id);
    if (denied) return send(reply, denied);
    const tick = readTick(req.body);
    if (isFail(tick)) return send(reply, tick);
    const row = await telemetry.pushTick(req.params.id, tick.payload, tick.tickAt, null);
    return reply.status(201).send({ id: row.id, tickAt: row.tickAt, receivedAt: row.receivedAt, fleetId: req.params.id });
  });

  app.get<{ Params: { id: string }; Querystring: WindowQuery }>('/api/fleets/:id/fleet', async (req, reply) => {
    if (!req.userId) return unauthorized(reply);
    const window = parseTickWindow(req.query ?? {});
    if ('error' in window) return send(reply, invalid(window.error));
    const scope = await telemetry.fleetReadScope(req.userId, req.params.id);
    if ('status' in scope) return send(reply, scope);
    return reply.send(readReply(await telemetry.readTelemetry(scope, window), window));
  });
}
