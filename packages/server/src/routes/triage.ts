/**
 * Triage CRUD routes (#92, #93).
 *
 * Three endpoints, all map-scoped, all session-JWT-gated (API-key auth
 * is rejected to match the audit-drift convention — triage exposes
 * cross-issue LLM reasoning that a leaked key shouldn't be able to fan
 * out across every workspace).
 *
 *   - GET    /api/maps/:mapId/triage-decisions
 *       Filterable list. Used by Phase 1's operator UI; for Phase 0
 *       the operator drives this via curl / MCP.
 *
 *   - POST   /api/maps/:mapId/triage-decisions/:decisionId/override
 *       Operator overrides the auto-decision. If the new decision is
 *       `place`, creates the node under the supplied parentNodeId.
 *       Marks the row reviewed + flips decidedBy to `operator`.
 *
 *   - POST   /api/maps/:mapId/triage-decisions/:decisionId/reclassify
 *       Re-runs `triageIssue()` against the current map context, then
 *       upserts the result onto the existing row. No node is created
 *       here — reclassify just refreshes the decision; the operator
 *       follows up with `override` to apply.
 *
 * Phase 0 explicitly does NOT include any frontend; the routes are
 * here so the operator can drive Phase 0 by curl while Phase 1 builds
 * the UI on top.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps, nodes, triageDecisions } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import * as permDb from '../db/permissions.js';
import { broadcast } from '../ws.js';
import { buildMapContext } from '../sync/mapContext.js';
import { triageIssue } from '../sync/triage.js';
import type { ExternalLink } from '@mindblown/core';

// ── Auth helpers ──────────────────────────────────────────────────

interface AuthedReq {
  userId?: string;
  authSource?: 'jwt' | 'api-key';
}

/**
 * Reject API-key auth, require a session JWT + at least 'view'
 * permission on the map. The override route bumps to 'edit'.
 *
 * Returns `null` on success (caller continues), or a Fastify reply
 * with the appropriate 4xx already sent.
 *
 * Mirrors the audit-drift pattern in routes/integrations.ts and the
 * #69 fix that keeps API-key auth out of admin surfaces. Triage isn't
 * admin-only, but it does expose Claude's reasoning across every
 * issue in the map — same blast-radius concern, same mitigation.
 */
async function gateMapAccess(
  req: AuthedReq,
  mapId: string,
  required: 'view' | 'edit',
): Promise<{ status: number; code: string; message: string } | null> {
  if (req.authSource === 'api-key') {
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: 'API-key auth cannot access triage endpoints — use a session login',
    };
  }
  if (!req.userId) {
    return { status: 401, code: 'UNAUTHORIZED', message: 'Not authenticated' };
  }
  const perm = await permDb.getPermission(mapId, req.userId);
  if (!permDb.hasPermission(perm, required)) {
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: `${required} permission required on this map`,
    };
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────

