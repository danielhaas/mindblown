/**
 * GitHub token + repo resolution for a map.
 *
 * Extracted from `routes/integrations.ts` so non-route consumers (the
 * triage label writeback in `sync/triageLabelWriteback.ts`, etc.) can
 * resolve a token without dragging the route module — which would
 * create a routes ↔ sync import cycle.
 *
 * Resolution order:
 *   1. The map's own GitHub App installation binding (mint a fresh
 *      installation token).
 *   2. The workspace's legacy PAT integration row.
 *
 * Returns `null` when neither is configured.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { integrations, maps } from '../db/schema.js';
import { mintInstallationToken } from '@mindblown/integrations';

export interface GitHubMapContext {
  owner: string;
  repo: string;
  token: string;
}

interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  webhookSecret?: string;
}

async function getGitHubIntegration(
  workspaceId: string,
): Promise<{ id: string; config: GitHubConfig } | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, workspaceId),
        eq(integrations.provider, 'github'),
      ),
    );
  if (!row || !row.enabled) return null;
  return { id: row.id, config: row.config as unknown as GitHubConfig };
}

export async function getGitHubContextForMap(
  mapId: string,
): Promise<GitHubMapContext | null> {
  const [map] = await db
    .select({
      githubInstallationId: maps.githubInstallationId,
      githubRepoOwner: maps.githubRepoOwner,
      githubRepoName: maps.githubRepoName,
      workspaceId: maps.workspaceId,
    })
    .from(maps)
    .where(eq(maps.id, mapId));

  if (!map) return null;

  // Try App installation binding first
  if (
    map.githubInstallationId &&
    map.githubRepoOwner &&
    map.githubRepoName
  ) {
    try {
      const token = await mintInstallationToken(map.githubInstallationId);
      return {
        owner: map.githubRepoOwner,
        repo: map.githubRepoName,
        token,
      };
    } catch (err) {
      console.warn(
        '[github] Failed to mint installation token, falling back to PAT:',
        err,
      );
    }
  }

  // Fallback: workspace PAT integration
  const integration = await getGitHubIntegration(map.workspaceId);
  if (integration) {
    return {
      owner: integration.config.owner,
      repo: integration.config.repo,
      token: integration.config.token,
    };
  }

  return null;
}
