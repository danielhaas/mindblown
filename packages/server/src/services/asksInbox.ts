/**
 * Asks inbox reads and answer resolution (#479) — shared by the REST routes
 * and the in-app chat backend so the two can't drift.
 *
 * Asks belong to a fleet. A read through a map sees that map's asks; a
 * read of the fleet sees the asks of every connected map the reader can
 * view, plus the fleet-level ones (no map) when the reader owns the fleet
 * or sees all its maps — those are the orchestrator writing about every
 * project, like a tick's prose. A fleet-wide push's meta (counts across
 * projects) is cut the same way.
 */
import { countAsks, derivedAskNodeId, sortAsks } from '@mindblown/core';
import type { AskDocumentMeta, AskRow } from '@mindblown/core';
import * as asksDb from '../db/asks.js';
import * as fleetEntityDb from '../db/fleets.js';
import * as permDb from '../db/permissions.js';
import { getFleetForUser } from './fleets.js';
import { authorizeTickPush, type TelemetryError } from './fleetTelemetry.js';
import { openDerivedAsks, sendBlockersToFleet, type FleetCheckOutcome } from './derivedAsks.js';
import * as nodeDb from '../db/nodes.js';

export interface AskInbox {
  items: AskRow[];
  counts: ReturnType<typeof countAsks>;
  pushedAt: string | null;
  meta: AskDocumentMeta | null;
  /** Which map's push `meta` is from — its counts are that project's; null = a fleet-wide push. */
  pushedFor?: string | null;
  now: string;
  /** Fleet reads: the maps covered — rows name theirs by `mapId`. */
  maps?: { id: string; name: string }[];
}

/**
 * The rows MindBlown adds to the collector's (services/derivedAsks.ts:
 * stalled questions, a person's steps) — open by construction, so only for
 * an open/all read, through the same filters.
 */
async function derivedRows(scope: asksDb.AskScope, mapIds: string[], f: asksDb.AskListFilters): Promise<AskRow[]> {
  const status = f.status ?? 'open';
  if ((status !== 'open' && status !== 'all') || f.since) return [];
  // A side signal: a failed read leaves the collector's questions standing.
  const rows = await openDerivedAsks(scope, mapIds).catch((err) => {
    console.error('[asks] derived asks unavailable', err);
    return [];
  });
  return rows.filter(
    (r) => (!f.hint || r.ask.hint === f.hint) && (!f.answerer || r.ask.answerer.toLowerCase() === f.answerer.toLowerCase()),
  );
}

async function inbox(scope: asksDb.AskScope, filters: asksDb.AskListFilters, full: boolean): Promise<AskInbox> {
  const mapIds = 'mapId' in scope ? [scope.mapId] : scope.visibleMapIds;
  const [rows, push, derived] = await Promise.all([
    asksDb.listAsks(scope, filters),
    asksDb.getPushMeta(scope),
    derivedRows(scope, mapIds, filters),
  ]);
  // A derived row answered once and open again shows its open row, not the old answer's.
  const open = new Set(derived.map((r) => `${r.mapId ?? ''}|${r.ask.id}`));
  const merged = [...rows.filter((r) => r.status !== 'open' || !open.has(`${r.mapId ?? ''}|${r.ask.id}`)), ...derived];
  const sorted = sortAsks(merged);
  const items = filters.limit && filters.limit > 0 ? sorted.slice(0, filters.limit) : sorted;
  const meta: AskDocumentMeta | null = push
    ? push.fleetWide && !full
      ? { generated_at: push.meta.generated_at, tick: push.meta.tick }
      : push.meta
    : null;
  return { items, counts: countAsks(items), pushedAt: push?.pushedAt ?? null, meta, pushedFor: push ? push.mapId : null, now: new Date().toISOString() };
}

