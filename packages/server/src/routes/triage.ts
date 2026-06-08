/**
 * Triage CRUD routes (#92, #93, #95).
 *
 * Endpoints, all map-scoped, all session-JWT-gated (API-key auth is
 * rejected to match the audit-drift convention — triage exposes
 * cross-issue LLM reasoning that a leaked key shouldn't be able to fan
 * out across every workspace).
 *
 *   - GET    /api/maps/:mapId/triage-decisions
 *       Filterable list. Used by the Phase 1+2 operator UI; for Phase 0
 *       the operator drives this via curl / MCP. Phase 2 added the
 *       confidence-range + issueState + since query params so the
 *       client doesn't have to re-fetch + filter when the operator
 *       slides the confidence slider.
 *
 *   - POST   /api/maps/:mapId/triage-decisions/:decisionId/confirm
 *       Operator confirms the existing auto-decision (Ray's review on
 *       #100 — split out from override to keep node parentage out of
 *       the confirm flow). Marks the row reviewed=true + decidedBy=
 *       'operator'. Does NOT touch node parentage. No parentNodeId
 *       parameter. The dedicated route exists so the frontend cannot
 *       accidentally pass `parentNodeId === placedNodeId` (which used
 *       to flow through the override route's already-placed branch
 *       and self-loop the node — #100 Round 2 fix).
 *
 *   - POST   /api/maps/:mapId/triage-decisions/:decisionId/override
 *       Operator overrides the auto-decision. If the new decision is
 *       `place`, creates the node under the supplied parentNodeId
 *       (or, when a node was already placed, calls `moveNode` to
 *       reparent it). Marks the row reviewed + flips decidedBy to
 *       `operator`.
 *
 *   - POST   /api/maps/:mapId/triage-decisions/:decisionId/reclassify
 *       Re-runs `triageIssue()` against the current map context, then
 *       upserts the result onto the existing row. No node is created
 *       here — reclassify just refreshes the decision; the operator
 *       follows up with `override` to apply.
 *
 *   - POST   /api/maps/:mapId/triage-decisions/bulk-confirm
 *   - POST   /api/maps/:mapId/triage-decisions/bulk-override
 *   - POST   /api/maps/:mapId/triage-decisions/bulk-reclassify
 *       Phase 2 (#95). Bulk variants of the three actions, designed for
 *       the 290-Fulcrum-Roadmap-orphans workflow where the operator
 *       wants to confirm a select-all of high-confidence decisions in
 *       a single click. Each is per-item idempotent — one row failing
 *       (e.g. deleted between submit and execute, validation failure)
 *       doesn't fail the batch; the response carries
 *       `{id, status|error}` per submitted id so the client can show
 *       per-row outcomes.
 *
 * Phase 0 explicitly did NOT include any frontend; Phase 1 built the
 * single-item UI on top; Phase 2 layers bulk operations + the
 * lifecycle/reopened webhook hook (which lives in routes/integrations).
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { maps, nodes, triageDecisions, triageDecisionHistory } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { notDeleted } from '../db/nodes.js';
import * as permDb from '../db/permissions.js';
import { broadcast } from '../ws.js';
import { buildMapContext } from '../sync/mapContext.js';
import { triageIssue } from '../sync/triage.js';
import { recordTriageHistory } from '../sync/triageHistory.js';
import { applyTriageLabel } from '../sync/triageLabelWriteback.js';
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

// ── WS event constants (Phase 3 follow-up #102 item 7) ───────────
//
// Triage mutations (confirm/override/reclassify, single + bulk) broadcast
// `triage:updated` so connected operators see refreshed counts and rows
// without a poll. Mirrors the existing `node:created`/`node:moved`
// pattern used elsewhere in the routes. The frontend handler (Phase 3
// follow-up) listens for the event and bumps the panel's `refreshTick`
// — that triggers the same `useEffect` data fetch that the user's own
// actions already drive, so we don't have to merge a partial payload
// into local state. Payload carries:
//   - `decisionIds`: array of mutated rows so a single-row UI can decide
//                    whether to refresh (it intersects with what it's
//                    showing). For bulk-confirm/override the array is
//                    the full submitted set after dedupe.
//   - `mutation`: one of 'confirmed' | 'overridden' | 'reclassified'.
//                 Lets the UI render a toast or differentiate inbound
//                 events from its own optimistic updates.
export const WS_TRIAGE_UPDATED = 'triage:updated';
type TriageMutationKind = 'confirmed' | 'overridden' | 'reclassified';
function broadcastTriageUpdated(
  mapId: string,
  mutation: TriageMutationKind,
  decisionIds: string[],
): void {
  if (decisionIds.length === 0) return;
  broadcast(mapId, {
    type: WS_TRIAGE_UPDATED,
    mapId,
    mutation,
    decisionIds,
  });
}

// ── Routes ────────────────────────────────────────────────────────

export async function triageRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/maps/:mapId/triage-decisions ─────────────────────
  // Filter params (Phase 0 baseline + Phase 2 additions):
  //   reviewed=true|false           — exact-match on the boolean.
  //   decision=skip|place|uncertain — exact-match.
  //   limit=N                       — default 50, hard-capped at 200.
  //   minConfidence=0..100          — Phase 2; lower bound, inclusive.
  //   maxConfidence=0..100          — Phase 2; upper bound, inclusive.
  //   issueState=open|closed        — Phase 2; exact-match on the
  //                                   GH state captured at decision-
  //                                   time (refreshed by webhooks).
  //   since=ISO8601                 — Phase 2; only rows with
  //                                   decided_at >= since.
  // Results ordered newest decided_at first so the operator review
  // queue surfaces the latest unreviewed rows.
  //
  // Phase 2 (#95): the slider/time-window/state filters are exposed
  // server-side so the bulk-workflow case (290 Fulcrum roadmap orphans
  // → operator picks the top-confidence band) doesn't have to fetch
  // every row then filter client-side, AND so a select-all-and-confirm
  // operates only on the rows the operator's filter actually surfaced.
  app.get<{
    Params: { mapId: string };
    Querystring: {
      reviewed?: string;
      decision?: string;
      limit?: string;
      minConfidence?: string;
      maxConfidence?: string;
      issueState?: string;
      since?: string;
    };
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
    // Phase 2 filters — silently ignore malformed values rather than
    // 400-erroring so a typo in the URL doesn't blank the panel; the
    // client always re-derives params from the slider/dropdowns so
    // there's no UI affordance for sending invalid values.
    if (req.query.minConfidence != null) {
      const n = parseInt(req.query.minConfidence, 10);
      if (Number.isFinite(n)) {
        filters.push(gte(triageDecisions.confidence, Math.max(0, Math.min(100, n))));
      }
    }
    if (req.query.maxConfidence != null) {
      const n = parseInt(req.query.maxConfidence, 10);
      if (Number.isFinite(n)) {
        filters.push(lte(triageDecisions.confidence, Math.max(0, Math.min(100, n))));
      }
    }
    if (req.query.issueState === 'open' || req.query.issueState === 'closed') {
      filters.push(eq(triageDecisions.issueState, req.query.issueState));
    }
    if (req.query.since) {
      const t = Date.parse(req.query.since);
      if (Number.isFinite(t)) {
        filters.push(gte(triageDecisions.decidedAt, new Date(t)));
      }
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

    // Phase 3 follow-up (#104 item 12): surface the true matching count
    // alongside the page-sized `returned`, so the MCP tool and UI can
    // render "showing N of M" when the limit clips the result set.
    // `total` keeps its original meaning (matching-row count for the
    // filter set) so the field name stays consistent with the previous
    // response shape; `returned` is added as the number of rows in the
    // page. Old clients that read `total` as "page size" get the more
    // useful number — a small but safe semantic improvement.
    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(triageDecisions)
      .where(and(...filters));

    return reply.send({
      mapId: req.params.mapId,
      total,
      returned: rows.length,
      decisions: rows,
    });
  });

  // ── GET /api/maps/:mapId/triage-decisions/:decisionId/history ─
  // Phase 3 (#96). Returns the append-only audit log for a single
  // decision, ordered newest-first. Auth mirrors the single-decision
  // list route: session JWT + 'view' permission (API-key auth 403s,
  // same blast-radius reasoning as the rest of triage).
  //
  // The history rows are written by `recordTriageHistory` from every
  // mutation site (override, reclassify, confirm, ingest auto-apply,
  // reopened-state sync, bulk variants). On `triage_decisions` delete
  // the history rows cascade away.
  app.get<{
    Params: { mapId: string; decisionId: string };
  }>(
    '/api/maps/:mapId/triage-decisions/:decisionId/history',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'view');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }

      // Confirm the decision exists in this map before returning rows
      // — prevents cross-map information leakage if a future operator
      // pastes a decisionId from another tenant into the URL.
      const [row] = await db
        .select({ id: triageDecisions.id })
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

      const rows = await db
        .select()
        .from(triageDecisionHistory)
        .where(eq(triageDecisionHistory.decisionId, req.params.decisionId))
        .orderBy(desc(triageDecisionHistory.changedAt));

      return reply.send({
        decisionId: req.params.decisionId,
        total: rows.length,
        history: rows,
      });
    },
  );

  // ── POST /api/maps/:mapId/triage-decisions/:decisionId/confirm ──
  // Body: ignored (no parameters).
  //
  // Effect: mark the row reviewed=true, reviewedAt=now(),
  // reviewedBy=req.userId, decidedBy='operator'. Does NOT touch node
  // parentage, does NOT take a parentNodeId, does NOT mutate the
  // decision/reason/confidence fields. The operator is saying "yes,
  // accept what's already there" — same auth gate as override (edit).
  //
  // Why a separate route: Ray's #100 Round 2 review caught the
  // frontend's `confirmTriageDecision` calling /override with
  // `parentNodeId: decision.placedNodeId`. The override route's
  // already-placed branch compared `placedNode.parentId !==
  // submittedParent`, which is always true (a node isn't its own
  // parent), so `moveNode(placedNodeId, placedNodeId)` ran — turning
  // the node into its own parent. Splitting confirm into its own
  // route closes that off at the API boundary: there is no
  // parentNodeId parameter to misuse.
  app.post<{
    Params: { mapId: string; decisionId: string };
  }>(
    '/api/maps/:mapId/triage-decisions/:decisionId/confirm',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }
      const userId = req.userId as string; // gate guarantees set

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

      // Stamp reviewed + operator. Intentionally NOT touching
      // placedNodeId, decision, reason, or confidence — confirm means
      // "accept the existing record as-is."
      await db
        .update(triageDecisions)
        .set({
          decidedBy: 'operator',
          reviewed: true,
          reviewedAt: new Date(),
          reviewedBy: userId,
        })
        .where(eq(triageDecisions.id, row.id));

      // Phase 3 audit log — confirm doesn't change the decision so
      // previous_/new_ fields all reflect the same values; the row
      // documents WHO confirmed and WHEN.
      await recordTriageHistory({
        decisionId: row.id,
        changedBy: userId,
        changeType: 'confirmed',
        previousDecision: row.decision,
        newDecision: row.decision,
        previousConfidence: row.confidence,
        newConfidence: row.confidence,
        previousParentNodeId: row.placedNodeId ?? null,
        newParentNodeId: row.placedNodeId ?? null,
        reason: row.reason,
      });

      // Phase 3 opt-in label writeback — fire-and-forget, best-effort
      // (helper internally checks the per-map flag and silently no-ops
      // on uncertain / disabled / GH errors).
      await applyTriageLabel({
        mapId: req.params.mapId,
        externalId: row.externalId,
        decision: row.decision as 'place' | 'skip' | 'uncertain',
      });

      // Phase 3 follow-up (#102 item 7): notify connected clients.
      broadcastTriageUpdated(req.params.mapId, 'confirmed', [row.id]);

      return reply.send({
        decisionId: row.id,
        status: 'confirmed',
        nodeId: row.placedNodeId ?? null,
      });
    },
  );

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

      // Defense-in-depth: even with the dedicated /confirm route in
      // place, reject parentNodeId === placedNodeId at the server.
      // The earlier bug (#100 Round 2) had the frontend's confirm flow
      // calling override with `parentNodeId: decision.placedNodeId`,
      // which fell through to the already-placed branch below and
      // called `moveNode(placedNodeId, placedNodeId)` — a self-loop
      // that orphaned the node under itself. The frontend fix routes
      // confirms through /confirm now, but rejecting self-loops at the
      // override route prevents a future caller (curl, MCP, alt UI)
      // from re-triggering the same corruption.
      if (
        decision === 'place' &&
        row.placedNodeId &&
        body.parentNodeId === row.placedNodeId
      ) {
        return reply.status(400).send({
          error: {
            code: 'SELF_LOOP_BLOCKED',
            message:
              'parentNodeId must differ from the placed node — use /confirm to mark reviewed without reparenting',
          },
        });
      }

      // If the operator wants a place but a node was already created
      // by a prior auto-apply, we DON'T create a second node — but if
      // the submitted parentNodeId differs from where the node sits
      // today, we DO call `moveNode` so the operator's intent isn't
      // silently dropped (mindblown#99 fix 3). The previous behaviour
      // returned the old node-id and let the operator wonder why
      // their click didn't reparent.
      if (decision === 'place' && row.placedNodeId) {
        // The operator MAY supply a parentNodeId that's a no-op (it
        // matches the current parent). That's fine; moveNode is a
        // safe identity in that case but we still don't bother
        // calling it if parents already match.
        const placedNodeId = row.placedNodeId as string;
        const submittedParent = body.parentNodeId as string;

        // Validate the submitted parent is in this map (same gate as
        // the create-path below).
        const [parent] = await db
          .select({ id: nodes.id, mapId: nodes.mapId })
          .from(nodes)
          .where(and(eq(nodes.id, submittedParent), notDeleted));
        if (!parent || parent.mapId !== req.params.mapId) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'parentNodeId must be a node in this map',
            },
          });
        }

        // Look up the placed node's current parent so we know whether
        // we need to move it.
        const [placedNode] = await db
          .select({ id: nodes.id, parentId: nodes.parentId })
          .from(nodes)
          .where(and(eq(nodes.id, placedNodeId), notDeleted));

        let moved = false;
        if (placedNode && placedNode.parentId !== submittedParent) {
          // moveNode runs outside the tx that updates the decision
          // row — it has its own internal write fan-out (children
          // ordering on both old + new parent, parentId on the node
          // itself) that doesn't share the route's outer tx. The
          // payoff is the operator's reparent intent is honored.
          const movedNode = await nodeDb.moveNode(placedNodeId, submittedParent);
          moved = movedNode != null;
          if (moved) {
            broadcast(req.params.mapId, {
              type: 'node:moved',
              nodeId: placedNodeId,
              newParentId: submittedParent,
              position: undefined,
            });
          }
        }

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

        await recordTriageHistory({
          decisionId: row.id,
          changedBy: userId,
          changeType: 'overridden',
          previousDecision: row.decision,
          newDecision: 'place',
          previousConfidence: row.confidence,
          newConfidence: 100,
          previousParentNodeId: row.placedNodeId ?? null,
          newParentNodeId: submittedParent,
          reason: body.reason ?? row.reason,
        });
        await applyTriageLabel({
          mapId: req.params.mapId,
          externalId: row.externalId,
          decision: 'place',
        });

        // Phase 3 follow-up (#102 item 7): notify connected clients.
        broadcastTriageUpdated(req.params.mapId, 'overridden', [row.id]);

        return reply.send({
          decisionId: row.id,
          status: moved ? 'moved' : 'already_placed',
          nodeId: placedNodeId,
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
          .where(and(eq(nodes.id, parentNodeId), notDeleted));
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

      // Phase 3 audit log — record the override with full before/after
      // snapshots. For 'place' the new parent is the freshly-created
      // node; for skip/uncertain we leave parent null on both sides.
      await recordTriageHistory({
        decisionId: row.id,
        changedBy: userId,
        changeType: 'overridden',
        previousDecision: row.decision,
        newDecision: decision,
        previousConfidence: row.confidence,
        newConfidence: 100,
        previousParentNodeId: row.placedNodeId ?? null,
        newParentNodeId:
          decision === 'place' ? (createdNodeId ?? null) : null,
        reason: body.reason ?? row.reason,
      });
      await applyTriageLabel({
        mapId: req.params.mapId,
        externalId: row.externalId,
        decision,
      });

      // Phase 3 follow-up (#102 item 7): notify connected clients.
      broadcastTriageUpdated(req.params.mapId, 'overridden', [row.id]);

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
      //
      // Nit from Ray's #100 review: parseIssueNumber returning null
      // collapses to 0, which is indistinguishable from a real #0.
      // We log a warning so an operator chasing a `#0 <title>` in the
      // UI can grep server logs for the malformed externalId rather
      // than wondering whether GitHub ever issued a #0.
      const parsedNumber = parseIssueNumber(row.externalId);
      if (parsedNumber == null) {
        console.warn(
          `[triage] reclassify: could not parse issue number from externalId=${JSON.stringify(row.externalId)} on decision ${row.id} (map ${req.params.mapId}); falling back to 0`,
        );
      }
      const issueNumber = parsedNumber ?? 0;
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

      // mindblown#99 fix 4: when reclassify produces a non-place
      // decision and the row had a previous `placedNodeId`, the row
      // is internally inconsistent ("decision says skip, but here's a
      // node we placed earlier"). Clear placedNodeId so the row stops
      // referencing the orphan. The original node is intentionally
      // NOT auto-deleted on reclassify (Ray's spec: "operator can
      // delete via UI") — only the decision-row reference is dropped.
      const clearPlacedNode = decision.decision !== 'place' && row.placedNodeId != null;
      // Reclassify is an LLM call — refresh the suggested-parent
      // column with the new pick (null on skip/uncertain). This is
      // what the Override modal pre-selects when the operator opens
      // it for a low-confidence place.
      const newSuggestedParentNodeId =
        decision.decision === 'place' ? (decision.parentNodeId ?? null) : null;

      await db
        .update(triageDecisions)
        .set({
          decision: decision.decision,
          reason: decision.reason,
          confidence: decision.confidence,
          suggestedParentNodeId: newSuggestedParentNodeId,
          decidedBy: 'auto',
          decidedAt: new Date(),
          reviewed: false,
          reviewedAt: null,
          reviewedBy: null,
          ...(clearPlacedNode ? { placedNodeId: null } : {}),
        })
        .where(eq(triageDecisions.id, row.id));

      // Phase 3 audit log — reclassify is recorded as 'auto' since the
      // LLM is the actor here, even though an operator triggered the
      // re-run. Mirroring decidedBy/decidedAt semantics on the row.
      const newParent = clearPlacedNode
        ? null
        : decision.decision === 'place'
          ? (decision.parentNodeId ?? row.placedNodeId ?? null)
          : (row.placedNodeId ?? null);
      await recordTriageHistory({
        decisionId: row.id,
        changedBy: 'auto',
        changeType: 'reclassified',
        previousDecision: row.decision,
        newDecision: decision.decision,
        previousConfidence: row.confidence,
        newConfidence: decision.confidence,
        previousParentNodeId: row.placedNodeId ?? null,
        newParentNodeId: newParent,
        reason: decision.reason,
      });
      // Phase 3 label writeback: reclassify resets reviewed=false, so
      // the new decision is auto and intermediate. We still write the
      // label (the spec calls out reclassify-to-skip should flip the
      // label) — uncertain decisions are silently no-op'd inside
      // applyTriageLabel.
      await applyTriageLabel({
        mapId: req.params.mapId,
        externalId: row.externalId,
        decision: decision.decision,
      });

      // Phase 3 follow-up (#102 item 7): notify connected clients.
      broadcastTriageUpdated(req.params.mapId, 'reclassified', [row.id]);

      return reply.send({
        decisionId: row.id,
        decision: decision.decision,
        confidence: decision.confidence,
        reason: decision.reason,
        parentNodeId: decision.parentNodeId ?? null,
        // Surface the (potentially-just-nulled) placedNodeId so the
        // client doesn't need a refetch to learn the row no longer
        // references the previously-placed node (Ray's #100 nit).
        placedNodeId: clearPlacedNode ? null : (row.placedNodeId ?? null),
        // Suggested parent reflects the LLM's new pick — surfaced so
        // the operator's next Override modal can pre-select it without
        // a refetch. Always matches what was just written to the row.
        suggestedParentNodeId: newSuggestedParentNodeId,
      });
    },
  );

  // ── Phase 2 bulk routes (#95) ─────────────────────────────────
  //
  // Design notes:
  //   - All three bulk routes accept `{ decisionIds: string[] }` and
  //     iterate per-item. Per-item failures (404, validation, race)
  //     don't fail the batch — the response shape is always
  //     `{ results: [{ id, status: 'ok', ... } | { id, error: { code, message } }, ... ] }`
  //     with HTTP 200, so the client can render per-row outcomes.
  //   - The single-item routes above remain the source of truth for
  //     semantics: bulk handlers call into the same DB primitives and
  //     guards (notably the SELF_LOOP_BLOCKED check on
  //     bulk-override). We do NOT internally re-route through HTTP —
  //     that would double the round-trip cost and lose the per-item
  //     error context.
  //   - We don't wrap the batch in a single DB transaction. If one
  //     item fails, the others have already committed; an all-or-
  //     nothing wrapper would mean "the operator selected 30 rows,
  //     the 27th was deleted by a concurrent operator, the other 29
  //     successful confirms get rolled back" — much worse UX than
  //     per-item idempotency for the bulk-confirm/orphan-cleanup use
  //     case. Per-item failures are surfaced for the operator to
  //     inspect.
  //   - All three require `edit` permission (same as their single-
  //     item counterparts) and reject API-key auth (the #69 / #100
  //     hardening — leaked keys must not fan out across all rows).
  //   - Body validation: `decisionIds` must be a non-empty array of
  //     strings, hard-capped at 20 (Phase 3 follow-up #102 item 1 —
  //     lowered from 200). Bulk routes iterate per-item, so a batch
  //     of 200 LLM calls on `bulk-reclassify` blocks a single HTTP
  //     connection for 6-10 min. The 20-cap keeps round-trips short
  //     enough that the operator gets feedback per click; for an
  //     orphan-cleanup that touches a few hundred rows, the client
  //     submits a few batches instead. Bulk-confirm + bulk-override
  //     pay the same cap even though they're cheaper than reclassify
  //     — uniform limits across the three bulk routes keep the
  //     client-side gating simple ("if selectedCount > 20, hide the
  //     bulk button").

  const BULK_DECISION_CAP = 20;

  function validateBulkBody(
    body: unknown,
  ): { ok: true; ids: string[] } | { ok: false; reply: { status: number; code: string; message: string } } {
    const b = body as { decisionIds?: unknown } | null | undefined;
    const ids = b?.decisionIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      return {
        ok: false,
        reply: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'decisionIds must be a non-empty array',
        },
      };
    }
    if (ids.length > BULK_DECISION_CAP) {
      return {
        ok: false,
        reply: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: `decisionIds is capped at ${BULK_DECISION_CAP} per request`,
        },
      };
    }
    const onlyStrings = ids.every((x) => typeof x === 'string' && x.length > 0);
    if (!onlyStrings) {
      return {
        ok: false,
        reply: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'decisionIds must contain non-empty strings',
        },
      };
    }
    // Dedupe — silently. A double-tap in the UI shouldn't cause two
    // confirm writes; the second would be a no-op against the new
    // reviewed=true state but might surprise the operator with a
    // duplicate row in `results`.
    return { ok: true, ids: Array.from(new Set(ids as string[])) };
  }

  interface BulkItemOk {
    id: string;
    status: string;
    nodeId?: string | null;
    decision?: 'place' | 'skip' | 'uncertain';
    confidence?: number;
    reason?: string;
    placedNodeId?: string | null;
    suggestedParentNodeId?: string | null;
  }
  interface BulkItemErr {
    id: string;
    error: { code: string; message: string };
  }
  type BulkItem = BulkItemOk | BulkItemErr;

  // ── POST /api/maps/:mapId/triage-decisions/bulk-confirm ──────
  // Body: { decisionIds: string[] }
  // Per-item: marks reviewed=true, decidedBy='operator', stamps
  // reviewedAt/By. Does NOT touch parentage. Mirrors single
  // /confirm semantics.
  app.post<{
    Params: { mapId: string };
    Body: { decisionIds?: unknown };
  }>(
    '/api/maps/:mapId/triage-decisions/bulk-confirm',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }
      const userId = req.userId as string;
      const validation = validateBulkBody(req.body);
      if (!validation.ok) {
        return reply.status(validation.reply.status).send({
          error: { code: validation.reply.code, message: validation.reply.message },
        });
      }

      const results: BulkItem[] = [];
      // Phase 3 follow-up (#104 item 11): collect per-row label-write
      // promises and settle them in parallel after the DB loop. The
      // single-row applyTriageLabel call is two sequential GH API hits
      // (POST add + DELETE remove). With N=20 rows that's 40 sequential
      // round-trips ≈ 8-12 s; parallelizing across rows drops to
      // ~max(per-row) ≈ 200-500 ms while keeping the per-row label
      // writes themselves sequential (the in-helper add-then-remove
      // order matters so the issue never has both labels at once).
      const labelWrites: Array<Promise<void>> = [];
      for (const id of validation.ids) {
        const [row] = await db
          .select()
          .from(triageDecisions)
          .where(
            and(
              eq(triageDecisions.id, id),
              eq(triageDecisions.mapId, req.params.mapId),
            ),
          );
        if (!row) {
          results.push({
            id,
            error: {
              code: 'NOT_FOUND',
              message: `Triage decision ${id} not found in map ${req.params.mapId}`,
            },
          });
          continue;
        }
        try {
          await db
            .update(triageDecisions)
            .set({
              decidedBy: 'operator',
              reviewed: true,
              reviewedAt: new Date(),
              reviewedBy: userId,
            })
            .where(eq(triageDecisions.id, row.id));
          await recordTriageHistory({
            decisionId: row.id,
            changedBy: userId,
            changeType: 'confirmed',
            previousDecision: row.decision,
            newDecision: row.decision,
            previousConfidence: row.confidence,
            newConfidence: row.confidence,
            previousParentNodeId: row.placedNodeId ?? null,
            newParentNodeId: row.placedNodeId ?? null,
            reason: row.reason,
          });
          labelWrites.push(
            applyTriageLabel({
              mapId: req.params.mapId,
              externalId: row.externalId,
              decision: row.decision as 'place' | 'skip' | 'uncertain',
            }),
          );
          results.push({
            id,
            status: 'confirmed',
            nodeId: row.placedNodeId ?? null,
          });
        } catch (err) {
          results.push({
            id,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'confirm failed',
            },
          });
        }
      }
      // applyTriageLabel never throws (best-effort contract), but use
      // allSettled defensively so a future change can't accidentally
      // turn a label-write failure into a bulk-confirm failure.
      await Promise.allSettled(labelWrites);
      // Phase 3 follow-up (#102 item 7): notify on the rows that landed
      // in 'confirmed' status (skip per-row errors so the UI doesn't
      // refresh on no-ops).
      const confirmedIds = results
        .filter(
          (r): r is BulkItemOk =>
            (r as BulkItemOk).status === 'confirmed',
        )
        .map((r) => r.id);
      broadcastTriageUpdated(req.params.mapId, 'confirmed', confirmedIds);
      return reply.send({ mapId: req.params.mapId, results });
    },
  );

  // ── POST /api/maps/:mapId/triage-decisions/bulk-override ─────
  // Body: { decisionIds: string[], parentNodeId: string }
  //
  // Per-item: applies the operator's chosen parent. Only valid for
  // rows whose CURRENT decision is `place` — per-item rejects rows
  // with `decision !== 'place'` (VALIDATION_ERROR, code
  // BULK_NOT_PLACE) so the operator can't accidentally move a
  // batch that mixed skips in. The single /override route accepts
  // a decision-change inside the body; this bulk route is
  // forced-move only, by design (the spec calls out "bulk override
  // is only valid for place decisions — gated client-side").
  //
  // Honors the SELF_LOOP_BLOCKED guard from Phase 1: a row whose
  // placedNodeId === supplied parentNodeId is rejected per-item.
  // Validates parentNodeId is in the map ONCE up front (cheaper
  // than re-validating per item; the operator can't shift the
  // parent mid-batch anyway).
  app.post<{
    Params: { mapId: string };
    Body: { decisionIds?: unknown; parentNodeId?: unknown };
  }>(
    '/api/maps/:mapId/triage-decisions/bulk-override',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }
      const userId = req.userId as string;
      const validation = validateBulkBody(req.body);
      if (!validation.ok) {
        return reply.status(validation.reply.status).send({
          error: { code: validation.reply.code, message: validation.reply.message },
        });
      }
      const parentNodeId = (req.body as { parentNodeId?: unknown })?.parentNodeId;
      if (typeof parentNodeId !== 'string' || parentNodeId.length === 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'parentNodeId is required',
          },
        });
      }
      // Up-front parent validation: must exist in this map.
      const [parent] = await db
        .select({ id: nodes.id, mapId: nodes.mapId })
        .from(nodes)
        .where(and(eq(nodes.id, parentNodeId), notDeleted));
      if (!parent || parent.mapId !== req.params.mapId) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'parentNodeId must be a node in this map',
          },
        });
      }

      const results: BulkItem[] = [];
      // Phase 3 follow-up (#104 item 11): collect label-write promises
      // and settle in parallel after the DB loop (see bulk-confirm note).
      const labelWrites: Array<Promise<void>> = [];
      for (const id of validation.ids) {
        const [row] = await db
          .select()
          .from(triageDecisions)
          .where(
            and(
              eq(triageDecisions.id, id),
              eq(triageDecisions.mapId, req.params.mapId),
            ),
          );
        if (!row) {
          results.push({
            id,
            error: {
              code: 'NOT_FOUND',
              message: `Triage decision ${id} not found in map ${req.params.mapId}`,
            },
          });
          continue;
        }
        // Per-item guard ordering (Phase 3 follow-up #102 item 4):
        // BULK_NOT_PLACE is checked BEFORE SELF_LOOP_BLOCKED. Both
        // codes are precise enough to be useful on their own, but
        // BULK_NOT_PLACE is more informative to the operator —
        // "this row was skip, not place, you didn't mean to move it"
        // is more actionable than "your parent equals the placed
        // node, which can't happen anyway because the row isn't
        // place." Reversing the order would surface SELF_LOOP_BLOCKED
        // on rows that aren't even place-eligible, which is misleading.
        if (row.decision !== 'place') {
          // Per spec: forced-move is `place`-only. A row currently
          // marked skip/uncertain must be sent through the single
          // /override route (which accepts decision-change), not
          // this bulk one. The client-side gate already filters this,
          // but defense-in-depth at the server.
          results.push({
            id,
            error: {
              code: 'BULK_NOT_PLACE',
              message: `decision must be 'place' for bulk-override (got '${row.decision}')`,
            },
          });
          continue;
        }
        // SELF_LOOP_BLOCKED (mirrors single /override).
        if (row.placedNodeId && row.placedNodeId === parentNodeId) {
          results.push({
            id,
            error: {
              code: 'SELF_LOOP_BLOCKED',
              message:
                'parentNodeId must differ from the placed node — use /confirm to mark reviewed without reparenting',
            },
          });
          continue;
        }
        try {
          let nodeId: string | null = null;
          let status: string;
          if (row.placedNodeId) {
            // Reparent the already-placed node. Phase 3 follow-up
            // (#102 item 5) distinguishes three sub-states for the
            // bulk-override response:
            //   - 'orphaned'       — row.placedNodeId set, but the node
            //                        was deleted between auto-apply and
            //                        the operator's bulk action; nothing
            //                        to move.
            //   - 'already_correct' — node exists, parent already matches
            //                         the operator's pick; nothing to
            //                         move (previously 'already_placed').
            //   - 'moved'          — node existed, parent differed, move
            //                        succeeded.
            // The split is a strict refinement of the previous
            // `already_placed` bucket — distinguishing "we couldn't
            // move because the node is gone" from "we didn't need to
            // move" lets the operator decide whether to chase the
            // orphan (delete the dangling row or re-place a new node).
            const placedNodeId = row.placedNodeId as string;
            const [placedNode] = await db
              .select({ id: nodes.id, parentId: nodes.parentId })
              .from(nodes)
              .where(and(eq(nodes.id, placedNodeId), notDeleted));
            let subStatus: 'moved' | 'already_correct' | 'orphaned';
            if (!placedNode) {
              subStatus = 'orphaned';
            } else if (placedNode.parentId === parentNodeId) {
              subStatus = 'already_correct';
            } else {
              const movedNode = await nodeDb.moveNode(placedNodeId, parentNodeId);
              if (movedNode != null) {
                subStatus = 'moved';
                broadcast(req.params.mapId, {
                  type: 'node:moved',
                  nodeId: placedNodeId,
                  newParentId: parentNodeId,
                  position: undefined,
                });
              } else {
                // moveNode returned null — treat as orphaned (the node
                // disappeared between the select and the move).
                subStatus = 'orphaned';
              }
            }
            await db
              .update(triageDecisions)
              .set({
                decision: 'place',
                confidence: 100,
                decidedBy: 'operator',
                decidedAt: new Date(),
                reviewed: true,
                reviewedAt: new Date(),
                reviewedBy: userId,
              })
              .where(eq(triageDecisions.id, row.id));
            await recordTriageHistory({
              decisionId: row.id,
              changedBy: userId,
              changeType: 'overridden',
              previousDecision: row.decision,
              newDecision: 'place',
              previousConfidence: row.confidence,
              newConfidence: 100,
              previousParentNodeId: row.placedNodeId ?? null,
              newParentNodeId: parentNodeId,
              reason: row.reason,
            });
            labelWrites.push(
              applyTriageLabel({
                mapId: req.params.mapId,
                externalId: row.externalId,
                decision: 'place',
              }),
            );
            nodeId = placedNodeId;
            status = subStatus;
          } else {
            // Create a node under parentNodeId. Same shape as the
            // single /override place path — single tx so a crash
            // doesn't leave a triage row with a half-attached node.
            const isClosed = row.issueState === 'closed';
            const created = await db.transaction(async (tx) => {
              const node = await nodeDb.createNode(
                {
                  mapId: req.params.mapId,
                  parentId: parentNodeId,
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
              await tx
                .update(triageDecisions)
                .set({
                  decision: 'place',
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
            });
            if (created) {
              broadcast(req.params.mapId, {
                type: 'node:created',
                node: created,
                source: 'triage_bulk_override',
              });
            }
            nodeId = created?.id ?? null;
            status = 'placed';
            await recordTriageHistory({
              decisionId: row.id,
              changedBy: userId,
              changeType: 'overridden',
              previousDecision: row.decision,
              newDecision: 'place',
              previousConfidence: row.confidence,
              newConfidence: 100,
              previousParentNodeId: row.placedNodeId ?? null,
              newParentNodeId: nodeId,
              reason: row.reason,
            });
            labelWrites.push(
              applyTriageLabel({
                mapId: req.params.mapId,
                externalId: row.externalId,
                decision: 'place',
              }),
            );
          }
          results.push({ id, status, nodeId });
        } catch (err) {
          results.push({
            id,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'override failed',
            },
          });
        }
      }
      await Promise.allSettled(labelWrites);
      // Phase 3 follow-up (#102 item 7): notify on rows that actually
      // mutated state (moved + placed + already_correct + orphaned all
      // imply a row was reviewed/updated; only per-row errors are excluded).
      const mutatedIds = results
        .filter((r): r is BulkItemOk => 'status' in r)
        .map((r) => r.id);
      broadcastTriageUpdated(req.params.mapId, 'overridden', mutatedIds);
      return reply.send({ mapId: req.params.mapId, results });
    },
  );

  // ── POST /api/maps/:mapId/triage-decisions/bulk-reclassify ───
  // Body: { decisionIds: string[] }
  //
  // Per-item: re-runs `triageIssue` against the current map
  // context and updates the row in place. Each row pays one LLM
  // call. The client should show a per-item progress counter; the
  // response includes per-id results so the UI can render
  // success/error inline. Building the map context once (outside
  // the loop) keeps the per-item cost to just the LLM call.
  //
  // Mirrors single /reclassify semantics: decidedBy='auto',
  // reviewed=false, and a non-place outcome clears a previously-
  // set placedNodeId (mindblown#99 fix 4).
  app.post<{
    Params: { mapId: string };
    Body: { decisionIds?: unknown };
  }>(
    '/api/maps/:mapId/triage-decisions/bulk-reclassify',
    async (req, reply) => {
      const gate = await gateMapAccess(req, req.params.mapId, 'edit');
      if (gate) {
        return reply.status(gate.status).send({
          error: { code: gate.code, message: gate.message },
        });
      }
      const validation = validateBulkBody(req.body);
      if (!validation.ok) {
        return reply.status(validation.reply.status).send({
          error: { code: validation.reply.code, message: validation.reply.message },
        });
      }

      // One map context pull serves all rows in the batch — the
      // context is the same regardless of which row we're re-
      // evaluating, and `buildMapContext` is the heavy call.
      const mapContext = await buildMapContext(req.params.mapId);

      const results: BulkItem[] = [];
      // Phase 3 follow-up (#104 item 11): parallel label writes (see
      // bulk-confirm note).
      const labelWrites: Array<Promise<void>> = [];
      for (const id of validation.ids) {
        const [row] = await db
          .select()
          .from(triageDecisions)
          .where(
            and(
              eq(triageDecisions.id, id),
              eq(triageDecisions.mapId, req.params.mapId),
            ),
          );
        if (!row) {
          results.push({
            id,
            error: {
              code: 'NOT_FOUND',
              message: `Triage decision ${id} not found in map ${req.params.mapId}`,
            },
          });
          continue;
        }
        try {
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
          const clearPlacedNode =
            decision.decision !== 'place' && row.placedNodeId != null;
          // Mirror single /reclassify: refresh the LLM's suggested
          // parent on every bulk re-classify call. Operator overrides
          // never touch this column; every LLM-driven write does.
          const newSuggestedParentNodeId =
            decision.decision === 'place'
              ? (decision.parentNodeId ?? null)
              : null;
          await db
            .update(triageDecisions)
            .set({
              decision: decision.decision,
              reason: decision.reason,
              confidence: decision.confidence,
              suggestedParentNodeId: newSuggestedParentNodeId,
              decidedBy: 'auto',
              decidedAt: new Date(),
              reviewed: false,
              reviewedAt: null,
              reviewedBy: null,
              ...(clearPlacedNode ? { placedNodeId: null } : {}),
            })
            .where(eq(triageDecisions.id, row.id));
          const newParent = clearPlacedNode
            ? null
            : decision.decision === 'place'
              ? (decision.parentNodeId ?? row.placedNodeId ?? null)
              : (row.placedNodeId ?? null);
          await recordTriageHistory({
            decisionId: row.id,
            changedBy: 'auto',
            changeType: 'reclassified',
            previousDecision: row.decision,
            newDecision: decision.decision,
            previousConfidence: row.confidence,
            newConfidence: decision.confidence,
            previousParentNodeId: row.placedNodeId ?? null,
            newParentNodeId: newParent,
            reason: decision.reason,
          });
          labelWrites.push(
            applyTriageLabel({
              mapId: req.params.mapId,
              externalId: row.externalId,
              decision: decision.decision,
            }),
          );
          results.push({
            id,
            status: 'reclassified',
            decision: decision.decision,
            confidence: decision.confidence,
            reason: decision.reason,
            placedNodeId: clearPlacedNode ? null : (row.placedNodeId ?? null),
            suggestedParentNodeId: newSuggestedParentNodeId,
          });
        } catch (err) {
          results.push({
            id,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'reclassify failed',
            },
          });
        }
      }
      await Promise.allSettled(labelWrites);
      // Phase 3 follow-up (#102 item 7): notify on the rows that
      // landed in 'reclassified' status; per-row errors don't refresh.
      const reclassifiedIds = results
        .filter(
          (r): r is BulkItemOk =>
            (r as BulkItemOk).status === 'reclassified',
        )
        .map((r) => r.id);
      broadcastTriageUpdated(req.params.mapId, 'reclassified', reclassifiedIds);
      return reply.send({ mapId: req.params.mapId, results });
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
