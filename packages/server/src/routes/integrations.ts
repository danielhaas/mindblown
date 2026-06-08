import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { integrations, versions, nodes, triageDecisions } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import { notDeleted } from '../db/nodes.js';
import {
  createGitHubIssue,
  getGitHubIssue,
  importGitHubIssues,
  extractVersionFromMilestone,
  extractClosingIssueRefs,
  processWebhook,
  verifyWebhookSignature,
  mintInstallationToken,
  isGitHubAppConfigured,
} from '@mindblown/integrations';
import { reconcileRepo } from '../sync/githubCatchup.js';
import { runDriftAudit } from '../sync/driftAudit.js';
import { recordWebhookCall } from '../sync/webhookAuthCheck.js';
import { requireAdmin } from '../auth.js';
import { rollupParentsForChildTitle } from '../sync/parentEpicRollup.js';
import {
  ingestNewIssuesForRepo,
  ensureInboxNode,
  ensureNodeForIssue,
  findNodesByExternalIds,
} from '../sync/githubIngest.js';
import { triageIssue } from '../sync/triage.js';
import { buildMapContext } from '../sync/mapContext.js';
import { recordTriageHistory } from '../sync/triageHistory.js';
import { applyTriageLabel } from '../sync/triageLabelWriteback.js';
import type { GitHubIssue } from '@mindblown/integrations';
import type { ExternalLink } from '@mindblown/core';
import { broadcast } from '../ws.js';
import { maps } from '../db/schema.js';
import {
  getGitHubContextForMap as getGitHubContextForMapImpl,
  type GitHubMapContext as GitHubMapContextImpl,
} from '../lib/githubContext.js';

// ── Helper: find integration config for a workspace (legacy PAT) ──

interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  webhookSecret?: string;
}

async function getGitHubIntegration(workspaceId: string): Promise<{ id: string; config: GitHubConfig } | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'github')));

  if (!row || !row.enabled) return null;
  return { id: row.id, config: row.config as unknown as GitHubConfig };
}

// ── Helper: resolve GitHub token + repo for a map ─────────────────
// Canonical impl lives in `lib/githubContext.ts` so non-route consumers
// (the Phase 3 triage label writeback in `sync/triageLabelWriteback.ts`)
// can import it without creating a routes ↔ sync cycle. The named
// exports below are kept for back-compat with `routes/nodes.ts` and any
// other site that already imports them from this file.

export type GitHubMapContext = GitHubMapContextImpl;
export const getGitHubContextForMap = getGitHubContextForMapImpl;

/**
 * Resolve a GitHub token + repo for a given `owner/repo`, scanning every
 * map's App binding then every workspace's PAT integration. Used by the
 * parent-epic rollup, which fires on webhook events for child PRs that
 * may have no linked node themselves — so we can't go via a mapId.
 *
 * Best-effort: returns the first successfully-minted token. Errors minting
 * an App token (revoked install, etc.) fall through to PAT.
 */
async function getGitHubContextForRepo(
  fullName: string,
): Promise<GitHubMapContext | null> {
  const slashIdx = fullName.indexOf('/');
  if (slashIdx <= 0) return null;
  const owner = fullName.slice(0, slashIdx);
  const repo = fullName.slice(slashIdx + 1);

  // App bindings first
  const appMaps = await db
    .select({
      installationId: maps.githubInstallationId,
      owner: maps.githubRepoOwner,
      repo: maps.githubRepoName,
    })
    .from(maps)
    .where(
      and(
        eq(maps.githubRepoOwner, owner),
        eq(maps.githubRepoName, repo),
      ),
    );
  for (const m of appMaps) {
    if (!m.installationId) continue;
    try {
      const token = await mintInstallationToken(m.installationId);
      return { owner, repo, token };
    } catch (err) {
      console.warn('[github] Failed to mint installation token in repo lookup:', err);
    }
  }

  // Fall back to any PAT integration that points at this repo
  const patIntegrations = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, 'github'), eq(integrations.enabled, true)));
  for (const integ of patIntegrations) {
    const cfg = integ.config as unknown as GitHubConfig;
    if (cfg?.owner === owner && cfg?.repo === repo && cfg?.token) {
      return { owner, repo, token: cfg.token };
    }
  }

  return null;
}

// ── Helper: find node by external ID ──────────────────────────────

async function findNodeByExternalId(externalId: string): Promise<string | null> {
  // Search all nodes for matching externalLink
  const allNodes = await db
    .select({ id: nodes.id, externalLinks: nodes.externalLinks })
    .from(nodes)
    .where(notDeleted);
  for (const node of allNodes) {
    const links = (node.externalLinks as ExternalLink[]) ?? [];
    if (links.some((l) => l.provider === 'github' && l.externalId === externalId)) {
      return node.id;
    }
  }
  return null;
}

// ── Helper: get workspace ID for a map ────────────────────────────

async function getWorkspaceIdForMap(mapId: string): Promise<string | null> {
  const [row] = await db.select({ workspaceId: maps.workspaceId }).from(maps).where(eq(maps.id, mapId));
  return row?.workspaceId ?? null;
}

