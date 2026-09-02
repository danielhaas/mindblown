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

import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes, maps } from '../db/schema.js';
import { dbNodeToCore } from '../db/helpers.js';
import { notDeleted } from '../db/nodes.js';
import { broadcast } from '../ws.js';
import {
  resolvedSiblingOrder,
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
  parseMixBugs,
  DEFAULT_DISPATCH_POLICY,
  MIX_BUGS_REGEX,
  NEEDS_BRIEF_TAG,
} from '@mindblown/core';
import type { Node as CoreNode, StatusDef, NodeMap, ProfilePolicy, EffortUnit } from '@mindblown/core';
import type {
  ReadyNodesResult,
  ClaimNodeResult,
  ReleaseNodeResult,
  ConflictScanResult,
  GetNextTicketResult,
  TicketBrief,
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

export async function readyNodes(
  mapId: string,
  opts: { limit?: number; scopeFilter?: string[] } = {},
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

  const candidates = allNodes.filter(
    (n) => isTodo(n.status) && n.claimedBySession === null,
  );
  const ready = candidates.filter((n) => isReady(n, nodeMap, isDone));

  const filtered = scopeFilter
    ? ready.filter((n) => scopeOverlap(n.scopes, scopeFilter).length > 0)
    : ready;

  // Global priorityRank ASC NULLS LAST → priority (P0–P3) → createdAt ASC,
  // exactly what the ready_nodes tool description promises. (Used to group
  // by parent and only order within sibling groups, which made the overall
  // list order depend on Map-iteration order of the parents — doc/impl
  // drift fixed alongside the Leidang pull queue.)
  const sorted = resolvedSiblingOrder(filtered);

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
    })),
    total: sorted.length,
    returned: page.length,
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
  const { previousClaim, updatedNode } = await db.transaction(async (tx) => {
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
 */
export function sortByDispatchPolicy(candidates: CoreNode[], policy: string[]): CoreNode[] {
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
  let acc = 0;
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
  reason?: 'hold' | 'cap';
  /** Ranked, gated, dispatchable candidates in claim-attempt order. */
  ranked: CoreNode[];
  /** Ready-but-empty-brief nodes to tag `needs-brief` and report. */
  skipped: CoreNode[];
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
  },
): PullDecision {
  const active = allNodes.filter((n) => n.claimedBySession !== null).length;
  const cap = Math.max(0, Math.floor(opts.cap));
  if (cap === 0) return { active, cap, reason: 'hold', ranked: [], skipped: [] };
  if (active >= cap) return { active, cap, reason: 'cap', ranked: [], skipped: [] };

  // Same pullable set the cockpit's Dispatch card renders (core/dispatch.ts):
  // non-root, todo-or-null status, unclaimed, predecessors done.
  const { pullable: ready, nodeMap } = pullableNodes(allNodes, opts.workflow);
  const gated = ready.filter((n) => matchesDispatchGate(n, opts.gate, nodeMap));
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
  const policy = opts.policy.length > 0 ? opts.policy : DEFAULT_DISPATCH_POLICY;
  const rankedAll = sortByDispatchPolicy(eligible, policy);

  return {
    active,
    cap,
    ranked: rankedAll.filter(hasBrief),
    skipped: rankedAll.filter((n) => !hasBrief(n)),
  };
}

/**
 * Atomic pull: hand the calling session the next ticket per the map's
 * cap / gate / policy, claiming it in the same transaction.
 *
 * The whole read-decide-claim sequence is serialized per map with
 * `pg_advisory_xact_lock(hashtext(mapId))` — traffic is a few pulls per
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
 */
export async function getNextTicket(
  mapId: string,
  sessionId: string,
  profile?: string,
): Promise<GetNextTicketResult> {
  const now = new Date();

  const { result, taggedNodes, winnerNode } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${mapId}))`);

    const [mapRow] = await tx.select().from(maps).where(eq(maps.id, mapId));
    if (!mapRow) throw new OrchestrationNotFoundError(`Map ${mapId} not found`);

    const allRows = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.mapId, mapId), notDeleted));
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
    });

    // Tag empty-brief nodes `needs-brief` so the queue starves loudly.
    // Only write when the tag is new — repeat pulls stay read-only.
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

    const skipped = decision.skipped.map((n) => ({
      id: n.id,
      text: n.text,
      reason: 'needs-brief' as const,
    }));

    if (decision.reason !== undefined) {
      return {
        result: {
          granted: false as const,
          reason: decision.reason,
          active: decision.active,
          cap: decision.cap,
          skipped,
        },
        taggedNodes: tagged,
        winnerNode: null,
      };
    }

    for (const candidate of decision.ranked) {
      const [row] = await tx
        .update(nodes)
        .set({ claimedBySession: sessionId, claimedAt: now, updatedAt: now })
        .where(and(eq(nodes.id, candidate.id), notDeleted, isNull(nodes.claimedBySession)))
        .returning();
      if (!row) continue; // claimed out from under us via claim_node — next

      const winner = dbNodeToCore(row as unknown as Record<string, unknown>);
      const ticket: TicketBrief = {
        id: winner.id,
        mapId,
        text: winner.text,
        description: proseMirrorToPlainText(winner.description),
        priority: winner.priority,
        priorityRank: winner.priorityRank,
        tags: winner.tags,
        scopes: winner.scopes,
        versionId: effectiveVersionId(winner.id, nodeMap),
        effortEstimate: winner.effortEstimate,
        githubLinks: winner.externalLinks
          .filter((l) => l.provider === 'github')
          .map((l) => ({ externalId: l.externalId, url: l.url })),
        claimedAt: winner.claimedAt,
      };
      return {
        result: {
          granted: true as const,
          active: decision.active + 1,
          cap: decision.cap,
          ticket,
          skipped,
        },
        taggedNodes: tagged,
        winnerNode: winner,
      };
    }

    return {
      result: {
        granted: false as const,
        reason: 'empty' as const,
        active: decision.active,
        cap: decision.cap,
        skipped,
      },
      taggedNodes: tagged,
      winnerNode: null,
    };
  });

  // Broadcasts after commit, mirroring claimNode.
  for (const n of taggedNodes) {
    broadcast(mapId, { type: 'node:updated', nodeId: n.id, fields: ['tags'], node: n });
  }
  if (winnerNode) {
    broadcast(mapId, {
      type: 'node:updated',
      nodeId: winnerNode.id,
      fields: ['claimedBySession', 'claimedAt'],
      node: winnerNode,
    });
  }

  return result;
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
      if (l.provider !== 'github') continue;
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
    .filter((l) => l.provider === 'github')
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
