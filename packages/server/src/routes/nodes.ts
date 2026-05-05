import type { FastifyInstance } from 'fastify';
import * as nodeDb from '../db/nodes.js';
import { DependencyValidationError, RevisionConflictError } from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import * as events from '../db/events.js';
import { broadcast } from '../ws.js';
import { scheduleEmbedNode } from '../ai/embeddings.js';
import { updateGitHubIssue, closeGitHubIssue } from '@mindblown/integrations';
import { getGitHubContextForMap } from './integrations.js';
import type { ExternalLink, DependencyType, Node as CoreNode } from '@mindblown/core';

// Fields that should trigger outbound GitHub sync
const SYNC_FIELDS = new Set([
  'text', 'description', 'percentComplete', 'status', 'tags', 'priority',
]);

/**
 * Fire-and-forget outbound sync to GitHub for linked nodes.
 * Runs async — does not block the API response.
 *
 * Pushes: title, body, state (open/closed), labels.
 */
async function syncNodeToGitHub(node: CoreNode, changedFields: string[]): Promise<void> {
  // Only sync if relevant fields changed
  if (!changedFields.some((f) => SYNC_FIELDS.has(f))) return;

  // Find GitHub links with sync enabled
  const githubLinks = node.externalLinks.filter(
    (l) => l.provider === 'github' && l.syncEnabled,
  );
  if (githubLinks.length === 0) return;

  // Resolve the map's GitHub context (App token preferred, PAT fallback).
  const ghCtx = await getGitHubContextForMap(node.mapId);
  if (!ghCtx) return;

  for (const link of githubLinks) {
    try {
      await updateGitHubIssue(node, link, ghCtx.token);
      // Update lastSyncedAt on the link
      const updatedLinks = node.externalLinks.map((l) =>
        l.provider === link.provider && l.externalId === link.externalId
          ? { ...l, lastSyncedAt: new Date().toISOString() }
          : l,
      );
      await nodeDb.updateNode(node.id, { externalLinks: updatedLinks });
    } catch (err) {
      // Log but don't fail — outbound sync is best-effort
      console.error(`[github-sync] Failed to sync node ${node.id} → ${link.externalId}:`, err);
    }
  }
}

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/maps/:id/nodes — Create a node ─────────────────
  app.post<{ Params: { id: string } }>('/api/maps/:id/nodes', async (req, reply) => {
    const body = req.body as {
      parentId: string;
      text: string;
      createdBy?: string;
      position?: number;
      x?: number;
      y?: number;
      effortEstimate?: number;
      percentComplete?: number;
      status?: string;
      priority?: 'P0' | 'P1' | 'P2' | 'P3';
      startDate?: string;
      dueDate?: string;
    };
    const userId = req.userId ?? body.createdBy ?? 'system';

    if (!body.parentId || !body.text) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'parentId and text are required' },
      });
    }

    const node = await nodeDb.createNode({
      ...body,
      mapId: req.params.id,
      createdBy: userId,
    });

    // Broadcast to connected clients
    broadcast(req.params.id, { type: 'node:created', node });

    // Schedule a background embedding for semantic search
    scheduleEmbedNode(node.id);

    // Change history (fire-and-forget)
    events
      .recordEvent({
        mapId: req.params.id,
        nodeId: node.id,
        userId: req.userId ?? null,
        eventType: 'node.created',
        newValue: {
          parentId: node.parentId,
          text: node.text,
          effortEstimate: node.effortEstimate ?? null,
          priority: node.priority ?? null,
        },
      })
      .catch(() => {});

    return reply.status(201).send(node);
  });

  // ── PUT /api/maps/:id/nodes/reorder — Reorder children ───────
  // NOTE: Must be registered BEFORE the parametric /:nodeId routes
  // so that "reorder" is matched as a static segment, not a param.
  app.put<{ Params: { id: string } }>(
    '/api/maps/:id/nodes/reorder',
    async (req, reply) => {
      const body = req.body as { parentId: string; childrenIds: string[] };

      if (!body.parentId || !Array.isArray(body.childrenIds)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'parentId and childrenIds are required' },
        });
      }

      const success = await nodeDb.reorderChildren(body.parentId, body.childrenIds);
      if (!success) {
        return reply.status(400).send({
          error: { code: 'REORDER_FAILED', message: 'Invalid parent or children IDs' },
        });
      }

      broadcast(req.params.id, {
        type: 'node:reordered',
        parentId: body.parentId,
        childrenIds: body.childrenIds,
      });

      return reply.send({ success: true });
    },
  );

  // ── PUT /api/maps/:id/nodes/:nodeId — Update a node ──────────
  app.put<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId',
    async (req, reply) => {
      // expectedRevision is an optional sibling of the patch fields. When
      // present, the DB layer enforces optimistic locking and throws on
      // mismatch.
      const { expectedRevision, ...body } = req.body as nodeDb.UpdateNodeInput & {
        expectedRevision?: number;
      };

      // Snapshot current values of tracked fields before mutating so we can
      // diff them into the change log.
      const before = await nodeDb.getNode(req.params.nodeId);

      let updated: CoreNode | null;
      try {
        updated = await nodeDb.updateNode(req.params.nodeId, body, expectedRevision);
      } catch (err) {
        if (err instanceof DependencyValidationError) {
          return reply.status(400).send({
            error: { code: 'DEPENDENCY_VALIDATION_ERROR', message: err.message },
          });
        }
        if (err instanceof RevisionConflictError) {
          return reply.status(409).send({
            error: {
              code: 'REVISION_CONFLICT',
              message: 'Node was modified by someone else; reload and retry.',
              current: err.current,
            },
          });
        }
        throw err;
      }
      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      // If the root node's text changed, keep the map name in sync
      if (body.text !== undefined && updated.parentId === null) {
        await mapDb.updateMap(req.params.id, { name: body.text });
      }

      // Broadcast the change
      broadcast(req.params.id, {
        type: 'node:updated',
        nodeId: req.params.nodeId,
        fields: Object.keys(body),
        node: updated,
      });

      // Re-embed if text or description changed (other fields don't affect the vector)
      if (body.text !== undefined || body.description !== undefined) {
        scheduleEmbedNode(req.params.nodeId);
      }

      // Fire outbound GitHub sync (non-blocking)
      syncNodeToGitHub(updated, Object.keys(body)).catch(() => {});

      // Change history (fire-and-forget): one event per tracked field that
      // actually changed.
      if (before) {
        events
          .recordFieldChanges(req.params.id, req.params.nodeId, req.userId ?? null, before, updated)
          .catch(() => {});
      }

      return reply.send(updated);
    },
  );

  // ── POST /api/maps/:id/nodes/:nodeId/dependencies — Add a dependency ──
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/dependencies',
    async (req, reply) => {
      const body = req.body as {
        targetNodeId: string;
        type: DependencyType;
        lag?: number;
      };

      if (!body.targetNodeId || !body.type) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'targetNodeId and type are required' },
        });
      }

      try {
        const updated = await nodeDb.addDependency(
          req.params.nodeId,
          body.targetNodeId,
          body.type,
          body.lag ?? 0,
        );

        broadcast(req.params.id, {
          type: 'node:updated',
          nodeId: req.params.nodeId,
          fields: ['dependencies'],
          node: updated,
        });

        return reply.status(201).send(updated);
      } catch (err) {
        if (err instanceof DependencyValidationError) {
          return reply.status(400).send({
            error: { code: 'DEPENDENCY_VALIDATION_ERROR', message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── DELETE /api/maps/:id/nodes/:nodeId — Delete a node ────────
  app.delete<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId',
    async (req, reply) => {
      // Pre-collect GitHub links in the subtree BEFORE deleting, so we can
      // close them on GitHub after the DB delete succeeds. Deletion is the
      // "dropped, won't do" signal → close as not_planned, not completed.
      const linksToClose = await nodeDb.collectGitHubLinksInSubtree(req.params.nodeId);

      // Snapshot the node text for the change log before it's gone.
      const deletedBefore = await nodeDb.getNode(req.params.nodeId);

      const deletedIds = await nodeDb.deleteNode(req.params.nodeId);
      if (deletedIds.length === 0) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      broadcast(req.params.id, {
        type: 'node:deleted',
        nodeId: req.params.nodeId,
        deletedIds,
      });

      // Change history (fire-and-forget): one event per deleted node id.
      // Snapshot enough state on the primary (root of deleted subtree) so
      // burnup can reconstruct scope/completed: text, parentId, estimate,
      // progress. Secondary deletions are logged without state — they're
      // only used for audit, not scope math.
      for (const id of deletedIds) {
        events
          .recordEvent({
            mapId: req.params.id,
            nodeId: id,
            userId: req.userId ?? null,
            eventType: 'node.deleted',
            oldValue:
              id === req.params.nodeId && deletedBefore
                ? {
                    text: deletedBefore.text,
                    parentId: deletedBefore.parentId,
                    effortEstimate: deletedBefore.effortEstimate ?? null,
                    percentComplete: deletedBefore.percentComplete ?? null,
                    isLeaf: (deletedBefore.childrenIds?.length ?? 0) === 0,
                  }
                : null,
          })
          .catch(() => {});
      }

      // Fire-and-forget close of linked GitHub issues. Best-effort — if
      // GitHub is down or the integration isn't configured, the delete in
      // MindBlown still stands.
      if (linksToClose.length > 0) {
        (async () => {
          const ghCtx = await getGitHubContextForMap(req.params.id);
          if (!ghCtx) return;
          for (const link of linksToClose) {
            try {
              await closeGitHubIssue(link, ghCtx.token, 'not_planned');
            } catch (err) {
              console.error(
                `[github-sync] Failed to close ${link.externalId} after node delete:`,
                err,
              );
            }
          }
        })().catch(() => {});
      }

      return reply.status(204).send();
    },
  );

  // ── PUT /api/maps/:id/nodes/:nodeId/move — Move a node ───────
  app.put<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/move',
    async (req, reply) => {
      const body = req.body as { newParentId: string; position?: number };

      if (!body.newParentId) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'newParentId is required' },
        });
      }

      const beforeMove = await nodeDb.getNode(req.params.nodeId);
      const moved = await nodeDb.moveNode(
        req.params.nodeId,
        body.newParentId,
        body.position,
      );

      if (!moved) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      broadcast(req.params.id, {
        type: 'node:moved',
        nodeId: req.params.nodeId,
        newParentId: body.newParentId,
        position: body.position,
      });

      if (beforeMove && beforeMove.parentId !== body.newParentId) {
        events
          .recordEvent({
            mapId: req.params.id,
            nodeId: req.params.nodeId,
            userId: req.userId ?? null,
            eventType: 'node.moved',
            oldValue: { parentId: beforeMove.parentId },
            newValue: { parentId: body.newParentId },
          })
          .catch(() => {});
      }

      return reply.send(moved);
    },
  );

  // ── GET /api/maps/:mapId/changes — Query the change log ─────
  app.get<{
    Params: { id: string };
    Querystring: { nodeId?: string; eventType?: string; fieldName?: string; sinceDays?: string; limit?: string };
  }>('/api/maps/:id/changes', async (req, reply) => {
    const { nodeId, eventType, fieldName, sinceDays, limit } = req.query;
    const since =
      sinceDays && !Number.isNaN(Number(sinceDays))
        ? new Date(Date.now() - Number(sinceDays) * 86_400_000)
        : undefined;
    const rows = await events.listEvents({
      mapId: req.params.id,
      nodeId,
      eventType: eventType as events.EventType | undefined,
      fieldName,
      since,
      limit: limit ? Math.min(1000, Math.max(1, Number(limit))) : 200,
    });
    return reply.send({ events: rows });
  });
}
