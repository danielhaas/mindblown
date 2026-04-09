import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { integrations, versions, milestones } from '../db/schema.js';
import { nodes } from '../db/schema.js';
import * as nodeDb from '../db/nodes.js';
import {
  createGitHubIssue,
  getGitHubIssue,
  importGitHubIssues,
  extractVersionFromMilestone,
  processWebhook,
  verifyWebhookSignature,
} from '@mindblown/integrations';
import type { ExternalLink } from '@mindblown/core';
import { broadcast } from '../ws.js';

// ── Helper: find integration config for a workspace ───────────────

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
  const { maps } = await import('../db/schema.js');
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

      // Get the workspace integration config for the token
      const workspaceId = await getWorkspaceIdForMap(req.params.mapId);
      if (!workspaceId) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      const integration = await getGitHubIntegration(workspaceId);
      if (!integration) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub integration not configured for this workspace' },
        });
      }

      // Fetch the issue from GitHub to get its URL
      const issue = await getGitHubIssue(body.owner, body.repo, body.issueNumber, integration.config.token);

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

      const workspaceId = await getWorkspaceIdForMap(req.params.mapId);
      if (!workspaceId) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      const integration = await getGitHubIntegration(workspaceId);
      if (!integration) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub integration not configured for this workspace' },
        });
      }

      const { owner, repo, token } = integration.config;

      // Create the issue on GitHub
      const { issue, externalLink } = await createGitHubIssue(node, owner, repo, token);

      // Store the link on the node
      const existingLinks = [...node.externalLinks];
      existingLinks.push(externalLink);

      const updated = await nodeDb.updateNode(req.params.nodeId, { externalLinks: existingLinks });

      broadcast(req.params.mapId, { type: 'node:updated', nodeId: req.params.nodeId, fields: ['externalLinks'], node: updated });

      return reply.status(201).send({ node: updated, issue });
    },
  );

  // ── POST /api/maps/:mapId/github/import ───────────────────────
  // Import issues from a GitHub repo into the map.
  app.post<{ Params: { mapId: string } }>(
    '/api/maps/:mapId/github/import',
    async (req, reply) => {
      const workspaceId = await getWorkspaceIdForMap(req.params.mapId);
      if (!workspaceId) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      const integration = await getGitHubIntegration(workspaceId);
      if (!integration) {
        return reply.status(400).send({
          error: { code: 'NO_INTEGRATION', message: 'GitHub integration not configured for this workspace' },
        });
      }

      const { owner, repo, token } = integration.config;

      // Determine root node for the map (we'll attach imported nodes under a group node)
      const { maps } = await import('../db/schema.js');
      const [map] = await db.select().from(maps).where(eq(maps.id, req.params.mapId));
      if (!map || !map.rootNodeId) {
        return reply.status(400).send({
          error: { code: 'MAP_INVALID', message: 'Map has no root node' },
        });
      }

      const body = req.body as { createdBy: string; parentNodeId?: string; includeAll?: boolean };
      if (!body.createdBy) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'createdBy is required' },
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

      // ── Create versions and milestones from GitHub milestones ────
      // Group by version prefix (e.g. "V1: 1a. Foo" → version "V1", milestone "Foo")
      // Collect unique milestones titles and their version prefix
      const milestoneInfoMap = new Map<string, { version: string; functionalName: string }>();
      for (const item of importedIssues) {
        if (!item.milestoneTitle || milestoneInfoMap.has(item.milestoneTitle)) continue;
        const version = extractVersionFromMilestone(item.milestoneTitle) ?? 'Unversioned';
        // The functional name is already stripped via groupLabel, but we need the milestone's own name
        const functionalName = item.milestoneTitle.replace(/^V\d+:\s*\d+[a-z]?\.\s*/i, '') || item.milestoneTitle;
        milestoneInfoMap.set(item.milestoneTitle, { version, functionalName });
      }

      // Create versions (deduplicated)
      const versionToId = new Map<string, string>();
      const uniqueVersions = new Set([...milestoneInfoMap.values()].map((m) => m.version));
      let sortOrder = 0;
      for (const versionName of uniqueVersions) {
        // Check if version already exists
        const existing = await db.select()
          .from(versions)
          .where(and(eq(versions.workspaceId, workspaceId!), eq(versions.name, versionName)));
        if (existing.length > 0) {
          versionToId.set(versionName, existing[0].id);
        } else {
          const [newVersion] = await db.insert(versions).values({
            workspaceId: workspaceId!,
            name: versionName,
            status: 'planning',
            sortOrder: sortOrder++,
          }).returning();
          versionToId.set(versionName, newVersion.id);
        }
      }

      // Create milestones (deduplicated)
      const milestoneToId = new Map<string, string>();
      let msSortOrder = 0;
      for (const [msTitle, info] of milestoneInfoMap) {
        // Check if milestone already exists
        const versionId = versionToId.get(info.version) ?? null;
        const existing = await db.select()
          .from(milestones)
          .where(and(eq(milestones.workspaceId, workspaceId!), eq(milestones.name, info.functionalName)));
        if (existing.length > 0) {
          milestoneToId.set(msTitle, existing[0].id);
        } else {
          const [newMs] = await db.insert(milestones).values({
            workspaceId: workspaceId!,
            versionId,
            name: info.functionalName,
            status: 'open',
            sortOrder: msSortOrder++,
          }).returning();
          milestoneToId.set(msTitle, newMs.id);
        }
      }

      // Build lookup: milestone title → { versionId, milestoneId }
      const milestoneToIds = new Map<string, { versionId: string | null; milestoneId: string }>();
      for (const [msTitle, info] of milestoneInfoMap) {
        milestoneToIds.set(msTitle, {
          versionId: versionToId.get(info.version) ?? null,
          milestoneId: milestoneToId.get(msTitle)!,
        });
      }

      // ── Group by functional label for tree structure ──────────────
      const groups = new Map<string, typeof importedIssues>();
      const ungrouped: typeof importedIssues = [];

      for (const item of importedIssues) {
        if (item.groupLabel) {
          const group = groups.get(item.groupLabel) ?? [];
          group.push(item);
          groups.set(item.groupLabel, group);
        } else {
          ungrouped.push(item);
        }
      }

      const createdNodes: Array<{ nodeId: string; issueNumber: number }> = [];

      // Helper to get version/milestone IDs for an issue
      const getIdsForIssue = (item: typeof importedIssues[0]) => {
        if (!item.milestoneTitle) return {};
        const ids = milestoneToIds.get(item.milestoneTitle);
        if (!ids) return {};
        return {
          ...(ids.versionId ? { versionId: ids.versionId } : {}),
          milestoneId: ids.milestoneId,
        };
      };

      // Create functional group branch nodes and their children
      for (const [label, items] of groups) {
        const branchNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId: parentNodeId,
          text: label,
          createdBy: body.createdBy,
        });

        for (const item of items) {
          const childNode = await nodeDb.createNode({
            mapId: req.params.mapId,
            parentId: branchNode.id,
            text: item.issue.title,
            createdBy: body.createdBy,
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

          createdNodes.push({ nodeId: childNode.id, issueNumber: item.issue.number });
        }
      }

      // Create ungrouped issues under a "Backlog" branch
      let ungroupedParent = parentNodeId;
      if (ungrouped.length > 0) {
        const backlogNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId: parentNodeId,
          text: 'Backlog',
          createdBy: body.createdBy,
        });
        ungroupedParent = backlogNode.id;
      }

      for (const item of ungrouped) {
        const childNode = await nodeDb.createNode({
          mapId: req.params.mapId,
          parentId: ungroupedParent,
          text: item.issue.title,
          createdBy: body.createdBy,
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

        createdNodes.push({ nodeId: childNode.id, issueNumber: item.issue.number });
      }

      broadcast(req.params.mapId, { type: 'github:imported', count: createdNodes.length });

      return reply.status(201).send({
        imported: createdNodes.length,
        nodes: createdNodes,
        versions: Object.fromEntries(versionToId),
        milestones: Object.fromEntries(milestoneToId),
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

    // Try to verify signature if we have a webhook secret
    // We need to find the integration by repo
    const repoFullName = (payload.repository as { full_name?: string })?.full_name;
    if (repoFullName) {
      // Find matching integration by repo name
      const allIntegrations = await db.select().from(integrations).where(eq(integrations.provider, 'github'));
      for (const integ of allIntegrations) {
        const config = integ.config as unknown as GitHubConfig;
        if (`${config.owner}/${config.repo}` === repoFullName && config.webhookSecret) {
          const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
          const valid = await verifyWebhookSignature(rawBody, signature, config.webhookSecret);
          if (!valid) {
            return reply.status(401).send({ error: 'Invalid webhook signature' });
          }
          break;
        }
      }
    }

    // Special handling for issues.closed / issues.reopened: preserve and restore
    // the pre-close progress + status so reopening a partially-completed issue
    // doesn't discard the user's prior progress.
    const issuePayload = payload.issue as { number?: number } | undefined;
    const payloadAction = payload.action as string | undefined;
    if (
      event === 'issues' &&
      issuePayload?.number != null &&
      repoFullName &&
      (payloadAction === 'closed' || payloadAction === 'reopened')
    ) {
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

      // Get workspace integration for token
      const workspaceId = await getWorkspaceIdForMap(req.params.mapId);
      if (!workspaceId) {
        return reply.status(404).send({
          error: { code: 'MAP_NOT_FOUND', message: `Map ${req.params.mapId} not found` },
        });
      }

      const integration = await getGitHubIntegration(workspaceId);
      if (!integration) {
        return reply.send({ linked: true, issues: githubLinks, status: 'no_integration' });
      }

      // Fetch current status from GitHub for each linked issue
      const issueStatuses = await Promise.all(
        githubLinks.map(async (link) => {
          const match = link.externalId.match(/^(.+?)\/(.+?)#(\d+)$/);
          if (!match) return { externalId: link.externalId, error: 'invalid_id' };

          try {
            const issue = await getGitHubIssue(match[1], match[2], parseInt(match[3], 10), integration.config.token);
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