// ── Triage lifecycle helper (#95 Phase 2) ─────────────────────────
//
// Sync existing triage_decisions rows after an `issues.reopened`
// webhook. Two responsibilities:
//   1. Refresh issue_state='open' on every row matching externalId,
//      regardless of operator-reviewed state or map's triage_enabled.
//      The column is a passive mirror of GH state, used by the UI
//      filter; keeping it stale would degrade Phase 2's open/closed
//      filter quality.
//   2. For maps whose triage_enabled is still true AND whose row is
//      NOT operator-reviewed, re-run `triageIssue` with the current
//      map context and upsert the new decision in place.
//      Operator-reviewed rows are immutable here — the operator
//      explicitly hits Re-classify in the UI to override their own
//      call (#100 Round 2 / mindblown#99 fix 2).
//
// Re-triage failures per-row are swallowed (warn + continue) so a
// flaky LLM doesn't block the issue_state refresh on sibling rows.
//
// Exported for tests; called from the webhook handler when
// payloadAction === 'reopened'.
export async function syncTriageRowsForReopen(
  externalId: string,
  issue: GitHubIssue | undefined,
): Promise<void> {
  // Snapshot every row matching this externalId BEFORE we update — we
  // need the prior decision/confidence/placedNode for the history rows
  // we'll write for the issue_state refresh, AND for any subsequent
  // re-triage. One select reused for both passes.
  const matchingRows = await db
    .select({
      id: triageDecisions.id,
      mapId: triageDecisions.mapId,
      issueTitle: triageDecisions.issueTitle,
      placedNodeId: triageDecisions.placedNodeId,
      reviewed: triageDecisions.reviewed,
      decidedBy: triageDecisions.decidedBy,
      decision: triageDecisions.decision,
      confidence: triageDecisions.confidence,
      reason: triageDecisions.reason,
    })
    .from(triageDecisions)
    .where(eq(triageDecisions.externalId, externalId));

  // (1) Refresh issue_state on every matching row.
  await db
    .update(triageDecisions)
    .set({ issueState: 'open' })
    .where(eq(triageDecisions.externalId, externalId));

  // Phase 3 audit log — one 'state_synced' row per touched decision.
  // Decision/confidence/parent don't change here, so previous_ == new_.
  for (const row of matchingRows) {
    await recordTriageHistory({
      decisionId: row.id,
      changedBy: 'auto',
      changeType: 'state_synced',
      previousDecision: row.decision,
      newDecision: row.decision,
      previousConfidence: row.confidence,
      newConfidence: row.confidence,
      previousParentNodeId: row.placedNodeId ?? null,
      newParentNodeId: row.placedNodeId ?? null,
      reason: row.reason,
    });
  }

  // (2) Re-triage every (map, externalId) where the map is still
  // triage_enabled AND the row is not operator-reviewed.
  const candidates = matchingRows;

  for (const row of candidates) {
    // Operator-reviewed guard.
    if (row.reviewed === true && row.decidedBy === 'operator') {
      continue;
    }
    // Map-level triage_enabled gate.
    const [mapRow] = await db
      .select({ triageEnabled: maps.triageEnabled })
      .from(maps)
      .where(eq(maps.id, row.mapId));
    if (!mapRow || mapRow.triageEnabled !== true) {
      continue;
    }

    try {
      const mapContext = await buildMapContext(row.mapId);
      // Prefer the webhook-supplied issue body / title (operator may
      // have edited GH-side); fall back to the row title if the
      // payload didn't carry one (defensive — `issues.reopened`
      // always includes the issue object).
      const decision = await triageIssue({
        issue: issue ?? {
          id: 0,
          number: 0,
          title: row.issueTitle,
          body: null,
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          html_url: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        mapContext,
      });

      // Clear placedNodeId when reclassify lands on a non-place
      // decision and we had a placed node previously (mindblown#99
      // fix 4 — orphan cleanup).
      const clearPlacedNode =
        decision.decision !== 'place' && row.placedNodeId != null;
      // The reopen-driven re-triage is an LLM call — refresh the
      // suggested-parent column with the new pick (null on
      // skip/uncertain). Operator overrides never touch this field;
      // every LLM-driven write does.
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
      // Phase 3 audit log — re-triage on reopen is recorded as 'auto'
      // since the LLM produced the new call.
      const reopenNewParent = clearPlacedNode
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
        newParentNodeId: reopenNewParent,
        reason: decision.reason,
      });
      // Phase 3 follow-up (#104 item 9): when a reopen-driven re-triage
      // flips the decision (place ↔ skip), the corresponding GitHub
      // label must follow. The earlier impl wrote the history row but
      // never called applyTriageLabel here, so a reclassify on reopen
      // could leave the previously-set `triage:placed` / `triage:skipped`
      // label stale. Best-effort, internally gated on the per-map
      // `triage_label_writeback` flag, mirrors the call in routes/triage.ts.
      await applyTriageLabel({
        mapId: row.mapId,
        externalId,
        decision: decision.decision,
      });
    } catch (err) {
      console.warn(
        `[triage-reopen] re-triage failed for row ${row.id} (map ${row.mapId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────

export async function integrationRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/integrations/github/connect ─────────────────────
  // Store GitHub token + repo info for a workspace.
  app.post('/api/integrations/github/connect', async (req, reply) => {
    const body = req.body as {
      workspaceId: string;
      token: string;
      owner: string;
      repo: string;
      webhookSecret?: string;
    };

    if (!body.workspaceId || !body.token || !body.owner || !body.repo) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'workspaceId, token, owner, and repo are required' },
      });
    }

    // Upsert: check if integration already exists
    const existing = await getGitHubIntegration(body.workspaceId);

    const config: GitHubConfig = {
      owner: body.owner,
      repo: body.repo,
      token: body.token,
      webhookSecret: body.webhookSecret,
    };

    if (existing) {
      // Update existing
      await db
        .update(integrations)
        .set({ config, enabled: true, updatedAt: new Date() })
        .where(eq(integrations.id, existing.id));

      return reply.send({ id: existing.id, provider: 'github', enabled: true });
    }

    // Create new
    const [row] = await db
      .insert(integrations)
      .values({
        workspaceId: body.workspaceId,
        provider: 'github',
        config,
        enabled: true,
      })
      .returning();

    return reply.status(201).send({ id: row.id, provider: 'github', enabled: true });
  });

  // ── POST /api/maps/:mapId/nodes/:nodeId/github/link ───────────
  // Link a node to an existing GitHub Issue.
  app.post<{ Params: { mapId: string; nodeId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/github/link',
    async (req, reply) => {
      const body = req.body as { owner: string; repo: string; issueNumber: number };

      if (!body.owner || !body.repo || !body.issueNumber) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'owner, repo, and issueNumber are required' },
        });
      }

      const node = await nodeDb.getNode(req.params.nodeId);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      // Get GitHub token for this map
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }

      // Fetch the issue from GitHub to get its URL
      const issue = await getGitHubIssue(body.owner, body.repo, body.issueNumber, ghCtx.token);

      const externalLink: ExternalLink = {
        provider: 'github',
        externalId: `${body.owner}/${body.repo}#${body.issueNumber}`,
        url: issue.html_url,
        syncEnabled: true,
        lastSyncedAt: new Date().toISOString(),
      };

      // Add to existing external links
      const existingLinks = node.externalLinks.filter(
        (l) => !(l.provider === 'github' && l.externalId === externalLink.externalId),
      );
      existingLinks.push(externalLink);

      const updated = await nodeDb.updateNode(req.params.nodeId, { externalLinks: existingLinks });

      broadcast(req.params.mapId, { type: 'node:updated', nodeId: req.params.nodeId, fields: ['externalLinks'], node: updated });

      return reply.send({ node: updated, issue });
    },
  );

  // ── POST /api/maps/:mapId/nodes/:nodeId/github/create ─────────
  // Create a new GitHub Issue from a node and link it.
  app.post<{ Params: { mapId: string; nodeId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/github/create',
    async (req, reply) => {
      const node = await nodeDb.getNode(req.params.nodeId);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }

      // Create the issue on GitHub
      const { issue, externalLink } = await createGitHubIssue(node, ghCtx.owner, ghCtx.repo, ghCtx.token);

      // Store the link on the node
      const existingLinks = [...node.externalLinks];
      existingLinks.push(externalLink);

      const updated = await nodeDb.updateNode(req.params.nodeId, { externalLinks: existingLinks });

      broadcast(req.params.mapId, { type: 'node:updated', nodeId: req.params.nodeId, fields: ['externalLinks'], node: updated });

      return reply.status(201).send({ node: updated, issue });
    },
  );

  // ── GET /api/maps/:mapId/github/sync-overview ─────────────────
  // Three-way diff: nodes linked to issues (synced), leaf nodes with no
  // GitHub link (onlyInMindBlown), and repo issues not linked to any node
  // in this map (onlyInGitHub). Makes the cross-system state auditable.
  app.get<{ Params: { mapId: string }; Querystring: { includeClosed?: string } }>(
    '/api/maps/:mapId/github/sync-overview',
    async (req, reply) => {
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }

      const includeClosed = req.query.includeClosed === 'true';
      const { owner, repo, token } = ghCtx;

      // Fetch all nodes in this map
      const mapNodes = await db
        .select({
          id: nodes.id,
          text: nodes.text,
          parentId: nodes.parentId,
          externalLinks: nodes.externalLinks,
        })
        .from(nodes)
        .where(and(eq(nodes.mapId, req.params.mapId), notDeleted));

      // Identify parents so we can separate leaves from structural branches.
      const parentIdSet = new Set<string>();
      for (const n of mapNodes) {
        if (n.parentId) parentIdSet.add(n.parentId);
      }

      // Build lookup: externalId → { nodeId, text } for anything already linked.
      const linkedByExternalId = new Map<string, { nodeId: string; text: string }>();
      for (const n of mapNodes) {
        const links = (n.externalLinks as ExternalLink[]) ?? [];
        for (const l of links) {
          if (l.provider === 'github' && l.externalId) {
            linkedByExternalId.set(l.externalId, { nodeId: n.id, text: n.text });
          }
        }
      }

      // Fetch issues from GitHub via the existing importer (we discard the
      // group/milestone metadata and just use the raw issue objects).
      let importedIssues;
      try {
        importedIssues = await importGitHubIssues(owner, repo, token, { includeAll: includeClosed });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'GITHUB_API_ERROR',
            message: err instanceof Error ? err.message : 'Failed to fetch GitHub issues',
          },
        });
      }

      // Bucket 1: synced — fuse node + issue for each link we recognize.
      // Bucket 3: onlyInGitHub — issues whose externalId isn't linked in this map.
      const synced: Array<{
        nodeId: string;
        text: string;
        externalId: string;
        issueNumber: number;
        issueUrl: string;
        issueState: 'open' | 'closed';
        issueTitle: string;
      }> = [];
      const onlyInGitHub: Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        url: string;
      }> = [];
      for (const item of importedIssues) {
        const match = linkedByExternalId.get(item.externalLink.externalId);
        if (match) {
          synced.push({
            nodeId: match.nodeId,
            text: match.text,
            externalId: item.externalLink.externalId,
            issueNumber: item.issue.number,
            issueUrl: item.issue.html_url,
            issueState: item.issue.state,
            issueTitle: item.issue.title,
          });
        } else {
          onlyInGitHub.push({
            issueNumber: item.issue.number,
            title: item.issue.title,
            state: item.issue.state,
            url: item.issue.html_url,
          });
        }
      }

      // Bucket 2: onlyInMindBlown — leaf nodes with no GitHub link.
      // Leaves (no children) are the actionable unit; branches are structural
      // and would pollute the list.
      const onlyInMindBlown: Array<{ nodeId: string; text: string }> = [];
      for (const n of mapNodes) {
        if (parentIdSet.has(n.id)) continue; // has children → structural
        if (n.parentId === null) continue; // root → never a GitHub issue
        const links = (n.externalLinks as ExternalLink[]) ?? [];
        const hasGithub = links.some((l) => l.provider === 'github');
        if (hasGithub) continue;
        onlyInMindBlown.push({ nodeId: n.id, text: n.text });
      }

      return reply.send({
        repo: `${owner}/${repo}`,
        includeClosed,
        counts: {
          synced: synced.length,
          onlyInMindBlown: onlyInMindBlown.length,
          onlyInGitHub: onlyInGitHub.length,
        },
        synced,
        onlyInMindBlown,
        onlyInGitHub,
      });
    },
  );

  // ── POST /api/maps/:mapId/github/import ───────────────────────
  // Import issues from a GitHub repo into the map.
  app.post<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/github/import',
    async (req, reply) => {
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }

      const { owner, repo, token } = ghCtx;

      // Get workspace ID for version creation
      const workspaceId = await getWorkspaceIdForMap(req.params.mapId);

      // Determine root node for the map (we'll attach imported nodes under a group node)
      const [map] = await db.select().from(maps).where(eq(maps.id, req.params.mapId));
      if (!map || !map.rootNodeId) {
        return reply.status(400).send({
          error: { code: 'MAP_INVALID', message: 'Map has no root node' },
        });
      }

      const body = req.body as { createdBy?: string; parentNodeId?: string; includeAll?: boolean };
      // Prefer the authenticated user (req.userId from the JWT middleware) over
      // any body.createdBy the caller sent — the nodes table requires a real
      // user UUID and we don't want callers (e.g. the MCP tool) passing sentinel
      // strings that fail the UUID column constraint.
      const createdBy = req.userId ?? body.createdBy;
      if (!createdBy) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'createdBy is required (authenticate or pass a user UUID)' },
        });
      }

      const parentNodeId = body.parentNodeId ?? map.rootNodeId;

      // Fetch issues from GitHub (optionally include closed issues for full roadmap)
      let importedIssues;
      try {
        importedIssues = await importGitHubIssues(owner, repo, token, {
          includeAll: body.includeAll,
        });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'GITHUB_API_ERROR',
            message: err instanceof Error ? err.message : 'Failed to fetch GitHub issues',
          },
        });
      }

      // ── Create versions from GitHub milestone prefixes ────────────
      // GitHub milestone titles like "V1: 1a. Foo" parse to version "V1".
      // The full milestone title also maps issues to their functional
      // group node below (via item.groupLabel, computed by the import).
      const versionByMilestoneTitle = new Map<string, string>();
      const uniqueVersions = new Set<string>();
      for (const item of importedIssues) {
        if (!item.milestoneTitle) continue;
        const versionName = extractVersionFromMilestone(item.milestoneTitle) ?? 'Unversioned';
        uniqueVersions.add(versionName);
        versionByMilestoneTitle.set(item.milestoneTitle, versionName);
      }

      const versionToId = new Map<string, string>();
      let sortOrder = 0;
      for (const versionName of uniqueVersions) {
        const existing = await db.select()
          .from(versions)
          .where(and(eq(versions.mapId, req.params.mapId), eq(versions.name, versionName)));
        if (existing.length > 0) {
          versionToId.set(versionName, existing[0].id);
        } else {
          const [newVersion] = await db.insert(versions).values({
            workspaceId: workspaceId!,
            mapId: req.params.mapId,
            name: versionName,
            status: 'planning',
            sortOrder: sortOrder++,
          }).returning();
          versionToId.set(versionName, newVersion.id);
        }
      }

      const createdNodes: Array<{ nodeId: string; issueNumber: number }> = [];
      const linkedNodes: Array<{ nodeId: string; issueNumber: number }> = [];
      const skippedNodes: Array<{ nodeId: string; issueNumber: number }> = [];

      // ── Build lookups of existing nodes in this map for dedup ──────
      // Dedup rules:
      //   1. If an existing node already has this issue's externalId linked → skip.
      //   2. Else if an existing node's text matches the issue title (trimmed,
      //      case-insensitive), attach the externalLink to that node instead
      //      of creating a duplicate.
      const existingNodes = await db
        .select({ id: nodes.id, text: nodes.text, externalLinks: nodes.externalLinks })
        .from(nodes)
        .where(and(eq(nodes.mapId, req.params.mapId), notDeleted));

      const normalizeText = (s: string) => s.trim().toLowerCase();
      const existingByExternalId = new Map<string, string>();
      const existingByText = new Map<string, string>();
      for (const n of existingNodes) {
        const links = (n.externalLinks as ExternalLink[]) ?? [];
        for (const l of links) {
          if (l.provider === 'github' && l.externalId) {
            existingByExternalId.set(l.externalId, n.id);
          }
        }
        const key = normalizeText(n.text);
        // First-match wins; don't overwrite if multiple existing nodes share text.
        if (!existingByText.has(key)) existingByText.set(key, n.id);
      }

      // ── Hierarchy resolution ──────────────────────────────────────
      // importGitHubIssues already inferred parentNumber (task-list + body
      // "Parent: #N" patterns). We now want each child issue to land under
      // its parent's node, falling through to milestone/label grouping only
      // when no parent can be resolved in this batch or in pre-existing nodes.
      const importedByNumber = new Map<number, typeof importedIssues[0]>();
      for (const item of importedIssues) {
        importedByNumber.set(item.issue.number, item);
      }

      const externalIdOf = (n: number) => `${owner}/${repo}#${n}`;
      const nodeIdByIssueNumber = new Map<number, string>();

      // An item is a "root" in the import iff it has no parentNumber, or its
      // parent isn't anywhere reachable (not in this batch, not in the DB).
      // Roots are the ones that need group/Backlog branch placement; everything
      // else attaches to a concrete parent node id.
      const isRootForImport = (item: typeof importedIssues[0]): boolean => {
        if (item.parentNumber == null) return true;
        if (importedByNumber.has(item.parentNumber)) return false;
        if (existingByExternalId.has(externalIdOf(item.parentNumber))) return false;
        return true;
      };

      const resolveParentNode = (
        item: typeof importedIssues[0],
      ): string | null => {
        if (item.parentNumber == null) return null;
        const fromBatch = nodeIdByIssueNumber.get(item.parentNumber);
        if (fromBatch) return fromBatch;
        const fromExisting = existingByExternalId.get(externalIdOf(item.parentNumber));
        if (fromExisting) return fromExisting;
        return null;
      };

      // ── Group ROOTS by functional label for branch creation ───────
      // (Child items will attach to their parent node and bypass this entirely.)
      const groups = new Map<string, typeof importedIssues>();
      const ungrouped: typeof importedIssues = [];
      for (const item of importedIssues) {
        if (!isRootForImport(item)) continue;
        if (item.groupLabel) {
          const group = groups.get(item.groupLabel) ?? [];
          group.push(item);
          groups.set(item.groupLabel, group);
        } else {
          ungrouped.push(item);
        }
      }

      // Helper to get the version ID for an issue
      const getIdsForIssue = (item: typeof importedIssues[0]) => {
        if (!item.milestoneTitle) return {};
        const versionName = versionByMilestoneTitle.get(item.milestoneTitle);
        if (!versionName) return {};
        const versionId = versionToId.get(versionName);
        return versionId ? { versionId } : {};
      };

      // Process one issue: skip / link-to-existing / create-new under getParentId.
      // Returns the resolved node id (whether newly created, linked to an
      // existing match, or already-linked skip) so children can attach to it.
      // `getParentId` is lazy so we don't create empty branch nodes when every
      // item in a group ends up routed to an existing node.
      const processItem = async (
        item: typeof importedIssues[0],
        getParentId: () => Promise<string>,
      ): Promise<string> => {
        // (1) Already linked?
        const existingId = existingByExternalId.get(item.externalLink.externalId);
        if (existingId) {
          skippedNodes.push({ nodeId: existingId, issueNumber: item.issue.number });
          return existingId;
        }

        // (2) Text match on an unlinked existing node?
        const textMatchId = existingByText.get(normalizeText(item.issue.title));
        if (textMatchId) {
          // Append externalLink to the existing node's links (preserve any existing links).
          const [row] = await db
            .select({ externalLinks: nodes.externalLinks })
            .from(nodes)
            .where(and(eq(nodes.id, textMatchId), notDeleted));
          const existingLinks = (row?.externalLinks as ExternalLink[]) ?? [];
          await nodeDb.updateNode(textMatchId, {
            externalLinks: [...existingLinks, item.externalLink],
          });
          // Remember that this externalId is now linked so later items in the
          // same batch can't re-link it.
          existingByExternalId.set(item.externalLink.externalId, textMatchId);
          linkedNodes.push({ nodeId: textMatchId, issueNumber: item.issue.number });
          return textMatchId;
        }

        // (3) Create new child under the branch (lazy — only create branch if needed).
        const parentId = await getParentId();
        const childNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId,
          text: item.issue.title,
          createdBy,
        });

        const priority = item.issue.labels
          .map((l) => l.name)
          .find((n) => n.startsWith('priority:'))
          ?.slice('priority:'.length) ?? null;

        await nodeDb.updateNode(childNode.id, {
          externalLinks: [item.externalLink],
          tags: item.issue.labels.map((l) => l.name).filter((n) => !n.startsWith('priority:')),
          description: item.issue.body,
          ...(priority ? { priority: priority as import('@mindblown/core').Priority } : {}),
          ...getIdsForIssue(item),
          ...(item.issue.state === 'closed' ? { percentComplete: 100 } : {}),
        });

        existingByExternalId.set(item.externalLink.externalId, childNode.id);
        existingByText.set(normalizeText(item.issue.title), childNode.id);
        createdNodes.push({ nodeId: childNode.id, issueNumber: item.issue.number });
        return childNode.id;
      };

      // ── Phase A: process ROOTS through group/Backlog branches ─────
      const branchIds = new Map<string, string>();
      const ensureBranch = (label: string) => async (): Promise<string> => {
        const cached = branchIds.get(label);
        if (cached) return cached;
        const branchNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId: parentNodeId,
          text: label,
          createdBy,
        });
        branchIds.set(label, branchNode.id);
        return branchNode.id;
      };
      let backlogId: string | null = null;
      const ensureBacklog = async (): Promise<string> => {
        if (backlogId) return backlogId;
        const backlogNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId: parentNodeId,
          text: 'Backlog',
          createdBy,
        });
        backlogId = backlogNode.id;
        return backlogId;
      };

      for (const [label, items] of groups) {
        const ensureThisBranch = ensureBranch(label);
        for (const item of items) {
          const nodeId = await processItem(item, ensureThisBranch);
          nodeIdByIssueNumber.set(item.issue.number, nodeId);
        }
      }
      for (const item of ungrouped) {
        const nodeId = await processItem(item, ensureBacklog);
        nodeIdByIssueNumber.set(item.issue.number, nodeId);
      }

      // ── Phase B: process CHILDREN, draining parents-first ─────────
      // Each pass picks up items whose parent is now known (either freshly
      // created in Phase A, created earlier in this loop, or pre-existing in
      // the DB). Loops until a pass makes no progress — anything still left
      // is a cycle remainder the parser couldn't break, flushed as a root.
      const pendingChildren = importedIssues.filter((i) => !isRootForImport(i));
      let madeProgress = true;
      while (pendingChildren.length > 0 && madeProgress) {
        madeProgress = false;
        for (let i = 0; i < pendingChildren.length; ) {
          const item = pendingChildren[i];
          const parentNodeId = resolveParentNode(item);
          if (parentNodeId == null) {
            i++;
            continue;
          }
          const nodeId = await processItem(item, async () => parentNodeId);
          nodeIdByIssueNumber.set(item.issue.number, nodeId);
          pendingChildren.splice(i, 1);
          madeProgress = true;
        }
      }
      // Cycle leftovers — fall through to group/Backlog so nothing is dropped.
      for (const item of pendingChildren) {
        const fallback = item.groupLabel
          ? ensureBranch(item.groupLabel)
          : ensureBacklog;
        const nodeId = await processItem(item, fallback);
        nodeIdByIssueNumber.set(item.issue.number, nodeId);
      }

      broadcast(req.params.mapId, { type: 'github:imported', count: createdNodes.length });

      return reply.status(201).send({
        imported: createdNodes.length,
        linked: linkedNodes.length,
        skipped: skippedNodes.length,
        nodes: createdNodes,
        linkedNodes,
        skippedNodes,
        versions: Object.fromEntries(versionToId),
      });
    },
  );

  // ── POST /api/maps/sync/audit-drift ───────────────────────────
  // Manual trigger for the daily drift-audit sweep. Returns:
  //   - `reports`      — DriftReport[] (one per map with drift)
  //   - `tokenErrors`  — TokenError[] for maps whose binding couldn't
  //                      resolve a token (App install revoked, PAT
  //                      expired/missing). Surfaced here so operators
  //                      see binding failures without SSH-ing for logs.
  //   - `autoBackfill` — what the auto-backfill pass did
  //   - `counts`       — flat numeric summary for dashboards
  // Admin-only: the audit iterates EVERY opted-in map across EVERY
  // workspace and returns map names + repo bindings, so gating below
  // admin would leak cross-workspace metadata and let any logged-in
  // user fan out N GitHub API calls per request.
  app.post('/api/maps/sync/audit-drift', async (req, reply) => {
    if (!req.userId) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
    }
    // requireAdmin also rejects API-key auth (see auth.ts) — see #69:
    // a leaked admin's mb_… key must not be able to fan this audit out
    // across every workspace.
    if (!(await requireAdmin(req))) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    }

    try {
      // runDriftAudit triggers the same auto-backfill code path the
      // daily scheduler uses — manual + scheduled paths must produce
      // identical outcomes (incl. the Kuma push) so operators can use
      // this endpoint to test the auto-repair flow without waiting 24h.
      const result = await runDriftAudit();
      if (result.error) {
        return reply.status(500).send({
          error: {
            code: 'DRIFT_AUDIT_FAILED',
            message: result.error,
          },
        });
      }
      return reply.send({
        reports: result.reports,
        tokenErrors: result.tokenErrors,
        autoBackfill: result.autoBackfill,
        counts: {
          driftedMaps: result.reports.length,
          totalDriftedIssues: result.reports.reduce((n, r) => n + r.onlyInGitHub, 0),
          autoBackfilled: result.autoBackfill.totalImported,
          manualPending: result.autoBackfill.totalManualPending,
          tokenErrors: result.tokenErrors.length,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        error: {
          code: 'DRIFT_AUDIT_FAILED',
          message: err instanceof Error ? err.message : 'Drift audit failed',
        },
      });
    }
  });

  // ── POST /api/maps/:mapId/github/reconcile ────────────────────
  // On-demand catch-up reconcile for the repo bound to this map.
  // Webhooks normally drive realtime sync; this endpoint is the manual
  // escape hatch when webhooks have been missed (downtime, secret
  // mismatch). Same code path the periodic catch-up uses.
  app.post<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/github/reconcile',
    async (req, reply) => {
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }

      const result = await reconcileRepo({
        owner: ghCtx.owner,
        repo: ghCtx.repo,
        // Token captured at request time. The reconcile completes within
        // a single HTTP turn, so we don't need to re-mint mid-flight.
        resolveToken: async () => ghCtx.token,
      });

      if (result.error) {
        return reply.status(502).send({ error: { code: 'GITHUB_RECONCILE_FAILED', message: result.error }, result });
      }
      return reply.send(result);
    },
  );

  // ── POST /api/maps/:mapId/github/ingest-new ───────────────────
  // Bulk-ingest GitHub issues that aren't linked to any node anywhere
  // into this map's Inbox. Open issues + issues closed within the last
  // 30 days are eligible. Hard-capped at 200 per call to avoid runaway
  // backfills — the toggle-on flow surfaces this via the wouldImport
  // dry-run count.
  app.post<{
    Params: { mapId: string };
    Querystring: { dryRun?: string };
  }>(
    '/api/maps/:mapId/github/ingest-new',
    async (req, reply) => {
      const userId = req.userId;
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub not configured for this map. Link a repo in settings first.' },
        });
      }
      const dryRun = req.query.dryRun === 'true';

      // Pull the map row so we can resolve the createdBy for the inbox
      // and the bound (owner, repo). We don't require autoImportNewIssues
      // to be on here — backfill is an explicit user action.
      const [mapRow] = await db.select().from(maps).where(eq(maps.id, req.params.mapId));
      if (!mapRow) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      // Fetch all repo issues (including closed) and filter to unlinked +
      // (open OR closed-within-30d). Skip PRs — importGitHubIssues already
      // filters those out for us.
      let importedIssues;
      try {
        importedIssues = await importGitHubIssues(ghCtx.owner, ghCtx.repo, ghCtx.token, {
          includeAll: true,
        });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'GITHUB_API_ERROR',
            message: err instanceof Error ? err.message : 'Failed to fetch GitHub issues',
          },
        });
      }

      const allExternalIds = importedIssues.map((i) => i.externalLink.externalId);
      const linkedIds = await findNodesByExternalIds(allExternalIds);

      const CLOSED_WINDOW_DAYS = 30;
      const cutoffMs = Date.now() - CLOSED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const candidates = importedIssues
        .filter((item) => !linkedIds.has(item.externalLink.externalId))
        .filter((item) => {
          if (item.issue.state === 'open') return true;
          if (!item.issue.closed_at) return true;
          const closed = new Date(item.issue.closed_at).getTime();
          if (Number.isNaN(closed)) return true;
          return closed >= cutoffMs;
        });

      if (dryRun) {
        return reply.send({
          wouldImport: candidates.length,
          candidates: candidates.map((c) => c.issue.number),
        });
      }

      const HARD_CAP = 200;
      const total = candidates.length;
      const slice = candidates.slice(0, HARD_CAP);

      // Force-ingest the slice into JUST THIS map even if the map's
      // autoImportNewIssues toggle is off — backfill is an explicit
      // user action. We bypass findIngestTargetMaps and inline the
      // ensureInboxNode + ensureNodeForIssue loop.
      const createdBy = userId ?? (mapRow.createdBy as string);
      let imported = 0;
      try {
        const inboxId = await ensureInboxNode(req.params.mapId, createdBy);
        for (const item of slice) {
          try {
            const result = await ensureNodeForIssue(
              req.params.mapId,
              inboxId,
              item.issue,
              { owner: ghCtx.owner, repo: ghCtx.repo, createdBy },
              { allowClosedWithinDays: CLOSED_WINDOW_DAYS },
            );
            if (result.status === 'created') imported++;
          } catch (err) {
            console.warn(
              `[github-ingest] backfill item failed (#${item.issue.number}):`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } catch (err) {
        return reply.status(500).send({
          error: {
            code: 'INBOX_ENSURE_FAILED',
            message: err instanceof Error ? err.message : 'Failed to ensure GitHub Inbox',
          },
        });
      }

      return reply.send({
        imported,
        capped: total > HARD_CAP,
        total,
      });
    },
  );

  // ── POST /api/webhooks/github ─────────────────────────────────
  // Webhook endpoint for GitHub events.
  app.post('/api/webhooks/github', async (req, reply) => {
    const event = req.headers['x-github-event'] as string;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!event) {
      return reply.status(400).send({ error: 'Missing X-GitHub-Event header' });
    }

    // Parse payload
    const payload = req.body as Record<string, unknown>;

    // Verify webhook signature — try App webhook secret first, then PAT secrets
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const repoFullName = (payload.repository as { full_name?: string })?.full_name;
    let signatureVerified = false;

    // Try GitHub App webhook secret
    if (isGitHubAppConfigured()) {
      const appWebhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
      if (appWebhookSecret && signature) {
        const valid = await verifyWebhookSignature(rawBody, signature, appWebhookSecret);
        if (valid) signatureVerified = true;
      }
    }

    // Try legacy PAT webhook secrets
    if (!signatureVerified && repoFullName) {
      const allIntegrations = await db.select().from(integrations).where(eq(integrations.provider, 'github'));
      for (const integ of allIntegrations) {
        const config = integ.config as unknown as GitHubConfig;
        if (`${config.owner}/${config.repo}` === repoFullName && config.webhookSecret) {
          const valid = await verifyWebhookSignature(rawBody, signature, config.webhookSecret);
          if (valid) {
            signatureVerified = true;
            break;
          }
        }
      }
    }

    // Feed the 24h rolling auth counter (see #74). We record EVERY
    // inbound webhook call — both pass and fail — so the daily
    // scheduler can detect "received N, all failed verification" =
    // the GH-side secret has rotated and mindblown's copy is stale.
    // Recorded BEFORE the 401 short-circuit below so failing calls
    // are counted even though we reject them.
    recordWebhookCall(signatureVerified);

    // Enforce signature verification for the entire webhook handler.
    // Before this guard, an attacker who knew the webhook URL could POST a
    // forged `issues.opened` payload and force inbox-node creation in every
    // opted-in map (attacker-controlled title/body) — and could equally
    // forge `issues.closed` / `issues.reopened` to flip status on existing
    // nodes. The signature was computed above but never required. We now
    // reject any unsigned/invalid-signed request before touching the DB.
    if (!signatureVerified) {
      return reply.status(401).send({ error: 'invalid signature' });
    }

    // Special handling for issues.closed / issues.reopened: preserve and restore
    // the pre-close progress + status so reopening a partially-completed issue
    // doesn't discard the user's prior progress.
    const issuePayload = payload.issue as { number?: number; title?: string } | undefined;
    const payloadAction = payload.action as string | undefined;

    // ── Auto-ingest new GitHub issues into the map's Inbox ──────────
    // Runs before the close/reopen state-sync below so a `reopened`
    // event creates the node (if it didn't exist) then state-sync
    // can no-op — they're not mutually exclusive. Failures are
    // swallowed so the webhook still acknowledges the underlying
    // event. The webhook covers opened / reopened / edited; the
    // catchup pass + manual backfill cover everything else.
    //
    // ── Cost-opt #142 layer 1: diff-aware skip on issues.edited ────
    // GitHub's `issues.edited` payload carries a `changes` object
    // listing what changed (e.g. `{ title: { from: '...' } }`,
    // `{ body: { from: '...' } }`). When the operator only added /
    // removed labels, assignees, or a milestone, `changes` is empty
    // (those edits emit their own `issues.labeled` / `unlabeled` /
    // `assigned` / `milestoned` actions, NOT a populated `changes`
    // entry on `edited`). Skip the LLM call in that case — labels
    // and milestone don't change the triage decision body (labels
    // are folded into the hash but only as ordering / set
    // membership; the LLM doesn't see them as decision signal),
    // and the bot churn of label-rules firing 5-10 edited events
    // per minute is exactly the worst-case workload this layer
    // targets. The state-sync block below still runs for closed/
    // reopened, so we don't lose lifecycle transitions.
    //
    // Skipped-edits intentionally don't accumulate triage_decisions
    // history rows ("metadata_only" never reaches recordTriageHistory)
    // so Phase 4 tuning-data collection isn't poisoned by edit-storm
    // noise.
    const isMetadataOnlyEdit =
      payloadAction === 'edited' &&
      (() => {
        const changes = payload.changes as
          | { title?: unknown; body?: unknown }
          | undefined;
        // Treat a missing/empty `changes` object as metadata-only.
        // The keys we care about are `title` and `body`; anything else
        // (`assignees`, `labels` in the rare cases GH does include
        // them) is metadata. GitHub omits the `changes` key entirely
        // on label-only edits, so the `!changes` arm covers that.
        if (!changes || typeof changes !== 'object') return true;
        return changes.title === undefined && changes.body === undefined;
      })();

    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      (payloadAction === 'opened' || payloadAction === 'reopened' || payloadAction === 'edited') &&
      !isMetadataOnlyEdit
    ) {
      const slashIdx = repoFullName.indexOf('/');
      if (slashIdx > 0) {
        const owner = repoFullName.slice(0, slashIdx);
        const repo = repoFullName.slice(slashIdx + 1);
        const issue = payload.issue as GitHubIssue | undefined;
        if (issue) {
          try {
            await ingestNewIssuesForRepo({ owner, repo }, [issue]);
          } catch (err) {
            console.warn(
              '[github-ingest] webhook ingest failed:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    }

    // ── Cost-opt #142 — metadata-only edit short-circuit ──────────
    // The `edited` action with no title/body change has no work for
    // the rest of the handler:
    //   - The state-sync block below is gated on `closed`/`reopened`
    //     (which doesn't include `edited`), so it's already a no-op.
    //   - The `processWebhook` fallthrough would update node text +
    //     description with the same values they already hold (the
    //     payload's title/body match what's already there, by virtue
    //     of `changes.title === undefined && changes.body === undefined`).
    //
    // Returning early keeps the DB write off the hot path and gives
    // the operator a clear status code in the webhook response —
    // useful for log greps when chasing LLM cost. The Phase 4 tuning
    // data collector explicitly filters this status out of triage
    // history rollups so label-bot storms don't poison the dataset.
    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      isMetadataOnlyEdit
    ) {
      return reply.send({
        received: true,
        action: 'issues.edited',
        matched: false,
        status: 'metadata_only_skipped',
      });
    }

    // ── Triage lifecycle: issues.reopened → re-triage (#95 Phase 2) ──
    //
    // Two passes per (map, externalId) where a triage_decisions row exists:
    //   (a) Always refresh `issue_state='open'` so the row reflects the
    //       current GH state — even if the map's triage_enabled was
    //       flipped off between the original decision and now, AND even
    //       when the row is operator-reviewed. issue_state is the
    //       row-level mirror of GH state, not a triage decision itself.
    //   (b) If the map still has triage_enabled=true AND the row is
    //       NOT operator-reviewed (reviewed=true AND decidedBy='operator'),
    //       re-run triageIssue and upsert the new decision in place.
    //       Operator-reviewed rows are immutable — the operator's call
    //       stands until they explicitly hit Re-classify. This mirrors
    //       the precheck-tx guard in ensureNodeForIssueViaTriage
    //       (mindblown#99 fix 2 / Ray's #100 Round 2 lost-race fix).
    //
    // We run this BEFORE the close/reopen state-sync block below because:
    //   - state-sync mutates the node row (status/percentComplete); the
    //     triage row update is independent (it's just metadata audit).
    //   - if re-triage produces a new auto-applied node placement, the
    //     state-sync block still handles the node-level open/close
    //     transition on whatever node was placed.
    //
    // Failures here are swallowed (warn + continue) — the webhook still
    // needs to acknowledge the underlying state-sync.
    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      payloadAction === 'reopened'
    ) {
      try {
        const externalId = `${repoFullName}#${issuePayload.number}`;
        await syncTriageRowsForReopen(externalId, payload.issue as GitHubIssue | undefined);
      } catch (err) {
        console.warn(
          '[triage-reopen] failed to refresh triage rows:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Mirror the issue_state for `closed` events too — same audit-row
    // contract, no re-triage needed. (The reclassify branch is
    // reopen-only; closed events just keep the audit row in sync.)
    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      payloadAction === 'closed'
    ) {
      try {
        const externalId = `${repoFullName}#${issuePayload.number}`;
        await db
          .update(triageDecisions)
          .set({ issueState: 'closed' })
          .where(eq(triageDecisions.externalId, externalId));
      } catch (err) {
        console.warn(
          '[triage-close] failed to refresh triage rows:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      (payloadAction === 'closed' || payloadAction === 'reopened')
    ) {
      // Parent-epic rollup (#57): if the closing/reopening issue's title
      // matches one of our child-PR patterns, recompute the parent epic's
      // progress. Runs regardless of whether the child itself has a linked
      // node — that's the whole point of the feature. Fire-and-forget so
      // the webhook response stays snappy and a fetch failure doesn't
      // prevent us from applying the primary state transition below.
      if (issuePayload.title) {
        const closingTitle = issuePayload.title;
        const closingRepo = repoFullName;
        (async () => {
          const ctx = await getGitHubContextForRepo(closingRepo);
          if (!ctx) return;
          try {
            await rollupParentsForChildTitle(closingTitle, ctx);
          } catch (err) {
            console.warn(
              '[parent-epic-rollup] Webhook rollup failed:',
              err instanceof Error ? err.message : err,
            );
          }
        })().catch(() => {});
      }

      const externalId = `${repoFullName}#${issuePayload.number}`;
      const nodeId = await findNodeByExternalId(externalId);
      const actionLabel = `issues.${payloadAction}`;
      if (!nodeId) {
        return reply.send({ received: true, action: actionLabel, matched: false });
      }

      const node = await nodeDb.getNode(nodeId);
      if (!node) {
        return reply.send({ received: true, action: actionLabel, matched: false });
      }

      const links = node.externalLinks.map((l) => ({ ...l }));
      const linkIdx = links.findIndex(
        (l) => l.provider === 'github' && l.externalId === externalId,
      );
      if (linkIdx < 0) {
        return reply.send({ received: true, action: actionLabel, matched: false });
      }

      let updates: nodeDb.UpdateNodeInput;
      if (payloadAction === 'closed') {
        // Capture current progress/status into the link so we can revert later.
        links[linkIdx] = {
          ...links[linkIdx],
          previousPercentComplete: node.percentComplete,
          previousStatus: node.status,
          lastSyncedAt: new Date().toISOString(),
        };
        updates = {
          percentComplete: 100,
          status: 'done',
          externalLinks: links,
        };
      } else {
        // reopened — revert to whatever was captured on the most recent close.
        // If we never saw a close (null), fall back to an in-progress state.
        const savedPct = links[linkIdx].previousPercentComplete;
        const savedStatus = links[linkIdx].previousStatus;
        links[linkIdx] = {
          ...links[linkIdx],
          previousPercentComplete: null,
          previousStatus: null,
          lastSyncedAt: new Date().toISOString(),
        };
        updates = {
          percentComplete: savedPct !== undefined ? savedPct : null,
          status: savedStatus !== undefined ? savedStatus : 'in_progress',
          externalLinks: links,
        };
      }

      const updated = await nodeDb.updateNode(nodeId, updates);
      if (updated) {
        broadcast(updated.mapId, {
          type: 'node:updated',
          nodeId,
          fields: Object.keys(updates),
          node: updated,
          source: 'github_webhook',
        });
      }

      return reply.send({
        received: true,
        action: actionLabel,
        matched: true,
        nodeId,
      });
    }

    // ── pull_request: closed + merged=true → transition linked nodes ─
    //
    // #152 — when a PR merges with `Closes #N` references in title or
    // body, transition every referenced issue's linked node to done.
    // Cuts the up-to-6h lag that the drift audit catches (catchup runs
    // every 5min but only flips state on issue-close webhooks, which
    // require the `issues` event subscription — not every repo has it).
    //
    // Iterates ALL refs (PR title + body), unlike the legacy
    // processWebhook PR branch which only returned the first. The
    // existing issues.closed handler still runs for repos subscribed
    // to that event — this branch is the PR-only-subscription path.
    //
    // Idempotent: a second webhook for the same PR (replay or
    // misconfigured retry) finds the node already at status='done' +
    // percentComplete=100 and emits no second transition.
    if (
      event === 'pull_request' &&
      payloadAction === 'closed' &&
      (payload.pull_request as { merged?: boolean } | undefined)?.merged === true &&
      repoFullName
    ) {
      const pr = payload.pull_request as {
        number: number;
        merged: boolean;
        body: string | null;
        title: string;
      };
      const refs = extractClosingIssueRefs(`${pr.title ?? ''} ${pr.body ?? ''}`);
      const transitions: Array<{
        externalId: string;
        nodeId: string;
        status: 'transitioned' | 'already_done' | 'not_linked';
      }> = [];

      for (const issueNumber of refs) {
        const externalId = `${repoFullName}#${issueNumber}`;
        const nodeId = await findNodeByExternalId(externalId);
        if (!nodeId) {
          transitions.push({ externalId, nodeId: '', status: 'not_linked' });
          continue;
        }
        const node = await nodeDb.getNode(nodeId);
        if (!node) {
          transitions.push({ externalId, nodeId, status: 'not_linked' });
          continue;
        }
        // Idempotency: replay → no second transition.
        if (node.status === 'done' && node.percentComplete === 100) {
          transitions.push({ externalId, nodeId, status: 'already_done' });
          continue;
        }
        const links = node.externalLinks.map((l) => ({ ...l }));
        const linkIdx = links.findIndex(
          (l) => l.provider === 'github' && l.externalId === externalId,
        );
        if (linkIdx >= 0) {
          links[linkIdx] = {
            ...links[linkIdx],
            previousPercentComplete: node.percentComplete,
            previousStatus: node.status,
            lastSyncedAt: new Date().toISOString(),
          };
        }
        const updates: nodeDb.UpdateNodeInput = {
          percentComplete: 100,
          status: 'done',
          externalLinks: links,
        };
        const updated = await nodeDb.updateNode(nodeId, updates);
        if (updated) {
          broadcast(updated.mapId, {
            type: 'node:updated',
            nodeId,
            fields: Object.keys(updates),
            node: updated,
            source: 'github_webhook_pr_merge',
          });
        }
        console.log(
          `[gh-webhook] PR #${pr.number} merged → transitioned node ${nodeId} (${externalId}) to done`,
        );
        transitions.push({ externalId, nodeId, status: 'transitioned' });
      }

      return reply.send({
        received: true,
        action: 'pull_request.merged',
        prNumber: pr.number,
        matched: transitions.some((t) => t.status === 'transitioned' || t.status === 'already_done'),
        transitions,
      });
    }

    // Process the webhook
    const result = processWebhook(payload as any, event);

    if (!result.nodeUpdates || !result.externalId) {
      // No actionable update — acknowledge receipt
      return reply.send({ received: true, action: result.action });
    }

    // Find the node linked to this external ID
    const nodeId = await findNodeByExternalId(result.externalId);
    if (!nodeId) {
      // No matching node — that's fine, just ack
      return reply.send({ received: true, action: result.action, matched: false });
    }

    // Apply updates
    const updated = await nodeDb.updateNode(nodeId, result.nodeUpdates as nodeDb.UpdateNodeInput);
    if (updated) {
      broadcast(updated.mapId, {
        type: 'node:updated',
        nodeId,
        fields: Object.keys(result.nodeUpdates),
        node: updated,
        source: 'github_webhook',
      });
    }

    return reply.send({
      received: true,
      action: result.action,
      matched: true,
      nodeId,
    });
  });

  // ── GET /api/maps/:mapId/nodes/:nodeId/github/status ──────────
  // Get linked issue status, PR status.
  app.get<{ Params: { mapId: string; nodeId: string } }>(
    '/api/maps/:mapId/nodes/:nodeId/github/status',
    async (req, reply) => {
      const node = await nodeDb.getNode(req.params.nodeId);
      if (!node) {
        return reply.status(404).send({
          error: { code: 'NODE_NOT_FOUND', message: `Node ${req.params.nodeId} not found` },
        });
      }

      const githubLinks = node.externalLinks.filter((l) => l.provider === 'github');
      if (githubLinks.length === 0) {
        return reply.send({ linked: false, issues: [] });
      }

      // Get GitHub token for this map
      const ghCtx = await getGitHubContextForMap(req.params.mapId);
      if (!ghCtx) {
        return reply.send({ linked: true, issues: githubLinks, status: 'no_integration' });
      }

      // Fetch current status from GitHub for each linked issue
      const issueStatuses = await Promise.all(
        githubLinks.map(async (link) => {
          const match = link.externalId.match(/^(.+?)\/(.+?)#(\d+)$/);
          if (!match) return { externalId: link.externalId, error: 'invalid_id' };

          try {
            const issue = await getGitHubIssue(match[1], match[2], parseInt(match[3], 10), ghCtx.token);
            return {
              externalId: link.externalId,
              url: link.url,
              state: issue.state,
              title: issue.title,
              labels: issue.labels.map((l) => l.name),
              assignees: issue.assignees.map((a) => a.login),
              updatedAt: issue.updated_at,
            };
          } catch (err) {
            return {
              externalId: link.externalId,
              error: err instanceof Error ? err.message : 'fetch_failed',
            };
          }
        }),
      );

      return reply.send({ linked: true, issues: issueStatuses });
    },
  );
}