export async function triageRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/maps/:mapId/triage-decisions ─────────────────────
  // Filter params:
  //   reviewed=true|false       — exact-match on the boolean column.
  //   decision=skip|place|uncertain — exact-match.
  //   limit=N                   — default 50, hard-capped at 200.
  // Results ordered newest decided_at first so the operator review
  // queue surfaces the latest unreviewed rows.
  app.get<{
    Params: { mapId: string };
    Querystring: { reviewed?: string; decision?: string; limit?: string };
  }>('/api/maps/:mapId/triage-decisions', async (req, reply) => {
    const gate = await gateMapAccess(req, req.params.mapId, 'view');
    if (gate) {
      return reply.status(gate.status).send({
        error: { code: gate.code, message: gate.message },
      });
    }

    const filters = [eq(triageDecisions.mapId, req.params.mapId)];
    if (req.query.reviewed === 'true') {
      filters.push(eq(triageDecisions.reviewed, true));
    } else if (req.query.reviewed === 'false') {
      filters.push(eq(triageDecisions.reviewed, false));
    }
    if (
      req.query.decision === 'skip' ||
      req.query.decision === 'place' ||
      req.query.decision === 'uncertain'
    ) {
      filters.push(eq(triageDecisions.decision, req.query.decision));
    }

    const limitRaw = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 200)
      : 50;

    const rows = await db
      .select()
      .from(triageDecisions)
      .where(and(...filters))
      .orderBy(desc(triageDecisions.decidedAt))
      .limit(limit);

    return reply.send({
      mapId: req.params.mapId,
      total: rows.length,
      decisions: rows,
    });
  });

  // ── POST /api/maps/:mapId/triage-decisions/:decisionId/override ──
  // Body: { decision: 'place'|'skip'|'uncertain', parentNodeId?: uuid,
  //         reason: string }
  //
  // Effect:
  //   - decision='place' → create a node under parentNodeId NOW
  //     (regardless of the original confidence), attach the github
  //     externalLink, broadcast node:created, and stamp the row with
  //     placedNodeId.
  //   - decision='skip'|'uncertain' → just update the row.
  //
  // In all cases: decidedBy='operator', reviewed=true,
  // reviewedAt=now(), reviewedBy=req.userId, confidence=100
  // (operator decisions are by definition certain).
  app.post<{
    Params: { mapId: string; decisionId: string };
    Body: {
      decision?: 'place' | 'skip' | 'uncertain';
      parentNodeId?: string;
      reason?: string;
    };
  }>(
    '/api/maps/:mapId/triage-decisions/:decisionId/override',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }
      const userId = req.userId as string; // gate guarantees set

      const body = req.body ?? {};
      const decision = body.decision;
      if (
        decision !== 'place' &&
        decision !== 'skip' &&
        decision !== 'uncertain'
      ) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'decision must be one of: place, skip, uncertain',
          },
        });
      }
      if (decision === 'place' && !body.parentNodeId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'parentNodeId is required when decision=place',
          },
        });
      }

      const [row] = await db
        .select()
        .from(triageDecisions)
        .where(
          and(
            eq(triageDecisions.id, req.params.decisionId),
            eq(triageDecisions.mapId, req.params.mapId),
          ),
        );
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Triage decision ${req.params.decisionId} not found in map ${req.params.mapId}`,
          },
        });
      }

      // If the operator wants a place but a node was already created
      // by a prior auto-apply, short-circuit — we don't want to create
      // a duplicate. Surface the existing node id.
      if (decision === 'place' && row.placedNodeId) {
        await db
          .update(triageDecisions)
          .set({
            decision: 'place',
            reason: body.reason ?? row.reason,
            confidence: 100,
            decidedBy: 'operator',
            decidedAt: new Date(),
            reviewed: true,
            reviewedAt: new Date(),
            reviewedBy: userId,
          })
          .where(eq(triageDecisions.id, row.id));
        return reply.send({
          decisionId: row.id,
          status: 'already_placed',
          nodeId: row.placedNodeId,
        });
      }

      // Place: validate the parent + create the node. The parent must
      // belong to this map; we don't enforce depth-1 here because an
      // operator override may legitimately drop the node deeper.
      if (decision === 'place') {
        const parentNodeId = body.parentNodeId as string;
        const [parent] = await db
          .select({ id: nodes.id, mapId: nodes.mapId })
          .from(nodes)
          .where(eq(nodes.id, parentNodeId));
        if (!parent || parent.mapId !== req.params.mapId) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'parentNodeId must be a node in this map',
            },
          });
        }
      }

      // Apply.
      let createdNodeId: string | null = null;
      const isClosed = row.issueState === 'closed';
      const created = await db.transaction(async (tx) => {
        if (decision === 'place') {
          // The triage row stores `externalId` ("owner/repo#NNN") +
          // `issueTitle` but not the original body / html_url. That's
          // intentional: re-deriving the URL from externalId is trivial,
          // and the body is only attached at auto-apply time anyway.
          const node = await nodeDb.createNode(
            {
              mapId: req.params.mapId,
              parentId: body.parentNodeId as string,
              text: `#${parseIssueNumber(row.externalId)} ${row.issueTitle}`,
              createdBy: userId,
              percentComplete: isClosed ? 100 : 0,
              status: isClosed ? 'done' : 'todo',
            },
            tx,
          );
          const link: ExternalLink = {
            provider: 'github',
            externalId: row.externalId,
            url: buildIssueUrlFromExternalId(row.externalId),
            syncEnabled: true,
            lastSyncedAt: new Date().toISOString(),
          };
          const updated = await nodeDb.updateNode(
            node.id,
            { externalLinks: [link] },
            undefined,
            tx,
          );
          createdNodeId = node.id;
          await tx
            .update(triageDecisions)
            .set({
              decision: 'place',
              reason: body.reason ?? row.reason,
              confidence: 100,
              decidedBy: 'operator',
              decidedAt: new Date(),
              placedNodeId: node.id,
              reviewed: true,
              reviewedAt: new Date(),
              reviewedBy: userId,
            })
            .where(eq(triageDecisions.id, row.id));
          return updated ?? node;
        } else {
          await tx
            .update(triageDecisions)
            .set({
              decision,
              reason: body.reason ?? row.reason,
              confidence: 100,
              decidedBy: 'operator',
              decidedAt: new Date(),
              reviewed: true,
              reviewedAt: new Date(),
              reviewedBy: userId,
            })
            .where(eq(triageDecisions.id, row.id));
          return null;
        }
      });

      if (createdNodeId && created) {
        broadcast(req.params.mapId, {
          type: 'node:created',
          node: created,
          source: 'triage_override',
        });
      }

      return reply.send({
        decisionId: row.id,
        status: decision === 'place' ? 'placed' : decision,
        nodeId: createdNodeId,
      });
    },
  );

  // ── POST /api/maps/:mapId/triage-decisions/:decisionId/reclassify ──
  // Re-run triageIssue against the current map context, then UPDATE
  // (don't insert) the existing row in place. We can't fully rebuild
  // the inbound GitHub issue from the triage row alone (the body
  // isn't stored), so reclassify uses the row's title + state as the
  // input and leaves the body empty. That's a reasonable degradation:
  // operator reclassify is for "the map changed, decide again" rather
  // than "I want a fresh look at the original ticket content".
  //
  // Reclassify writes decidedBy='auto' (the LLM made the new call)
  // and resets reviewed=false (it's a fresh auto-decision that needs
  // re-review). No node is created.
  app.post<{
    Params: { mapId: string; decisionId: string };
  }>(
    '/api/maps/:mapId/triage-decisions/:decisionId/reclassify',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }

      const [row] = await db
        .select()
        .from(triageDecisions)
        .where(
          and(
            eq(triageDecisions.id, req.params.decisionId),
            eq(triageDecisions.mapId, req.params.mapId),
          ),
        );
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Triage decision ${req.params.decisionId} not found in map ${req.params.mapId}`,
          },
        });
      }

      const mapContext = await buildMapContext(req.params.mapId);
      // Synthesize a minimal GitHubIssue from what we have on the row.
      // The triage prompt mostly leans on title + state + map context,
      // so an empty body is acceptable degradation here.
      const issueNumber = parseIssueNumber(row.externalId) ?? 0;
      const decision = await triageIssue({
        issue: {
          id: issueNumber,
          number: issueNumber,
          title: row.issueTitle,
          body: null,
          state: row.issueState === 'closed' ? 'closed' : 'open',
          labels: [],
          assignees: [],
          milestone: null,
          html_url: buildIssueUrlFromExternalId(row.externalId),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        mapContext,
      });

      await db
        .update(triageDecisions)
        .set({
          decision: decision.decision,
          reason: decision.reason,
          confidence: decision.confidence,
          decidedBy: 'auto',
          decidedAt: new Date(),
          reviewed: false,
          reviewedAt: null,
          reviewedBy: null,
        })
        .where(eq(triageDecisions.id, row.id));

      return reply.send({
        decisionId: row.id,
        decision: decision.decision,
        confidence: decision.confidence,
        reason: decision.reason,
        parentNodeId: decision.parentNodeId ?? null,
      });
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract the issue number from an externalId like "owner/repo#42".
 * Returns null on a malformed input — the caller decides what to do
 * (the routes substitute 0, which produces a `#0 <title>` placeholder
 * that's clearly distinguishable from a real issue).
 */
function parseIssueNumber(externalId: string): number | null {
  const idx = externalId.lastIndexOf('#');
  if (idx < 0) return null;
  const n = parseInt(externalId.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : null;
}

function buildIssueUrlFromExternalId(externalId: string): string {
  const idx = externalId.lastIndexOf('#');
  if (idx < 0) return '';
  const ownerRepo = externalId.slice(0, idx);
  const number = externalId.slice(idx + 1);
  return `https://github.com/${ownerRepo}/issues/${number}`;
}
