/**
 * Is a fleet idle, and what do people hold up? (`waiting_on_humans`, the
 * `fleet.waiting_on_human` webhook.) Gathers the inputs the pure reading
 * in core `waitingOnHumans.ts` needs:
 *
 *   decisions / steps  the open asks (collector rows + MindBlown's derived
 *                      rows, services/asksInbox) — hint decision / ops-task
 *   PRs                fresh rollup claims at phase `pr`, ci `manual`
 *   approvals          proposed tickets not done (services/approvals' list)
 *   idle               countActiveClaims + the fresh hosts' workers
 *
 * PR merges and approvals wait on the map owner (first name), or Dan.
 * A reader sees the maps they can view (the fleet read rule); fleet-level
 * asks only when they own the fleet or see all its maps — like list_asks.
 */
import { inArray, eq } from 'drizzle-orm';
import {
  buildIsDonePredicate,
  fleetIdleState,
  hostFreshness,
  isForgeLink,
  ownerPerson,
  summarizeWaiting,
  waitingItemsFromAsks,
} from '@mindblown/core';
import type { FleetWaitingOnHumans, WaitingItem } from '@mindblown/core';
import { db } from '../db/connection.js';
import { maps, users } from '../db/schema.js';
import * as fleetDb from '../db/fleet.js';
import * as fleetEntityDb from '../db/fleets.js';
import * as mapDb from '../db/maps.js';
import * as nodeDb from '../db/nodes.js';
import { inbox } from './asksInbox.js';
import { getFleetForUser, listFleetsForUser, type FleetAccessError } from './fleets.js';

export interface WaitingScope {
  fleetId: string;
  fleetName: string;
  /** The maps whose items count. */
  mapIds: string[];
  /** Fleet-level asks (no map) count too. */
  fleetLevel: boolean;
}

interface MapInfo {
  person: string;
  repo: string | null;
}

async function mapInfo(mapIds: string[]): Promise<Map<string, MapInfo>> {
  if (mapIds.length === 0) return new Map();
  const rows = await db
    .select({ id: maps.id, owner: users.name, repoOwner: maps.githubRepoOwner, repoName: maps.githubRepoName })
    .from(maps)
    .leftJoin(users, eq(users.id, maps.createdBy))
    .where(inArray(maps.id, mapIds));
  return new Map(rows.map((r) => [r.id, { person: ownerPerson(r.owner), repo: r.repoOwner && r.repoName ? `${r.repoOwner}/${r.repoName}` : null }]));
}

/** `owner/repo#12`: the map's repo, else the repo of the node's forge link. */
function prRef(prNumber: number | null | undefined, repo: string | null, node: { externalLinks?: Array<{ provider: string; externalId: string }> } | null): string {
  const fromLink = node?.externalLinks?.find((l) => isForgeLink(l) && l.externalId.includes('#'))?.externalId.split('#')[0] ?? null;
  const r = repo ?? fromLink;
  const n = prNumber != null ? `#${prNumber}` : '#?';
  return r ? `${r}${n}` : n;
}

/** Everything that waits on a person in this scope, and the fleet's idle state. */
export async function readFleetWaiting(scope: WaitingScope, now: Date = new Date()): Promise<{ summary: FleetWaitingOnHumans; items: WaitingItem[] }> {
  const visible = new Set(scope.mapIds);
  const [askInbox, hosts, activeClaims, info] = await Promise.all([
    inbox({ fleetId: scope.fleetId, visibleMapIds: scope.mapIds, fleetLevel: scope.fleetLevel }, { status: 'open' }, false),
    fleetDb.listRollups(scope.fleetId),
    fleetEntityDb.countActiveClaims(scope.fleetId),
    mapInfo(scope.mapIds),
  ]);
  let items = waitingItemsFromAsks(askInbox.items);

  // PRs a person must merge, from the fresh hosts; a ticket two hosts report counts once.
  const prSeen = new Set<string>();
  for (const h of hosts) {
    if (hostFreshness(h.generatedAt, h.receivedAt, now).stale) continue;
    for (const c of h.rollup.claims ?? []) {
      if (c.phase !== 'pr' || c.ci !== 'manual') continue;
      const mapId = c.mapId ?? (h.mapIds.length === 1 ? h.mapIds[0] : null);
      if (!mapId || !visible.has(mapId) || prSeen.has(c.nodeId)) continue;
      prSeen.add(c.nodeId);
      const node = await nodeDb.getNode(c.nodeId);
      if (node && node.mapId !== mapId) continue;
      const m = info.get(mapId);
      const ref = prRef(c.pr_number, m?.repo ?? null, node);
      items.push({
        kind: 'pr',
        person: m?.person ?? ownerPerson(null),
        ref,
        title: node?.text ?? c.nodeId,
        mapId,
        nodeId: c.nodeId,
        since: c.phase_since ?? null,
        url: node?.externalLinks?.find((l) => l.isPullRequest && l.externalId.endsWith(`#${c.pr_number}`))?.url ?? null,
      });
    }
  }

  // The worker's PR wait note also reads as a blocker step on the same ticket: the PR row says it.
  const asPr = new Set(items.filter((i) => i.kind === 'pr').map((i) => i.nodeId));
  items = items.filter((i) => i.kind !== 'step' || !i.nodeId || !asPr.has(i.nodeId));

  // Proposed tickets not done yet — the same set list_pending_approvals shows.
  const isDone = new Map<string, (status: string | null) => boolean>();
  for (const n of await nodeDb.listProposedNodes(scope.mapIds)) {
    if (!isDone.has(n.mapId)) isDone.set(n.mapId, buildIsDonePredicate((await mapDb.getStatusWorkflow(n.mapId)) ?? []));
    if (n.status === 'done' || n.status === 'cancelled' || isDone.get(n.mapId)!(n.status)) continue;
    items.push({
      kind: 'approval',
      person: info.get(n.mapId)?.person ?? ownerPerson(null),
      ref: n.id,
      title: n.text,
      mapId: n.mapId,
      nodeId: n.id,
      since: n.createdAt,
      url: null,
    });
  }

  const idle = fleetIdleState(hosts, activeClaims, now);
  const { people, total } = summarizeWaiting(items);
  return { summary: { fleetId: scope.fleetId, fleetName: scope.fleetName, ...idle, people, total }, items };
}

/** One fleet (or every fleet the user can see) as this reader may see it. */
export async function waitingOnHumansForUser(userId: string, fleetId?: string): Promise<FleetWaitingOnHumans[] | FleetAccessError> {
  let fleets;
  if (fleetId) {
    const view = await getFleetForUser(userId, fleetId);
    if ('status' in view) return view;
    fleets = [view];
  } else {
    fleets = await listFleetsForUser(userId);
  }
  const out: FleetWaitingOnHumans[] = [];
  for (const f of fleets) {
    const mapIds = f.maps.filter((m) => !m.archivedAt).map((m) => m.id);
    const { summary } = await readFleetWaiting({ fleetId: f.id, fleetName: f.name, mapIds, fleetLevel: f.isOwner || f.hiddenMapCount === 0 });
    out.push(summary);
  }
  return out;
}
