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

import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes, maps } from '../db/schema.js';
import { dbNodeToCore } from '../db/helpers.js';
import { notDeleted } from '../db/nodes.js';
import { broadcast } from '../ws.js';
import { resolvedSiblingOrder, isReady, scopeOverlap } from '@mindblown/core';
import type { Node as CoreNode, StatusDef, NodeMap } from '@mindblown/core';
import type {
  ReadyNodesResult,
  ClaimNodeResult,
  ReleaseNodeResult,
  ConflictScanResult,
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

/**
 * Build an `isDone` predicate for a given map's status workflow.
 * Returns a function that returns true when a status string (id OR
 * case-insensitive name) maps to a status with category='done'.
 */
export function buildIsDonePredicate(
  workflow: StatusDef[],
): (status: string | null) => boolean {
  const doneIds = new Set(
    workflow.filter((s) => s.category === 'done').map((s) => s.id),
  );
  const doneNames = new Set(
    workflow.filter((s) => s.category === 'done').map((s) => s.name.toLowerCase()),
  );
  return (status: string | null): boolean => {
    if (!status) return false;
    return doneIds.has(status) || doneNames.has(status.toLowerCase());
  };
}

/** Build the set of status IDs whose category is 'in_progress'. */
export function buildInProgressIds(workflow: StatusDef[]): Set<string> {
  return new Set(
    workflow.filter((s) => s.category === 'in_progress').map((s) => s.id),
  );
}

/** Build the set of status IDs whose category is 'todo'. */
export function buildTodoIds(workflow: StatusDef[]): Set<string> {
  return new Set(
    workflow.filter((s) => s.category === 'todo').map((s) => s.id),
  );
}

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

  // Group by parent → sort each group by resolved sibling order → flatten.
  const byParent = new Map<string | null, CoreNode[]>();
  for (const n of filtered) {
    const key = n.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }
  const sorted: CoreNode[] = [];
  for (const [, siblings] of byParent) {
    sorted.push(...resolvedSiblingOrder(siblings));
  }

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

// ── conflictScan ────────────────────────────────────────────────

export async function conflictScan(
  mapId: string,
  candidateNodeId: string,
): Promise<ConflictScanResult> {
  const [candidateRow] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, candidateNodeId), notDeleted));
  if (!candidateRow) {
    throw new OrchestrationNotFoundError(`Node ${candidateNodeId} not found`);
  }

  const candidate = dbNodeToCore(candidateRow as unknown as Record<string, unknown>);

  if (candidate.scopes.length === 0) {
    return { candidateId: candidateNodeId, candidateScopes: [], conflicts: [] };
  }

  const [mapRow] = await db
    .select({ statusWorkflow: maps.statusWorkflow })
    .from(maps)
    .where(eq(maps.id, mapId));
  const workflow = ((mapRow?.statusWorkflow as StatusDef[]) ?? []);
  const inProgressIds = buildInProgressIds(workflow);

  const allRows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.mapId, mapId), notDeleted));

  const conflicts: ConflictScanResult['conflicts'] = [];
  for (const row of allRows) {
    if ((row.id as string) === candidateNodeId) continue;
    const n = dbNodeToCore(row as unknown as Record<string, unknown>);
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
  };
}
