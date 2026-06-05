/**
 * Orchestration substrate routes (#111).
 *
 * Provides 4 new API endpoints that turn MindBlown into a work-queue +
 * soft-conflict detector for parallel Claude coding sessions:
 *
 *   GET  /api/maps/:id/nodes/ready          — ready_nodes
 *   POST /api/maps/:id/nodes/:nodeId/claim  — claim_node
 *   POST /api/maps/:id/nodes/:nodeId/release — release_node
 *   GET  /api/maps/:id/nodes/:nodeId/conflict-scan — conflict_scan
 */

import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { nodes, maps } from '../db/schema.js';
import { dbNodeToCore, dbMapToCore } from '../db/helpers.js';
import { notDeleted } from '../db/nodes.js';
import { broadcast } from '../ws.js';
import { resolvedSiblingOrder, isReady, scopeOverlap } from '@mindblown/core';
import type { Node as CoreNode, StatusDef, NodeMap } from '@mindblown/core';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build an isDone predicate for a given map's status workflow.
 * Returns a function that returns true when a status string (id or name)
 * maps to a status with category='done'.
 */
function buildIsDonePredicate(workflow: StatusDef[]): (status: string | null) => boolean {
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

/**
 * Build a Set of in_progress or todo status IDs for a workflow.
 * Used for conflict scan: "in-flight" = in_progress category OR claimed.
 */
function buildInProgressIds(workflow: StatusDef[]): Set<string> {
  return new Set(
    workflow.filter((s) => s.category === 'in_progress').map((s) => s.id),
  );
}

export async function orchestrationRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/maps/:id/nodes/ready — ready_nodes ─────────────
  // Returns nodes that are ready to be claimed and worked on.
  // A node is "ready" when:
  //   - status maps to a 'todo' category (or status is null)
  //   - claimedBySession is null
  //   - all dependency predecessors (any dep type) have status='done'
  //
  // Query params:
  //   limit: max results (default 10, max 100)
  //   scope: comma-separated scope tags to filter by (at least one must match)
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; scope?: string };
  }>('/api/maps/:id/nodes/ready', async (req, reply) => {
    const mapId = req.params.id;
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit ?? 10)),
    );
    const scopeFilter = req.query.scope
      ? req.query.scope.split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    // Load map for status workflow
    const [mapRow] = await db
      .select()
      .from(maps)
      .where(eq(maps.id, mapId));
    if (!mapRow) {
      return reply.status(404).send({ error: { code: 'MAP_NOT_FOUND', message: `Map ${mapId} not found` } });
    }

    const workflow = ((mapRow.statusWorkflow as StatusDef[]) ?? []);
    const isDone = buildIsDonePredicate(workflow);

    // Collect all live nodes for this map (we need the full set for dep checking)
    const allRows = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.mapId, mapId), notDeleted));

    const allNodes: CoreNode[] = allRows.map((r) => dbNodeToCore(r as unknown as Record<string, unknown>));
    const nodeMap: NodeMap = new Map(allNodes.map((n) => [n.id, n]));

    // Determine which statuses are 'todo' or null (eligible for ready)
    const todoIds = new Set(
      workflow.filter((s) => s.category === 'todo').map((s) => s.id),
    );
    const isTodo = (status: string | null): boolean => {
      if (status === null) return true; // unset status = implicitly todo
      return todoIds.has(status);
    };

    // Filter to todo + unclaimed nodes
    const candidates = allNodes.filter(
      (n) => isTodo(n.status) && n.claimedBySession === null,
    );

    // Apply the isReady predicate (checks all dep predecessors are done)
    const readyNodes = candidates.filter((n) => isReady(n, nodeMap, isDone));

    // Apply optional scope filter: keep only nodes that have at least one
    // matching scope tag from the filter set.
    const filtered = scopeFilter
      ? readyNodes.filter((n) => scopeOverlap(n.scopes, scopeFilter).length > 0)
      : readyNodes;

    // Sort by resolvedSiblingOrder within each parent group, then flatten.
    // Group by parentId → sort each group → stable merge across groups.
    // For a flat map with a single root this degrades gracefully to global
    // priorityRank → priority → createdAt ordering.
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

    return reply.send({
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
    });
  });

  // ── POST /api/maps/:id/nodes/:nodeId/claim — claim_node ──────
  // Sets claimedBySession + claimedAt on a node.
  // Soft-warns (does not block) if already claimed by a different session.
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/claim',
    async (req, reply) => {
      const { nodeId } = req.params;
      const body = req.body as { sessionId: string };

      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' },
        });
      }

      const [row] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), notDeleted));

      if (!row) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` },
        });
      }

      const node = dbNodeToCore(row as unknown as Record<string, unknown>);
      const now = new Date();

      // Build the response — success or soft-warn
      const alreadyClaimed = node.claimedBySession !== null && node.claimedBySession !== body.sessionId;

      const [updated] = await db
        .update(nodes)
        .set({
          claimedBySession: body.sessionId,
          claimedAt: now,
          updatedAt: now,
        })
        .where(and(eq(nodes.id, nodeId), notDeleted))
        .returning();

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` },
        });
      }

      const updatedNode = dbNodeToCore(updated as unknown as Record<string, unknown>);

      broadcast(req.params.id, {
        type: 'node:updated',
        nodeId,
        fields: ['claimedBySession', 'claimedAt'],
        node: updatedNode,
      });

      return reply.status(200).send({
        node: updatedNode,
        claimed: true,
        warned: alreadyClaimed,
        warning: alreadyClaimed
          ? `Node ${nodeId} was already claimed by session "${node.claimedBySession}". Claim transferred to "${body.sessionId}".`
          : undefined,
      });
    },
  );

  // ── POST /api/maps/:id/nodes/:nodeId/release — release_node ──
  // Clears claimedBySession + claimedAt.
  // Rejects if the caller doesn't own the claim.
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/release',
    async (req, reply) => {
      const { nodeId } = req.params;
      const body = req.body as { sessionId: string };

      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'sessionId is required' },
        });
      }

      const [row] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), notDeleted));

      if (!row) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` },
        });
      }

      const node = dbNodeToCore(row as unknown as Record<string, unknown>);

      // Reject if the caller doesn't own the claim.
      if (node.claimedBySession !== null && node.claimedBySession !== body.sessionId) {
        return reply.status(403).send({
          error: {
            code: 'CLAIM_OWNERSHIP_ERROR',
            message: `Node ${nodeId} is claimed by session "${node.claimedBySession}", not "${body.sessionId}". Release rejected.`,
          },
        });
      }

      const now = new Date();
      const [updated] = await db
        .update(nodes)
        .set({
          claimedBySession: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(and(eq(nodes.id, nodeId), notDeleted))
        .returning();

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` },
        });
      }

      const updatedNode = dbNodeToCore(updated as unknown as Record<string, unknown>);

      broadcast(req.params.id, {
        type: 'node:updated',
        nodeId,
        fields: ['claimedBySession', 'claimedAt'],
        node: updatedNode,
      });

      return reply.status(200).send({
        node: updatedNode,
        released: true,
      });
    },
  );

  // ── GET /api/maps/:id/nodes/:nodeId/conflict-scan — conflict_scan ──
  // Returns in-flight nodes whose scopes overlap with the candidate node's
  // scopes. "In-flight" = status has in_progress category OR claimedBySession != null.
  app.get<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/conflict-scan',
    async (req, reply) => {
      const { id: mapId, nodeId } = req.params;

      // Load candidate node
      const [candidateRow] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), notDeleted));

      if (!candidateRow) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${nodeId} not found` },
        });
      }

      const candidate = dbNodeToCore(candidateRow as unknown as Record<string, unknown>);

      if (candidate.scopes.length === 0) {
        // No scopes declared — no conflicts possible
        return reply.send({ candidateId: nodeId, conflicts: [] });
      }

      // Load the map for its status workflow
      const [mapRow] = await db
        .select({ statusWorkflow: maps.statusWorkflow })
        .from(maps)
        .where(eq(maps.id, mapId));

      const workflow = ((mapRow?.statusWorkflow as StatusDef[]) ?? []);
      const inProgressIds = buildInProgressIds(workflow);

      // Find in-flight nodes: in_progress status OR claimed
      // Exclude the candidate itself
      const allRows = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.mapId, mapId), notDeleted));

      const inFlightConflicts: Array<{
        id: string;
        text: string;
        status: string | null;
        claimedBySession: string | null;
        overlappingScopes: string[];
      }> = [];

      for (const row of allRows) {
        if ((row.id as string) === nodeId) continue;

        const n = dbNodeToCore(row as unknown as Record<string, unknown>);

        // Is this node in-flight?
        const isInProgress = n.status !== null && inProgressIds.has(n.status);
        const isClaimed = n.claimedBySession !== null;
        if (!isInProgress && !isClaimed) continue;

        // Check scope overlap
        const overlap = scopeOverlap(candidate.scopes, n.scopes);
        if (overlap.length === 0) continue;

        inFlightConflicts.push({
          id: n.id,
          text: n.text,
          status: n.status,
          claimedBySession: n.claimedBySession,
          overlappingScopes: overlap,
        });
      }

      return reply.send({
        candidateId: nodeId,
        candidateScopes: candidate.scopes,
        conflicts: inFlightConflicts,
      });
    },
  );
}
