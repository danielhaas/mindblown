/**
 * Orchestration substrate service (#111).
 *
 * Shared business logic for the work-queue + soft-conflict detector.
 * Consumed by both the HTTP routes (packages/server/src/routes/orchestration.ts)
 * and the in-app chat backend (packages/server/src/ai/backend.ts) — both
 * surfaces are thin adapters over these functions.
 *
 * Error model: functions throw plain Error with descriptive messages for
 * "not found" cases, and ClaimOwnershipError for the release-by-non-owner
 * case. Callers translate exceptions to their preferred error format
 * (HTTP status codes for the routes, propagated to the LLM for the chat).
 */

import { eq, and, asc, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes, maps, cycles, fleets, users } from '../db/schema.js';
import { dbNodeToCore } from '../db/helpers.js';
import { notDeleted } from '../db/nodes.js';
import { holdsCapSlotSql } from '../db/capSlot.js';
import { broadcast } from '../ws.js';
import * as events from '../db/events.js';
import { getForgeRepoForMap } from '../lib/githubContext.js';
import {
  buildClaimedEvent,
  buildReleasedEvent,
  isReady,
  scopeOverlap,
  buildIsDonePredicate,
  buildInProgressIds,
  buildTodoIds,
  proseMirrorToPlainText,
  effectiveVersionId,
  isBugNode,
  hasBrief,
  matchesDispatchGate,
  pullableNodes,
  dispatchHold,
  approvalHold,
  holdsCapSlot,
  parseMixBugs,
  DEFAULT_DISPATCH_POLICY,
  MIX_BUGS_REGEX,
  NEEDS_BRIEF_TAG,
  FLEET_CHECK_TAG,
  BLOCKED_TAG,
  orderFleetPull,
  advanceFleetPull,
} from '@mindblown/core';
import { isForgeLink } from '@mindblown/core';
import type { Node as CoreNode, StatusDef, NodeMap, ProfilePolicy, EffortUnit, DispatchHold, FleetPullDeficits } from '@mindblown/core';
import type {
  ReadyNodesResult,
  ClaimNodeResult,
  ReleaseNodeResult,
  ConflictScanResult,
  GetNextTicketResult,
  TicketBrief,
  SkippedTicket,
  FleetPullMapOutcome,
} from '@mindblown/tool-kit';

// ── Errors ──────────────────────────────────────────────────────

/** Thrown when release_node is called by a session that doesn't own the claim. */
export class ClaimOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimOwnershipError';
  }
}

/** Thrown when the requested map or node doesn't exist (or was soft-deleted). */
export class OrchestrationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationNotFoundError';
  }
}

// ── Workflow predicate helpers ──────────────────────────────────
//
// `buildIsDonePredicate`, `buildInProgressIds`, and `buildTodoIds`
// moved to `@mindblown/core/statusWorkflow` in #119 so the duplicate
// id-or-name lookup in db/nodes.ts can import the same source of
// truth. Re-exported here for back-compat with existing imports.
export { buildIsDonePredicate, buildInProgressIds, buildTodoIds };

// ── readyNodes ──────────────────────────────────────────────────

/**
 * The developer's queue order (#323): priority first (P0 → P3, unset last),
 * then the manual priorityRank WITHIN a priority, then age. Rank is a
 * sibling-ordering knob (Gantt drag); ranking it above priority across the
 * whole map listed ranked P2 follow-ups above unranked P0 work.
 */
function devQueueOrder(list: CoreNode[]): CoreNode[] {
  return [...list].sort((a, b) => {
    const pa = a.priority !== null ? (PRIORITY_ORDER[a.priority] ?? 4) : 4;
    const pb = b.priority !== null ? (PRIORITY_ORDER[b.priority] ?? 4) : 4;
    if (pa !== pb) return pa - pb;
    const ra = a.priorityRank;
    const rb = b.priorityRank;
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra - rb;
    }
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export async function readyNodes(
  mapId: string,
  /**
   * `sprint` (#323): 'active' (default) = only leaves in the map's active
   * sprint(s) — the node or an ancestor carries the sprint, as in plan_lint;
   * a map without an active sprint falls back to the whole map and says so.
   * 'all' = no sprint filter. Any other value = that sprint's id.
   */
  opts: { limit?: number; scopeFilter?: string[]; sprint?: string } = {},
): Promise<ReadyNodesResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
  const scopeFilter = opts.scopeFilter ?? null;

  const [mapRow] = await db.select().from(maps).where(eq(maps.id, mapId));
  if (!mapRow) throw new OrchestrationNotFoundError(`Map ${mapId} not found`);

  const workflow = ((mapRow.statusWorkflow as StatusDef[]) ?? []);
  const isDone = buildIsDonePredicate(workflow);
  const todoIds = buildTodoIds(workflow);
  const isTodo = (status: string | null): boolean =>
    status === null || todoIds.has(status);

  const allRows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), notDeleted));
  const allNodes: CoreNode[] = allRows.map((r) =>
    dbNodeToCore(r as unknown as Record<string, unknown>),
  );
  const nodeMap: NodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Leaves only (#323): a node with live children is a container — its work
  // is its children, so listing it as pickable handed out whole epics.
  const hasLiveChild = new Set(allNodes.map((n) => n.parentId).filter((p): p is string => p !== null));
  // Tickets held for a person (#266 skip tag, a manual blocker, or no
  // approval yet (#492) — on the ticket or an open ancestor) are not dev
  // work for anyone pulling from a queue — same rule as get_next_ticket.
  const open = allNodes.filter(
    (n) => isTodo(n.status) && n.claimedBySession === null && !hasLiveChild.has(n.id) && n.parentId !== null && isReady(n, nodeMap, isDone),
  );
  const holds = new Map(open.map((n) => [n.id, dispatchHold(n, { nodeMap, isDone })]));
  const ready = open.filter((n) => holds.get(n.id) === null);
  const awaitingApproval = open.flatMap((n) => {
    const hold = holds.get(n.id);
    return hold?.approval ? [{ id: n.id, text: n.text, approval: hold.approval, heldBy: hold.heldBy }] : [];
  });

  const filtered = scopeFilter
    ? ready.filter((n) => scopeOverlap(n.scopes, scopeFilter).length > 0)
    : ready;

  // ── Sprint scope (#323) ──
  const sprintArg = opts.sprint ?? 'active';
  let sprintScope: NonNullable<ReadyNodesResult['sprintScope']>;
  let sprintIds: Set<string> | null = null;
  if (sprintArg === 'all') {
    sprintScope = { mode: 'all', cycles: [] };
  } else {
    const mapCycles = await db
      .select({ id: cycles.id, name: cycles.name, status: cycles.status })
      .from(cycles)
      .where(eq(cycles.mapId, mapId));
    if (sprintArg === 'active') {
      const active = mapCycles.filter((c) => c.status === 'active');
      sprintScope = { mode: 'active', cycles: active.map(({ id, name }) => ({ id, name })) };
      if (active.length > 0) sprintIds = new Set(active.map((c) => c.id));
      else sprintScope.note = 'No active sprint on this map — showing the whole map.';
    } else {
      const c = mapCycles.find((x) => x.id === sprintArg);
      if (!c) throw new OrchestrationNotFoundError(`Sprint ${sprintArg} not found on map ${mapId}`);
      sprintScope = { mode: 'cycle', cycles: [{ id: c.id, name: c.name }] };
      sprintIds = new Set([c.id]);
    }
  }
  const inSprint = (n: CoreNode): boolean => {
    if (sprintIds === null) return true;
    const seen = new Set<string>();
    let cur: CoreNode | undefined = n;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.cycleId != null && sprintIds.has(cur.cycleId)) return true;
      cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined;
    }
    return false;
  };

  const sorted = devQueueOrder(filtered.filter(inSprint));

  // Context for picking (#323): where the leaf sits, and what waits on it.
  const dependentsOf = new Map<string, number>();
  for (const n of allNodes) {
    for (const d of n.dependencies) dependentsOf.set(d.targetNodeId, (dependentsOf.get(d.targetNodeId) ?? 0) + 1);
  }
  const breadcrumbOf = (n: CoreNode): string[] => {
    const path: string[] = [];
    let cur = n.parentId ? nodeMap.get(n.parentId) : undefined;
    while (cur && cur.parentId !== null && path.length < 3) {
      path.unshift(cur.text);
      cur = nodeMap.get(cur.parentId);
    }
    return path;
  };

  const page = sorted.slice(0, limit);
  return {
    mapId,
    ready: page.map((n) => ({
      id: n.id,
      text: n.text,
      status: n.status,
      priority: n.priority,
      priorityRank: n.priorityRank,
      scopes: n.scopes,
      claimedBySession: n.claimedBySession,
      claimedAt: n.claimedAt,
      parentId: n.parentId,
      breadcrumb: breadcrumbOf(n),
      dependents: dependentsOf.get(n.id) ?? 0,
    })),
    total: sorted.length,
    returned: page.length,
    sprintScope,
    awaitingApproval,
  };
}

