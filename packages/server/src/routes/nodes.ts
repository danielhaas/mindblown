import type { FastifyInstance } from 'fastify';
import * as nodeDb from '../db/nodes.js';
import { DependencyValidationError, PhaseIdValidationError, RequirementIdConflictError, RevisionConflictError, TagsModeConflictError } from '../db/nodes.js';
import * as mapDb from '../db/maps.js';
import * as events from '../db/events.js';
import { broadcast } from '../ws.js';
import { scheduleEmbedNode } from '../ai/embeddings.js';
import { updateGitHubIssue, getGitHubIssue } from '@mindblown/integrations';
import { getGitHubContextForMap } from './integrations.js';
import type { ExternalLink, DependencyType, Node as CoreNode } from '@mindblown/core';

// ── Auto-link helper (#58) ──────────────────────────────────────
// Titles that begin with `#NNNN` are almost always referencing an existing
// GitHub issue — the planning agent knew which issue this node represents
// but forgot to call link_github_issue. We catch that here so the orphan
// bucket stays empty without per-call discipline. Spec: GitHub issue #58.
//
// Pattern: leading `#NNNN` followed by either a space or end-of-string.
// Anchored — `#NNNN` mid-title is most likely a co-mention (e.g. an inline
// PR reference), not the node's own identity.
const AUTOLINK_TITLE_RE = /^#(\d+)(?:\s|$)/;

/**
 * Extract the leading issue number from a title, or null when the title
 * doesn't match the auto-link pattern.
 */