/** The map's asks (the caller checked view on the map). A map without a fleet has none. */
export async function mapInbox(userId: string, mapId: string, filters: asksDb.AskListFilters): Promise<AskInbox> {
  const fleetId = await fleetEntityDb.getMapFleetId(mapId);
  if (!fleetId) return { items: [], counts: countAsks([]), pushedAt: null, meta: null, now: new Date().toISOString() };
  const view = await getFleetForUser(userId, fleetId);
  const full = !('status' in view) && (view.isOwner || view.hiddenMapCount === 0);
  return inbox({ fleetId, mapId }, filters, full);
}

/** The fleet's asks as this reader may see them — or why not (404 hides the fleet). */
export async function fleetInbox(userId: string, fleetId: string, filters: asksDb.AskListFilters): Promise<AskInbox | TelemetryError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  const full = view.isOwner || view.hiddenMapCount === 0;
  const scope = { fleetId: view.id, visibleMapIds: view.maps.map((m) => m.id), fleetLevel: full };
  return { ...(await inbox(scope, filters, full)), maps: view.maps.map((m) => ({ id: m.id, name: m.name })) };
}

/**
 * Which row a fleet-route answer means, and may this user answer it?
 * `mapId` picks between rows sharing an ask id ('' = the fleet-level one).
 * The answer writes to the ask's map, so edit there; a fleet-level answer
 * speaks for the whole fleet, so the owner or edit on every map.
 */
export async function resolveFleetAnswer(userId: string, fleetId: string, askId: string, mapId?: string): Promise<asksDb.AskKey | TelemetryError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  const full = view.isOwner || view.hiddenMapCount === 0;
  let rows: Array<{ mapId?: string | null }> = await asksDb.findAsks({ fleetId: view.id, visibleMapIds: view.maps.map((m) => m.id), fleetLevel: full }, askId);
  // A derived row is not stored while open (services/derivedAsks.ts): its node names the map.
  const derivedNode = derivedAskNodeId(askId);
  if (derivedNode && rows.length === 0) {
    const nodeMap = await nodeDb.getNodeMapId(derivedNode);
    if (nodeMap && view.maps.some((m) => m.id === nodeMap)) rows = [{ mapId: nodeMap }];
  }
  if (mapId !== undefined) rows = rows.filter((r) => (r.mapId ?? '') === mapId);
  if (rows.length === 0) return { status: 404, code: 'ASK_NOT_FOUND', message: `Ask ${askId} not found` };
  if (rows.length > 1) {
    const maps = rows.map((r) => r.mapId ?? '(fleet-level)').join(', ');
    return { status: 409, code: 'ASK_AMBIGUOUS', message: `Ask ${askId} exists on several maps (${maps}) — pass mapId ('' for the fleet-level one)` };
  }
  const rowMap = rows[0].mapId ?? null;
  if (rowMap) {
    if (!permDb.hasPermission(await permDb.getPermission(rowMap, userId), 'edit')) {
      return { status: 403, code: 'FORBIDDEN', message: "Edit access to the ask's map required" };
    }
  } else {
    const denied = await authorizeTickPush(userId, view.id);
    if (denied) return denied;
  }
  return { fleetId: view.id, mapId: rowMap, askId };
}

/**
 * "Let the fleet check all blockers" (Your steps): every blocker row on the
 * fleet's maps this user may edit goes to the fleet. Maps they only view
 * are left out, not refused.
 */
export async function fleetCheckBlockers(userId: string, fleetId: string, by: string): Promise<FleetCheckOutcome | TelemetryError> {
  const view = await getFleetForUser(userId, fleetId);
  if ('status' in view) return view;
  const editable: string[] = [];
  for (const m of view.maps) {
    if (permDb.hasPermission(await permDb.getPermission(m.id, userId), 'edit')) editable.push(m.id);
  }
  if (editable.length === 0) return { sent: [], failed: [] };
  return sendBlockersToFleet({ fleetId: view.id, visibleMapIds: editable, fleetLevel: false }, editable, userId, by);
}