// ── claimNode ───────────────────────────────────────────────────

export async function claimNode(
  mapId: string,
  nodeId: string,
  sessionId: string,
): Promise<ClaimNodeResult> {
  // #118 issue 4 — race-condition fix. Two concurrent claims by
  // different sessions used to both read pre-state, both report
  // `warned: false`, and both UPDATE (last write wins). Wrap the
  // SELECT + UPDATE in a single transaction with FOR UPDATE so the
  // second tx blocks until the first commits, then observes the
  // first writer's claim and reports `warned: true`.
  const { previousClaim, previousClaimedAt, updatedNode } = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), notDeleted))
      .for('update');
    if (!row) throw new OrchestrationNotFoundError(`Node ${nodeId} not found`);

    const before = dbNodeToCore(row as unknown as Record<string, unknown>);
    const now = new Date();

    const [updatedRow] = await tx
      .update(nodes)
      .set({ claimedBySession: sessionId, claimedAt: now, updatedAt: now })
      .where(and(eq(nodes.id, nodeId), notDeleted))
      .returning();
    if (!updatedRow) throw new OrchestrationNotFoundError(`Node ${nodeId} not found`);

    return {
      previousClaim: before.claimedBySession,
      previousClaimedAt: before.claimedAt,
      updatedNode: dbNodeToCore(updatedRow as unknown as Record<string, unknown>),
    };
  });

  const warned = previousClaim !== null && previousClaim !== sessionId;

  broadcast(mapId, {
    type: 'node:updated',
    nodeId,
    fields: ['claimedBySession', 'claimedAt'],
    node: updatedNode,
  });

  // Claim trail, after commit like the broadcast. A same-session re-claim
  // only refreshes claimedAt and is not a hand-over — no row for it, or a
  // worker's restart loop would flood the node's history.
  if (previousClaim !== sessionId) {
    // Still fire-and-forget, but in order: each write looks the fleet up
    // first (#481), so two unchained writes could land claimed-before-released.
    const released = warned
      ? events
          .recordReleased(
            mapId,
            nodeId,
            null,
            buildReleasedEvent(previousClaim as string, previousClaimedAt, 'transfer', `transferred to ${sessionId}`),
          )
          .catch(() => {})
      : Promise.resolve();
    void released.then(() => events.recordClaimed(mapId, nodeId, null, buildClaimedEvent(sessionId, 'claim', previousClaim))).catch(() => {});
  }

  return {
    node: {
      id: updatedNode.id,
      text: updatedNode.text,
      claimedBySession: updatedNode.claimedBySession,
      claimedAt: updatedNode.claimedAt,
    },
    claimed: true,
    warned,
    warning: warned
      ? `Node ${nodeId} was already claimed by session "${previousClaim}". Claim transferred to "${sessionId}".`
      : undefined,
  };
}

// ── releaseNode ─────────────────────────────────────────────────

