import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { integrations, versions, nodes } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import {
  createGitHubIssue,
  getGitHubIssue,
  importGitHubIssues,
  extractVersionFromMilestone,
  processWebhook,
  verifyWebhookSignature,
  mintInstallationToken,
  isGitHubAppConfigured,
} from '@mindblown/integrations';
import { reconcileRepo } from '../sync/githubCatchup.js';
import { rollupParentsForChildTitle } from '../sync/parentEpicRollup.js';
import type { ExternalLink } from '@mindblown/core';
import { broadcast } from '../ws.js';
import { maps } from '../db/schema.js';

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
// Tries the map's own GitHub App binding first, falls back to the
// workspace PAT integration.

export interface GitHubMapContext {
  owner: string;
  repo: string;
  token: string;
}

export async function getGitHubContextForMap(mapId: string): Promise<GitHubMapContext | null> {
  const [map] = await db.select({
    githubInstallationId: maps.githubInstallationId,
    githubRepoOwner: maps.githubRepoOwner,
    githubRepoName: maps.githubRepoName,
    workspaceId: maps.workspaceId,
  }).from(maps).where(eq(maps.id, mapId));

  if (!map) return null;

  // Try App installation binding first
  if (map.githubInstallationId && map.githubRepoOwner && map.githubRepoName) {
    try {
      const token = await mintInstallationToken(map.githubInstallationId);
      return { owner: map.githubRepoOwner, repo: map.githubRepoName, token };
    } catch (err) {
      console.warn('[github] Failed to mint installation token, falling back to PAT:', err);
    }
  }

  // Fallback: workspace PAT integration
  const integration = await getGitHubIntegration(map.workspaceId);
  if (integration) {
    return { owner: integration.config.owner, repo: integration.config.repo, token: integration.config.token };
  }

  return null;
}

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
  const allNodes = await db.select({ id: nodes.id, externalLinks: nodes.externalLinks }).from(nodes);
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
        .where(eq(nodes.mapId, req.params.mapId));

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
        .where(eq(nodes.mapId, req.params.mapId));

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
            .where(eq(nodes.id, textMatchId));
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

    // Special handling for issues.closed / issues.reopened: preserve and restore
    // the pre-close progress + status so reopening a partially-completed issue
    // doesn't discard the user's prior progress.
    const issuePayload = payload.issue as { number?: number; title?: string } | undefined;
    const payloadAction = payload.action as string | undefined;
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