export function extractAutoLinkIssueNumber(title: string): number | null {
  if (!title) return null;
  const m = AUTOLINK_TITLE_RE.exec(title);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * If the title starts with `#NNNN` and the map has a GitHub repo bound to
 * it, verify the issue exists and attach an `externalLink`. Skips silently
 * when:
 *   - the title doesn't match the pattern,
 *   - no GitHub repo is connected,
 *   - the issue lookup returns a non-2xx (404 = the planning-prefix case
 *     where `#NNNN` isn't actually an issue number — common false positive),
 *   - the node already has a GitHub link (caller's explicit link wins).
 *
 * Fire-and-forget side of the create/update routes: errors are logged but
 * never propagate; the node creation/update itself has already succeeded.
 *
 * Returns the attached ExternalLink, or null when no link was attached.
 */
async function autoLinkNodeFromTitle(
  nodeId: string,
  mapId: string,
  title: string,
): Promise<ExternalLink | null> {
  const issueNumber = extractAutoLinkIssueNumber(title);
  if (issueNumber === null) return null;

  // Re-fetch node to see current externalLinks state (race with concurrent
  // link_github_issue is extremely unlikely on the create-path, but cheap
  // to check). For update-path the caller has already gated on "no existing
  // link" via shouldAutoLinkOnUpdate, but we double-check defensively.
  const node = await nodeDb.getNode(nodeId);
  if (!node) return null;
  const alreadyHasGithub = node.externalLinks.some((l) => l.provider === 'github');
  if (alreadyHasGithub) return null;

  const ghCtx = await getGitHubContextForMap(mapId);
  if (!ghCtx) return null;

  // Verify issue exists. 404 is a legit "this is a planning prefix, not an
  // issue" signal — skip silently. Any other error is logged but also
  // swallowed; we never want auto-link failure to bubble up.
  let issue: Awaited<ReturnType<typeof getGitHubIssue>>;
  try {
    issue = await getGitHubIssue(ghCtx.owner, ghCtx.repo, issueNumber, ghCtx.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't spam logs for 404s — that's the "not really an issue ref" case.
    if (!/404/.test(msg)) {
      console.warn(
        `[github-autolink] Issue lookup failed for ${ghCtx.owner}/${ghCtx.repo}#${issueNumber}:`,
        msg,
      );
    }
    return null;
  }

  const externalLink: ExternalLink = {
    provider: 'github',
    externalId: `${ghCtx.owner}/${ghCtx.repo}#${issueNumber}`,
    url: issue.html_url,
    syncEnabled: true,
    lastSyncedAt: new Date().toISOString(),
  };

  const updated = await nodeDb.updateNode(nodeId, {
    externalLinks: [...node.externalLinks, externalLink],
  });
  if (updated) {
    broadcast(mapId, {
      type: 'node:updated',
      nodeId,
      fields: ['externalLinks'],
      node: updated,
      source: 'github_autolink',
    });
  }
  return externalLink;
}

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
      autoProgress?: 'off' | 'children';
      priorityRank?: number | null;
      requirementId?: string | null;
      requirementPriority?: 'must' | 'should' | 'could' | null;
      requirementText?: string | null;
      phaseId?: string | null;
      verificationText?: string | null;
      verificationUrl?: string | null;
      /**
       * Set to `true` when the caller wants to disable the `^#NNNN`
       * auto-link backstop (#58). Useful when the leading `#NNNN` is
       * planning syntax unrelated to a real issue and the caller
       * doesn't want the issue-existence ping.
       */
      skipAutoLink?: boolean;
    };
    const userId = req.userId ?? body.createdBy ?? 'system';

    if (!body.parentId || !body.text) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'parentId and text are required' },
      });
    }

    // `skipAutoLink` is not a column on the nodes table — strip it before
    // forwarding to the DB layer.
    const { skipAutoLink, ...nodeFields } = body;
    let node: CoreNode;
    try {
      node = await nodeDb.createNode({
        ...nodeFields,
        mapId: req.params.id,
        createdBy: userId,
      });
    } catch (err) {
      if (err instanceof RequirementIdConflictError) {
        return reply.status(400).send({
          error: { code: 'REQUIREMENT_ID_CONFLICT', message: err.message },
        });
      }
      if (err instanceof PhaseIdValidationError) {
        return reply.status(400).send({
          error: { code: 'UNKNOWN_PHASE_ID', message: err.message },
        });
      }
      throw err;
    }

    // Broadcast to connected clients
    broadcast(req.params.id, { type: 'node:created', node });

    // Schedule a background embedding for semantic search
    scheduleEmbedNode(node.id);

    // Auto-link to GitHub issue when title starts with `#NNNN` (#58).
    // Fire-and-forget — the node creation itself has succeeded and the
    // caller already has the response. Concurrent clients see the link
    // appear via WebSocket once it lands.
    if (!skipAutoLink && body.text) {
      autoLinkNodeFromTitle(node.id, req.params.id, body.text).catch((err) => {
        console.warn('[github-autolink] create_node autolink failed:', err);
      });
    }

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

  // ── GET /api/maps/:id/nodes/:nodeId — Fetch a single node ────
  // Counterpart to GET /api/maps/:id?omit=…: clients that load the
  // slimmed map payload fetch the full node (description, links) on
  // demand when a detail view opens.
  app.get<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId',
    async (req, reply) => {
      const node = await nodeDb.getNode(req.params.nodeId);
      if (!node || node.mapId !== req.params.id) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }
      return reply.send(node);
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
        if (err instanceof TagsModeConflictError) {
          return reply.status(400).send({
            error: { code: 'TAGS_MODE_CONFLICT', message: err.message },
          });
        }
        if (err instanceof RequirementIdConflictError) {
          return reply.status(400).send({
            error: { code: 'REQUIREMENT_ID_CONFLICT', message: err.message },
          });
        }
        if (err instanceof PhaseIdValidationError) {
          return reply.status(400).send({
            error: { code: 'UNKNOWN_PHASE_ID', message: err.message },
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

      // Auto-link to GitHub when the title was just changed AND the node has
      // no existing GitHub link (#58). The "no existing link" gate is the
      // important one — we must never override an explicit prior link, even
      // if the new title points elsewhere.
      if (body.text !== undefined && before) {
        const hadGithubLink = before.externalLinks.some((l) => l.provider === 'github');
        if (!hadGithubLink) {
          autoLinkNodeFromTitle(req.params.nodeId, req.params.id, updated.text).catch((err) => {
            console.warn('[github-autolink] update_node autolink failed:', err);
          });
        }
      }

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
      // Snapshot the node text for the change log before it's soft-deleted
      // (still accessible via getNode since soft-delete preserves the row,
      // but reading it before the mutation keeps the snapshot path stable
      // even if we tighten getNode to filter deleted_at later).
      const deletedBefore = await nodeDb.getNode(req.params.nodeId);

      const { deletedIds, parentChildIndex } = await nodeDb.deleteNode(req.params.nodeId);
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

      // Change history: one event per deleted node id. Snapshot enough state
      // on the primary (root of deleted subtree) so burnup can reconstruct
      // scope/completed AND restoreNode can splice the subtree back at the
      // original children_order index. Secondary deletions are logged
      // without state — they're only used for audit, not restore.
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
                    parentChildIndex,
                  }
                : null,
          })
          .catch(() => {});
      }

      // Soft-delete intentionally does NOT close linked GitHub issues — the
      // delete is reversible from the Trash. The GC job that hard-deletes
      // rows after the retention window is where we close the linked GH
      // issues as not_planned (see closes #107, open question 1).

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

  // ── POST /api/maps/:id/nodes/:nodeId/restore — Undelete (#107) ────
  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/maps/:id/nodes/:nodeId/restore',
    async (req, reply) => {
      const body = (req.body ?? {}) as { recursive?: boolean };
      try {
        const result = await nodeDb.restoreNode(req.params.nodeId, {
          recursive: body.recursive === true,
        });

        // Pull the now-live root so the response carries the same shape as
        // POST /nodes (the optimistic UI replaces its placeholder with this).
        const restoredRoot = await nodeDb.getNode(req.params.nodeId);

        broadcast(req.params.id, {
          type: 'node:restored',
          nodeId: req.params.nodeId,
          restoredIds: result.restoredIds,
          affectedParentIds: result.affectedParentIds,
        });

        events
          .recordEvent({
            mapId: req.params.id,
            nodeId: req.params.nodeId,
            userId: req.userId ?? null,
            eventType: 'node.restored',
            newValue: {
              restoredCount: result.restoredIds.length,
              recursive: body.recursive === true,
            },
          })
          .catch(() => {});

        return reply.status(200).send({
          restoredIds: result.restoredIds,
          affectedParentIds: result.affectedParentIds,
          node: restoredRoot,
        });
      } catch (err) {
        if (err instanceof nodeDb.RestoreError) {
          const status = err.code === 'NOT_FOUND' ? 404 : 409;
          return reply.status(status).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // ── GET /api/maps/:id/trash — List soft-deleted subtree roots ────
  app.get<{
    Params: { id: string };
    Querystring: { sinceDays?: string; limit?: string };
  }>('/api/maps/:id/trash', async (req, reply) => {
    const sinceDays = req.query.sinceDays
      ? Math.max(1, Math.min(365, Number(req.query.sinceDays)))
      : undefined;
    const limit = req.query.limit
      ? Math.max(1, Math.min(1000, Number(req.query.limit)))
      : undefined;
    const rows = await nodeDb.listDeleted(req.params.id, { sinceDays, limit });
    return reply.send({ deleted: rows });
  });

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

  // ── Who last touched each node (Workload view) ────────────────
  //
  // Returns one entry per live node of the map. The Workload view uses it
  // as the last fallback for "whose work is this?", behind assigneeIds and
  // claimedBySession — see `computeWorkloads`.
  app.get<{ Params: { id: string } }>('/api/maps/:id/nodes/actors', async (req, reply) => {
    const actors = await events.getLastActorByNode(req.params.id);
    return reply.send({ actors });
  });
}