export async function releaseNode(
  mapId: string,
  nodeId: string,
  sessionId: string,
  opts: { reason?: string | null } = {},
): Promise<ReleaseNodeResult> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), notDeleted));
  if (!row) throw new OrchestrationNotFoundError(`Node ${nodeId} not found`);

  const node = dbNodeToCore(row as unknown as Record<string, unknown>);

  // Reject if a different session owns the claim.
  if (node.claimedBySession !== null && node.claimedBySession !== sessionId) {
    throw new ClaimOwnershipError(
      `Node ${nodeId} is claimed by session "${node.claimedBySession}", not "${sessionId}". Release rejected.`,
    );
  }

  // #118 issue 5 — when there's nothing to release, say so. The old
  // code returned `released: true` for already-unclaimed nodes which
  // was a misleading no-op. Callers checking `released` to decide
  // whether to log "claim cleared" now have an `alreadyReleased`
  // signal to suppress the noise. No DB write, no broadcast.
  if (node.claimedBySession === null) {
    return {
      node: { id: node.id, text: node.text },
      released: false,
      alreadyReleased: true,
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(nodes)
    .set({ claimedBySession: null, claimedAt: null, updatedAt: now })
    .where(and(eq(nodes.id, nodeId), notDeleted))
    .returning();
  if (!updated) throw new OrchestrationNotFoundError(`Node ${nodeId} not found`);

  const updatedNode = dbNodeToCore(updated as unknown as Record<string, unknown>);

  broadcast(mapId, {
    type: 'node:updated',
    nodeId,
    fields: ['claimedBySession', 'claimedAt'],
    node: updatedNode,
  });

  // The client scripts release for several reasons (never started, dead
  // worker, resize reconcile, blocked.sh) — the free-text reason is the
  // only place that distinction survives.
  events
    .recordReleased(
      mapId,
      nodeId,
      null,
      buildReleasedEvent(sessionId, node.claimedAt, 'release', opts.reason?.trim() || null, now),
    )
    .catch(() => {});

  return {
    node: { id: updatedNode.id, text: updatedNode.text },
    released: true,
  };
}

// ── getNextTicket (Leidang pull queue) ──────────────────────────

// Gate vocabulary, bug detection and the gate predicate live in
// @mindblown/core (dispatch.ts) so the cockpit's Dispatch card applies the
// exact fence the pull applies. Re-exported for existing imports/tests.
export { DEFAULT_DISPATCH_POLICY, NEEDS_BRIEF_TAG, matchesDispatchGate };

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Sort the gated ready set by the map's dispatchPolicy — an ordered list
 * of sort keys, compared left to right: `bugs` (bug-tagged first),
 * `priority` (priorityRank ASC NULLS LAST, then P0–P3), `size` (effort
 * estimate ascending, nulls last), `age` (oldest createdAt first).
 * Ties after all keys fall back to createdAt, then id (stable output).
 *
 * `mix:bugs=<N>` (the one parametric entry, parsed by core's
 * `parseMixBugs`): split the candidates into bugs (`isBugNode`) and
 * non-bugs, sort each class by the REMAINING policy keys, then weave the
 * two deterministically at N:(100−N) with a Bresenham-style running
 * error accumulator — no randomness, no clock, same input ⇒ same output.
 * N=0 is inert: exactly the ordering without the entry (bugs run in the
 * stream normally, NOT last). N=100 = all bugs first, then the non-bugs
 * (equivalent to a leading `bugs` key). When one class drains, the other
 * fills every remaining slot — no holes, no throttling. A `bugs` key
 * left in the policy next to a mix entry is naturally without effect
 * INSIDE the classes (each class is homogeneous in bug-ness); it is
 * tolerated, not rejected. Invalid mix shapes (`mix:bugs=101`,
 * `mix:bugs=x`) never parse and stay inert like any unknown key.
 *
 * `startAcc` injects the persisted weave phase (maps.dispatch_mix_acc):
 * getNextTicket consumes only ranked[0] per pull, so the accumulator must
 * carry over between calls — a per-call restart would make slot 1 a
 * non-bug for every N < 100, i.e. every single-ticket pull a non-bug
 * until the features drain (spec inversion). Default 0 keeps batch
 * consumers (tests, previews) on the pattern's natural start.
 */
export function sortByDispatchPolicy(candidates: CoreNode[], policy: string[], startAcc = 0): CoreNode[] {
  const mix = parseMixBugs(policy);
  // The mix entry is a weave instruction, not a comparator — strip every
  // valid mix-shaped entry before the per-class sort. (Only the FIRST one
  // counts for the ratio; stripping all of them keeps a stray duplicate
  // from reaching the comparator, where it would be inert anyway.)
  const classPolicy = mix === null ? policy : policy.filter((k) => !MIX_BUGS_REGEX.test(k));

  const compareBy = (key: string, a: CoreNode, b: CoreNode): number => {
    switch (key) {
      case 'bugs':
        return Number(isBugNode(b)) - Number(isBugNode(a));
      case 'priority': {
        const ra = a.priorityRank;
        const rb = b.priorityRank;
        if (ra !== null || rb !== null) {
          if (ra === null) return 1;
          if (rb === null) return -1;
          if (ra !== rb) return ra - rb;
        }
        const pa = a.priority !== null ? (PRIORITY_ORDER[a.priority] ?? 4) : 4;
        const pb = b.priority !== null ? (PRIORITY_ORDER[b.priority] ?? 4) : 4;
        return pa - pb;
      }
      case 'size': {
        const ea = a.effortEstimate;
        const eb = b.effortEstimate;
        if (ea === null && eb === null) return 0;
        if (ea === null) return 1;
        if (eb === null) return -1;
        return ea - eb;
      }
      case 'age':
        return a.createdAt.localeCompare(b.createdAt);
      default:
        return 0; // unknown keys are inert — validated at the tool layer
    }
  };
  const byPolicy = (list: CoreNode[]): CoreNode[] =>
    [...list].sort((a, b) => {
      for (const key of classPolicy) {
        const cmp = compareBy(key, a, b);
        if (cmp !== 0) return cmp;
      }
      const byAge = a.createdAt.localeCompare(b.createdAt);
      if (byAge !== 0) return byAge;
      return a.id.localeCompare(b.id);
    });

  // N=0 → the key is inert by contract: today's ordering, bugs in the
  // stream (the weave below would instead drain non-bugs first).
  if (mix === null || mix.ratio === 0) return byPolicy(candidates);

  const bugs = byPolicy(candidates.filter((n) => isBugNode(n)));
  const others = byPolicy(candidates.filter((n) => !isBugNode(n)));

  // Bresenham weave: each slot adds N to the accumulator; crossing 100
  // emits a bug and pays 100 back. N=40 → over any 10 slots a stable
  // 4:6 pattern (slots 3,5,8,10 are bugs); N=100 → a bug every slot.
  const out: CoreNode[] = [];
  let acc = clampMixAcc(startAcc);
  let i = 0;
  let j = 0;
  while (i < bugs.length || j < others.length) {
    if (i >= bugs.length) {
      out.push(others[j++]);
      continue;
    }
    if (j >= others.length) {
      out.push(bugs[i++]);
      continue;
    }
    acc += mix.ratio;
    if (acc >= 100) {
      acc -= 100;
      out.push(bugs[i++]);
    } else {
      out.push(others[j++]);
    }
  }
  return out;
}

// Empty-brief guard lives in core (dispatch.ts) next to the gate predicate;
// re-exported so existing imports keep working.
export { hasBrief };

// ── Persisted weave phase (maps.dispatch_mix_acc) ───────────────

/** The stored weave-phase range is 0–99: one Bresenham period, exclusive
 *  of 100 (a crossing is always paid back in the same step). */
export function clampMixAcc(acc: number): number {
  if (!Number.isFinite(acc)) return 0;
  return Math.max(0, Math.min(99, Math.floor(acc)));
}

/**
 * Advance the persisted weave phase by ONE actual grant.
 *
 * Normal walk: acc += N; a crossing (≥ 100) means this grant was owed to
 * the BUG class and pays 100 back. The caller grants from the owed class
 * whenever it has candidates (ranked[0] of the phase-aware sort), so the
 * two regular cases land back inside 0–99 without clamping.
 *
 * Clamp semantics when the grant came from the OTHER class (owed class
 * empty, or the owed candidate raced away by claim_node):
 * - bug owed, non-bug granted → raw = acc+N ≥ 100, clamped DOWN to 99:
 *   the debt is capped at "one bug owed", so the next arriving bug is
 *   due immediately (99 + N ≥ 100 for every N ≥ 1) instead of the
 *   accumulator running away and later granting a long all-bugs burst.
 * - non-bug owed, bug granted → raw = acc+N−100 < 0, clamped UP to 0:
 *   symmetric — the credit is capped, so the next arriving non-bug is
 *   due immediately (0 + N < 100 for every N ≤ 99) instead of a long
 *   all-features burst.
 *
 * Called only on an actual grant — a claim-race retry inside one pull
 * must not double-count. With no valid mix entry, or N=0, the stored
 * phase is left untouched entirely: 0–99 is ratio-agnostic, so a changed
 * N simply converges from wherever the phase stands (no reset needed).
 */
export function advanceMixAcc(acc: number, ratio: number, grantedBug: boolean): number {
  return clampMixAcc(clampMixAcc(acc) + ratio - (grantedBug ? 100 : 0));
}

/** Puller profiles the routing table recognizes. Anything else = standard. */
export type PullProfile = 'heavy' | 'standard' | 'light';

/** Unknown or absent profile strings fail OPEN to standard (#262). */
export function resolveProfile(profile: string | undefined): PullProfile {
  return profile === 'heavy' || profile === 'light' ? profile : 'standard';
}

/**
 * Profile eligibility filter (#262). Only consulted when the map carries
 * a profilePolicy — a null policy never reaches this function, so the
 * pre-#262 profile-blind behavior is preserved by the caller.
 *
 * Estimates are normalized to hours from the map's effortUnit
 * (`days` × hoursPerDay). On `points` maps the effort triggers are inert
 * (points aren't time): only the P0 heavy trigger applies.
 *
 * - unestimated → eligible to every profile (never starves)
 * - heavy-class (P0 OR ≥ heavyMinHours) → heavy pullers only
 * - light pullers → additionally need ≤ lightMaxHours AND P2/P3
 */
export function isProfileEligible(
  node: CoreNode,
  profile: PullProfile,
  policy: ProfilePolicy,
  effortUnit: EffortUnit,
  hoursPerDay: number,
): boolean {
  if (profile === 'heavy') return true; // heavy takes anything
  if (node.effortEstimate === null) return true; // unestimated routes standard — granted to everyone

  const hours =
    effortUnit === 'hours'
      ? node.effortEstimate
      : effortUnit === 'days'
        ? node.effortEstimate * hoursPerDay
        : null; // points: not a time unit

  const heavyMin = policy.heavyMinHours ?? hoursPerDay; // spec default: one day
  const lightMax = policy.lightMaxHours ?? 2;

  const heavyClass = node.priority === 'P0' || (hours !== null && hours >= heavyMin);
  if (heavyClass) return false; // first refusal: reserved for heavy pullers
  if (profile === 'standard') return true;
  return hours !== null && hours <= lightMax && (node.priority === 'P2' || node.priority === 'P3');
}

interface PullDecision {
  active: number;
  cap: number;
  reason?: 'hold' | 'cap' | 'fleet_cap';
  /** Ranked, gated, dispatchable candidates in claim-attempt order. */
  ranked: CoreNode[];
  /** Ready-but-empty-brief nodes to tag `needs-brief` and report. */
  /** Refused for having no brief — get_next_ticket tags these needs-brief. */
  skipped: CoreNode[];
  /** Refused because a human must act (#266 skip tag or a manual blocker) — reported, never tagged. */
  humanOnly: Array<{ node: CoreNode } & DispatchHold>;
}

/**
 * Pure decision core of getNextTicket: cap gate → dispatch gate →
 * profile eligibility (#262) → policy sort → empty-brief guard. No I/O;
 * the transactional shell applies the claim. Exported for direct unit
 * testing.
 */
export function selectPullCandidates(
  allNodes: CoreNode[],
  opts: {
    workflow: StatusDef[];
    cap: number;
    gate: string[];
    policy: string[];
    /** Profile routing (#262) — all four optional; omitted or a null
     *  profilePolicy keeps the queue profile-blind (pre-#262 behavior). */
    profilePolicy?: ProfilePolicy | null;
    profile?: string;
    effortUnit?: EffortUnit;
    hoursPerDay?: number;
    /** Persisted weave phase (maps.dispatch_mix_acc) so ranked[0] is the
     *  class the mix:bugs pattern actually owes next. Default 0. */
    mixAcc?: number;
    /** The map's fleet has no capacity left (#478) — refused after the map's own hold/cap. */
    fleetFull?: boolean;
  },
): PullDecision {
  const active = allNodes.filter(holdsCapSlot).length;
  const cap = Math.max(0, Math.floor(opts.cap));
  if (cap === 0) return { active, cap, reason: 'hold', ranked: [], skipped: [], humanOnly: [] };
  if (active >= cap) return { active, cap, reason: 'cap', ranked: [], skipped: [], humanOnly: [] };
  if (opts.fleetFull) return { active, cap, reason: 'fleet_cap', ranked: [], skipped: [], humanOnly: [] };

  // Same pullable set the cockpit's Dispatch card renders (core/dispatch.ts):
  // non-root, todo-or-null status, unclaimed, predecessors done.
  const { pullable: ready, nodeMap } = pullableNodes(allNodes, opts.workflow);
  const gatedAll = ready.filter((n) => matchesDispatchGate(n, opts.gate, nodeMap));
  // Held for a person (#266 skip tag, or a manual blocker — on the ticket or
  // an open ancestor): never granted,
  // reported so the queue starves loudly instead of silently — same reason
  // needs-brief is reported.
  const ancestors = { nodeMap, isDone: buildIsDonePredicate(opts.workflow) };
  const humanOnly = gatedAll.flatMap((n) => {
    const hold = dispatchHold(n, ancestors);
    return hold ? [{ node: n, ...hold }] : [];
  });
  const held = new Set(humanOnly.map((h) => h.node.id));
  const gated = gatedAll.filter((n) => !held.has(n.id));
  // Profile routing (#262): a configured policy FILTERS eligibility here;
  // ranking below is untouched. No policy = no filter = pre-#262 behavior.
  const profilePolicy = opts.profilePolicy ?? null;
  const eligible =
    profilePolicy === null
      ? gated
      : gated.filter((n) =>
          isProfileEligible(
            n,
            resolveProfile(opts.profile),
            profilePolicy,
            opts.effortUnit ?? 'days',
            opts.hoursPerDay ?? 8,
          ),
        );
  // The weave runs AFTER the profile-eligibility filter: the mix pattern
  // is woven from what THIS puller may actually be granted, so a filtered
  // ticket can never occupy (and waste) a pattern slot.
  const policy = opts.policy.length > 0 ? opts.policy : DEFAULT_DISPATCH_POLICY;
  const rankedAll = sortByDispatchPolicy(eligible, policy, opts.mixAcc ?? 0);

  // "Fleet can fix it" on a blocker (FLEET_CHECK_TAG): a person sent it, so
  // it goes first — past the gate, the blocker and the status rule; the
  // grant clears blocker and tag and hands the reason over (claimFromMap).
  const isDone = buildIsDonePredicate(opts.workflow);
  // Past everything but the approval gate (#492): a check on work nobody
  // trusted approved would hand an untrusted brief to the fleet.
  const checks = allNodes.filter(
    (n) =>
      n.tags.includes(FLEET_CHECK_TAG) &&
      n.claimedBySession === null &&
      n.childrenIds.length === 0 &&
      n.parentId !== null &&
      !isDone(n.status) &&
      approvalHold(n, ancestors) === null,
  );
  const checkIds = new Set(checks.map((n) => n.id));

  return {
    active,
    cap,
    ranked: [...checks, ...rankedAll.filter((n) => hasBrief(n) && !checkIds.has(n.id))],
    skipped: rankedAll.filter((n) => !hasBrief(n)),
    humanOnly,
  };
}

/**
 * Atomic pull: hand the calling session the next ticket per the map's
 * cap / gate / policy, claiming it in the same transaction.
 *
 * The whole read-decide-claim sequence is serialized per map with
 * `pg_advisory_xact_lock(hashtext(mapId))` — or, when the map belongs to a
 * fleet (#478), with the fleet's lock, so the fleet cap holds across all its
 * maps and across this route and the fleet pull. Traffic is a few pulls per
 * minute, so the lock is free and structurally kills every
 * count-then-claim race between concurrent pulls. `claim_node` bypasses
 * this lock (row-level FOR UPDATE only), so the claim itself is still a
 * conditional UPDATE … WHERE claimed_by_session IS NULL: unlike
 * claim_node's deliberate transfer semantics (orchestrator reclaims),
 * the pull path NEVER steals a claim — if a candidate got claimed in
 * between, we move on to the next one.
 *
 * `profile` (#262): when the map carries a `profilePolicy`, the puller's
 * profile filters which tickets it may be granted (heavy / standard /
 * light — see `isProfileEligible`). Maps without a policy stay
 * profile-blind: the parameter is accepted and ignored, exactly the
 * pre-#262 contract.
 *
 * `mix:bugs=<N>` in the policy: the weave phase (maps.dispatch_mix_acc)
 * is read under the same advisory lock, injected into the ranking so
 * ranked[0] is the class the pattern owes next, and advanced — only on
 * an actual grant, from the winner's real class — in the same
 * transaction as the claim (see `advanceMixAcc`).
 */
export async function getNextTicket(
  mapId: string,
  sessionId: string,
  profile?: string,
): Promise<GetNextTicketResult> {
  const now = new Date();

  const outcome = await db.transaction(async (tx): Promise<PullOutcome> => {
    const mapRow = await lockMapForPull(tx, mapId);

    // A map in a fleet also counts against the fleet cap (#478); the lock
    // above is the fleet's then, so the count is race-free.
    const fleet = mapRow.fleetId ? await loadFleetForPull(tx, mapRow.fleetId) : null;
    const fleetActive = fleet ? await countFleetClaims(tx, fleet.id) : 0;
    const fleetInfo = (active: number) =>
      fleet ? { fleet: { id: fleet.id, name: fleet.name, active, cap: fleet.maxActiveClaims } } : {};

    const ev = await evaluateMapPull(tx, mapRow, profile, now, fleet !== null && isFleetFull(fleet.maxActiveClaims, fleetActive));
    const base = { active: ev.decision.active, cap: ev.decision.cap, skipped: ev.skipped, mapId, mapName: mapRow.name };

    if (ev.decision.reason !== undefined) {
      return {
        result: { granted: false, reason: ev.decision.reason, ...base, ...fleetInfo(fleetActive) },
        tagged: [{ mapId, nodes: ev.tagged }],
        winner: null,
      };
    }
    const claim = await claimFromMap(tx, ev, sessionId, now);
    if (claim) {
      return {
        result: { granted: true, ...base, active: base.active + 1, ticket: claim.ticket, ...fleetInfo(fleetActive + 1) },
        tagged: [{ mapId, nodes: ev.tagged }],
        winner: { mapId, node: claim.winner },
      };
    }
    return {
      result: { granted: false, reason: 'empty', ...base, ...fleetInfo(fleetActive) },
      tagged: [{ mapId, nodes: ev.tagged }],
      winner: null,
    };
  });

  announcePull(outcome, sessionId);
  return withRepo(outcome.result);
}

/**
 * Fleet-wide pull (#478): the next ticket from any map of the fleet the
 * caller may work on (`allowedMapIds` — the caller's layer decides access),
 * narrowed to `mapIds` when the worker declares which projects it serves.
 *
 *   1. Fleet cap: claims across EVERY connected map against
 *      fleets.max_active_claims → `fleet_cap`. 0 = no fleet-wide limit:
 *      the maps' own caps (0 = hold) are the safety.
 *   2. Each candidate map runs its own pipeline unchanged — hold, its own
 *      ceiling, gate, profile routing, policy, brief guards.
 *   3. Between the maps that have a ticket to give, smooth weighted
 *      round-robin by fleet_share (core `orderFleetPull`); the credit is
 *      persisted on the fleet and advanced only on an actual grant, in the
 *      claim's transaction — the dispatch_mix_acc pattern.
 *
 * Serialized by the fleet's advisory lock, the same one a map-route pull on
 * a connected map takes, so the fleet cap holds across both routes.
 */
export async function pullFleetTicket(
  fleetId: string,
  sessionId: string,
  opts: { profile?: string; mapIds?: string[]; allowedMapIds: ReadonlySet<string> },
): Promise<GetNextTicketResult> {
  const now = new Date();

  const outcome = await db.transaction(async (tx): Promise<PullOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${fleetId}))`);
    const fleet = await loadFleetForPull(tx, fleetId);
    if (!fleet) throw new OrchestrationNotFoundError(`Fleet ${fleetId} not found`);

    const connected = await tx.select().from(maps).where(eq(maps.fleetId, fleetId)).orderBy(asc(maps.createdAt));
    const declared = opts.mapIds ? new Set(opts.mapIds) : null;
    // Maps the worker didn't declare, or may not work on, are not part of
    // this pull at all — and not named in the answer.
    const considered = connected.filter((m) => opts.allowedMapIds.has(m.id) && (!declared || declared.has(m.id)));

    const fleetActive = await countFleetClaims(tx, fleetId);
    const fleetInfo = (active: number) => ({ fleet: { id: fleet.id, name: fleet.name, active, cap: fleet.maxActiveClaims } });
    if (isFleetFull(fleet.maxActiveClaims, fleetActive)) {
      return {
        result: { granted: false, reason: 'fleet_cap', active: fleetActive, cap: fleet.maxActiveClaims, skipped: [], ...fleetInfo(fleetActive) },
        tagged: [],
        winner: null,
      };
    }

    const outcomes: FleetPullMapOutcome[] = [];
    const ready: MapPullEval[] = [];
    const tagged: PullOutcome['tagged'] = [];
    const skipped: SkippedTicket[] = [];
    for (const m of considered) {
      if (m.archivedAt) {
        outcomes.push({ mapId: m.id, name: m.name, reason: 'archived' });
        continue;
      }
      const ev = await evaluateMapPull(tx, m, opts.profile, now, false);
      tagged.push({ mapId: m.id, nodes: ev.tagged });
      skipped.push(...ev.skipped.map((s) => ({ ...s, mapId: m.id })));
      const reason = ev.decision.reason ?? (ev.decision.ranked.length === 0 ? 'empty' : null);
      if (reason === null) ready.push(ev);
      else outcomes.push({ mapId: m.id, name: m.name, reason: reason === 'fleet_cap' ? 'cap' : reason });
    }

    const deficits = (fleet.pullDeficits ?? {}) as FleetPullDeficits;
    const eligible = ready.map((ev) => ({ mapId: ev.mapRow.id, share: ev.mapRow.fleetShare, ev }));
    for (const { ev } of orderFleetPull(eligible, deficits)) {
      const claim = await claimFromMap(tx, ev, sessionId, now);
      if (!claim) {
        outcomes.push({ mapId: ev.mapRow.id, name: ev.mapRow.name, reason: 'empty' }); // every candidate raced away
        continue;
      }
      await tx
        .update(fleets)
        .set({ pullDeficits: advanceFleetPull(deficits, eligible, ev.mapRow.id, connected.map((m) => m.id)) })
        .where(eq(fleets.id, fleetId));
      return {
        result: {
          granted: true,
          active: fleetActive + 1,
          cap: fleet.maxActiveClaims,
          ticket: claim.ticket,
          skipped,
          mapId: ev.mapRow.id,
          mapName: ev.mapRow.name,
          ...fleetInfo(fleetActive + 1),
          ...(outcomes.length > 0 ? { maps: outcomes } : {}),
        },
        tagged,
        winner: { mapId: ev.mapRow.id, node: claim.winner },
      };
    }

    // Nothing granted: hold / cap only when every map said so.
    const reasons = new Set(outcomes.map((o) => o.reason));
    const reason: GetNextTicketResult['reason'] =
      outcomes.length > 0 && [...reasons].every((r) => r === 'hold') ? 'hold'
        : outcomes.length > 0 && [...reasons].every((r) => r === 'hold' || r === 'cap') ? 'cap'
          : 'empty';
    return {
      result: { granted: false, reason, active: fleetActive, cap: fleet.maxActiveClaims, skipped, ...fleetInfo(fleetActive), maps: outcomes },
      tagged,
      winner: null,
    };
  });

  announcePull(outcome, sessionId);
  return withRepo(outcome.result);
}

/**
 * A granted ticket carries where its code lives (#507), so a worker needs
 * no per-project config. After the claim's transaction: a forge lookup
 * failing never costs the claim — the worker then sees `repo: null`.
 */
async function withRepo(result: GetNextTicketResult): Promise<GetNextTicketResult> {
  if (!result.granted || !result.mapId) return result;
  try {
    return { ...result, repo: await getForgeRepoForMap(result.mapId) };
  } catch (err) {
    console.warn(`[pull] repo lookup for map ${result.mapId} failed:`, err instanceof Error ? err.message : err);
    return { ...result, repo: null };
  }
}

// ── Pull internals ──────────────────────────────────────────────

type PullTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MapRow = typeof maps.$inferSelect;

interface PullOutcome {
  result: GetNextTicketResult;
  /** Nodes newly tagged needs-brief, per map — broadcast after commit. */
  tagged: Array<{ mapId: string; nodes: CoreNode[] }>;
  winner: { mapId: string; node: CoreNode } | null;
}

interface MapPullEval {
  mapRow: MapRow;
  decision: PullDecision;
  nodeMap: NodeMap;
  skipped: SkippedTicket[];
  tagged: CoreNode[];
}

/**
 * Take the lock every pull counting against the same cap takes: the
 * fleet's when the map has one, else the map's (the pre-#478 key). The map
 * row is re-read under the lock; if the map changed fleets in between, the
 * new key is locked too (xact locks hold until commit, so that's safe).
 */
async function lockMapForPull(tx: PullTx, mapId: string): Promise<MapRow> {
  const locked = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const [peek] = await tx.select({ fleetId: maps.fleetId }).from(maps).where(eq(maps.id, mapId));
    if (!peek) throw new OrchestrationNotFoundError(`Map ${mapId} not found`);
    const key = peek.fleetId ?? mapId;
    if (!locked.has(key)) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
      locked.add(key);
    }
    const [row] = await tx.select().from(maps).where(eq(maps.id, mapId));
    if (!row) throw new OrchestrationNotFoundError(`Map ${mapId} not found`);
    if (locked.has(row.fleetId ?? mapId)) return row;
  }
  throw new Error(`Map ${mapId} changed fleets during the pull; retry`);
}

async function loadFleetForPull(tx: PullTx, fleetId: string) {
  const [row] = await tx.select().from(fleets).where(eq(fleets.id, fleetId));
  return row ?? null;
}

/** A fleet cap of 0 is no fleet-wide limit; each map's own cap still applies. */
function isFleetFull(cap: number, active: number): boolean {
  return cap > 0 && active >= cap;
}

/** Claims across every map of the fleet — what the fleet cap limits (core holdsCapSlot). */
async function countFleetClaims(tx: PullTx, fleetId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .innerJoin(maps, eq(nodes.mapId, maps.id))
    .where(and(eq(maps.fleetId, fleetId), notDeleted, holdsCapSlotSql()));
  return Number(row?.n ?? 0);
}

/**
 * One map's pull decision — its cap, gate, profile, policy and brief guards
 * — plus the needs-brief tagging that makes the queue starve loudly (only
 * written when the tag is new, so repeat pulls stay read-only).
 */
async function evaluateMapPull(
  tx: PullTx,
  mapRow: MapRow,
  profile: string | undefined,
  now: Date,
  fleetFull: boolean,
): Promise<MapPullEval> {
  const allRows = await tx
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapRow.id), notDeleted));
  const allNodes = allRows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));
  const nodeMap: NodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const decision = selectPullCandidates(allNodes, {
    workflow: ((mapRow.statusWorkflow as StatusDef[]) ?? []),
    cap: (mapRow.maxActiveClaims as number) ?? 0,
    gate: ((mapRow.dispatchGate as string[]) ?? []),
    policy: ((mapRow.dispatchPolicy as string[]) ?? []),
    profilePolicy: (mapRow.profilePolicy as ProfilePolicy | null) ?? null,
    profile,
    effortUnit: (mapRow.effortUnit as EffortUnit) ?? 'days',
    hoursPerDay: (mapRow.hoursPerDay as number) ?? 8,
    // Persisted mix:bugs weave phase — read under the pull's advisory
    // lock, advanced in claimFromMap only on an actual grant.
    mixAcc: (mapRow.dispatchMixAcc as number) ?? 0,
    fleetFull,
  });

  const tagged: CoreNode[] = [];
  for (const n of decision.skipped) {
    if (n.tags.includes(NEEDS_BRIEF_TAG)) continue;
    const [row] = await tx
      .update(nodes)
      .set({ tags: [...n.tags, NEEDS_BRIEF_TAG], updatedAt: now })
      .where(and(eq(nodes.id, n.id), notDeleted))
      .returning();
    if (row) tagged.push(dbNodeToCore(row as unknown as Record<string, unknown>));
  }

  const skipped: SkippedTicket[] = [
    ...decision.skipped.map((n) => ({ id: n.id, text: n.text, reason: 'needs-brief' as const })),
    ...decision.humanOnly.map(({ node: n, tag, blockedReason, approval, heldBy }) => ({
      id: n.id,
      text: n.text,
      reason: approval !== null ? ('awaiting-approval' as const) : ('human-only' as const),
      ...(tag !== null ? { tag } : {}),
      ...(blockedReason !== null ? { blockedReason } : {}),
      ...(approval !== null ? { approval } : {}),
      ...(heldBy !== null ? { heldBy } : {}),
    })),
  ];

  return { mapRow, decision, nodeMap, skipped, tagged };
}

/** Claim the first ranked candidate still unclaimed; null when all raced away. */
async function claimFromMap(
  tx: PullTx,
  ev: MapPullEval,
  sessionId: string,
  now: Date,
): Promise<{ winner: CoreNode; ticket: TicketBrief } | null> {
  const mapId = ev.mapRow.id;
  const mixAcc = (ev.mapRow.dispatchMixAcc as number) ?? 0;
  const mix = parseMixBugs((ev.mapRow.dispatchPolicy as string[]) ?? []);

  for (const candidate of ev.decision.ranked) {
    // A check run (FLEET_CHECK_TAG): the claim takes over from the blocker.
    const check = candidate.tags.includes(FLEET_CHECK_TAG) ? { blockedReason: candidate.blockedReason ?? '' } : null;
    const [row] = await tx
      .update(nodes)
      .set({
        claimedBySession: sessionId,
        claimedAt: now,
        updatedAt: now,
        ...(check ? { blockedReason: null, tags: candidate.tags.filter((t) => t !== FLEET_CHECK_TAG && t !== BLOCKED_TAG) } : {}),
      })
      .where(and(eq(nodes.id, candidate.id), notDeleted, isNull(nodes.claimedBySession)))
      .returning();
    if (!row) continue; // claimed out from under us via claim_node — next

    const winner = dbNodeToCore(row as unknown as Record<string, unknown>);

    // Advance the persisted weave phase — only here, on the ACTUAL
    // grant (a raced-away candidate above must not count), inside the
    // claim's transaction, from the winner's REAL class (a race can
    // hand the grant to the other class than ranked[0]'s; advanceMixAcc
    // clamps that case). Inert without a mix entry or at N=0: the
    // stored phase stays untouched, no reset needed. Deliberately no
    // updatedAt / audit write — internal state, not a knob change.
    if (mix !== null && mix.ratio > 0) {
      await tx
        .update(maps)
        .set({ dispatchMixAcc: advanceMixAcc(mixAcc, mix.ratio, isBugNode(winner)) })
        .where(eq(maps.id, mapId));
    }

    const ticket: TicketBrief = {
      id: winner.id,
      mapId,
      text: winner.text,
      // A ticket granted on its title alone (TITLE_BRIEF_MIN_WORDS) carries
      // the title as its brief: the worker prompt reads this field and would
      // otherwise send the agent to a linked issue that does not exist.
      description: proseMirrorToPlainText(winner.description).trim() || (winner.externalLinks.some((l) => isForgeLink(l)) ? '' : winner.text),
      priority: winner.priority,
      priorityRank: winner.priorityRank,
      tags: winner.tags,
      scopes: winner.scopes,
      versionId: effectiveVersionId(winner.id, ev.nodeMap),
      effortEstimate: winner.effortEstimate,
      githubLinks: winner.externalLinks
        .filter((l) => isForgeLink(l))
        .map((l) => ({ externalId: l.externalId, url: l.url })),
      claimedAt: winner.claimedAt,
      ...(check ? { check } : {}),
      ...(winner.approval?.merge === 'pr-only' ? { approval: await prOnlyApproval(tx, winner) } : {}),
    };
    return { winner, ticket };
  }
  return null;
}

/** The names a pr-only worker writes on its PR (claude-fleet#70): who asked, who let it through. */
async function prOnlyApproval(tx: PullTx, node: CoreNode): Promise<NonNullable<TicketBrief['approval']>> {
  const r = node.reportedBy;
  const ids = [r?.kind === 'user' ? r.userId : null, node.approval?.by ?? null].filter((x): x is string => x !== null);
  const names = new Map(
    ids.length === 0
      ? []
      : (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]),
  );
  return {
    merge: 'pr-only',
    reportedBy: !r ? null : r.kind === 'forge' ? r.login : (names.get(r.userId) ?? null),
    approvedBy: node.approval?.by ? (names.get(node.approval.by) ?? null) : null,
  };
}

/** Broadcasts and the claim trail, after commit — mirroring claimNode. */
function announcePull(outcome: PullOutcome, sessionId: string): void {
  for (const { mapId, nodes: tagged } of outcome.tagged) {
    for (const n of tagged) broadcast(mapId, { type: 'node:updated', nodeId: n.id, fields: ['tags'], node: n });
  }
  const w = outcome.winner;
  if (!w) return;
  broadcast(w.mapId, {
    type: 'node:updated',
    nodeId: w.node.id,
    fields: ['claimedBySession', 'claimedAt', 'blockedReason', 'tags'],
    node: w.node,
  });
  // The conditional UPDATE in claimFromMap only succeeds on an unclaimed
  // node, so a pull never has a previous holder.
  events
    .recordClaimed(w.mapId, w.node.id, null, buildClaimedEvent(sessionId, 'pull', null))
    .catch(() => {});
}

// ── conflictScan ────────────────────────────────────────────────

export async function conflictScan(
  mapId: string,
  candidateNodeId?: string,
): Promise<ConflictScanResult> {
  const allRows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), notDeleted));
  const all = allRows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));

  // ── Duplicate GitHub links ──────────────────────────────────────
  // The same issue linked on several nodes falsifies progress rollups
  // and makes status answers contradictory (2026-07-15 cleanup removed
  // 164 such pairs map-wide). Per-candidate scans check the candidate's
  // links; map-wide scans (no candidate) report every duplicated link.
  const byLink = new Map<string, CoreNode[]>();
  for (const n of all) {
    for (const l of n.externalLinks) {
      if (!isForgeLink(l)) continue;
      (byLink.get(l.externalId) ?? byLink.set(l.externalId, []).get(l.externalId)!).push(n);
    }
  }
  const toGroup = (externalId: string, group: CoreNode[]) => ({
    externalId,
    nodes: group.map((n) => ({
      id: n.id,
      text: n.text,
      percentComplete: n.percentComplete,
      hasChildren: n.childrenIds.length > 0,
    })),
  });

  if (candidateNodeId === undefined) {
    const duplicateLinks = [...byLink.entries()]
      .filter(([, group]) => group.length > 1)
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([ext, group]) => toGroup(ext, group));
    return { candidateId: null, candidateScopes: [], conflicts: [], duplicateLinks };
  }

  const candidate = all.find((n) => n.id === candidateNodeId);
  if (!candidate) {
    throw new OrchestrationNotFoundError(`Node ${candidateNodeId} not found`);
  }

  const duplicateLinks = candidate.externalLinks
    .filter((l) => isForgeLink(l))
    .map((l) => [l.externalId, byLink.get(l.externalId) ?? []] as const)
    .filter(([, group]) => group.length > 1)
    .map(([ext, group]) => toGroup(ext, group));

  if (candidate.scopes.length === 0) {
    return { candidateId: candidateNodeId, candidateScopes: [], conflicts: [], duplicateLinks };
  }

  const [mapRow] = await db
    .select({ statusWorkflow: maps.statusWorkflow })
    .from(maps)
    .where(eq(maps.id, mapId));
  const workflow = ((mapRow?.statusWorkflow as StatusDef[]) ?? []);
  const inProgressIds = buildInProgressIds(workflow);

  const conflicts: ConflictScanResult['conflicts'] = [];
  for (const n of all) {
    if (n.id === candidateNodeId) continue;
    const isInProgress = n.status !== null && inProgressIds.has(n.status);
    const isClaimed = n.claimedBySession !== null;
    if (!isInProgress && !isClaimed) continue;

    const overlap = scopeOverlap(candidate.scopes, n.scopes);
    if (overlap.length === 0) continue;

    conflicts.push({
      id: n.id,
      text: n.text,
      status: n.status,
      claimedBySession: n.claimedBySession,
      overlappingScopes: overlap,
    });
  }

  return {
    candidateId: candidateNodeId,
    candidateScopes: candidate.scopes,
    conflicts,
    duplicateLinks,
  };
}
