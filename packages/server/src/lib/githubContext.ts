/**
 * Forge client + repo resolution for a map.
 *
 * Extracted from `routes/integrations.ts` so non-route consumers (the
 * triage label writeback in `sync/triageLabelWriteback.ts`, etc.) can
 * resolve a client without dragging the route module — which would
 * create a routes ↔ sync import cycle.
 *
 * Resolution order:
 *   1. The map's own GitHub App installation binding (mint a fresh
 *      installation token → github.com client).
 *   2. The workspace's PAT integration row (any forge kind; the row's
 *      `provider` column is the kind, `config` may carry base URLs).
 *
 * Returns `null` when neither is configured.
 *
 * The file keeps its historical name (`githubContext`) and its historical
 * export (`getGitHubContextForMap`) because nine test files mock it by
 * path and name; `getForgeContextForMap` is the same function.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { integrations, maps } from '../db/schema.js';
import { GITHUB_ENDPOINT, type ForgeClient, type ForgeEndpoint } from '@mindblown/integrations';
import {
  FORGE_PROVIDERS,
  cachedForgeEndpointForMap,
  forgeEndpointFromIntegration,
  forgeFromInstallation,
  forgeFromIntegration,
  rememberForgeEndpointForMap,
  type ForgeIntegrationConfig,
} from './forge.js';

export interface ForgeMapContext {
  owner: string;
  repo: string;
  /** Raw token — kept for callers that log or compare it; prefer `forge`. */
  token: string;
  /** Authenticated client for this binding's forge. */
  forge: ForgeClient;
}

/** @deprecated use `ForgeMapContext` */
export type GitHubMapContext = ForgeMapContext;

async function getForgeIntegration(
  workspaceId: string,
): Promise<{ id: string; provider: string; config: ForgeIntegrationConfig } | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, workspaceId),
        inArray(integrations.provider, FORGE_PROVIDERS),
      ),
    );
  if (!row || !row.enabled) return null;
  return { id: row.id, provider: row.provider, config: row.config as unknown as ForgeIntegrationConfig };
}

export async function getGitHubContextForMap(
  mapId: string,
): Promise<ForgeMapContext | null> {
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
      const forge = await forgeFromInstallation(map.githubInstallationId);
      return {
        owner: map.githubRepoOwner,
        repo: map.githubRepoName,
        token: forge.token,
        forge,
      };
    } catch (err) {
      console.warn(
        '[github] Failed to mint installation token, falling back to PAT:',
        err,
      );
    }
  }

  // Fallback: workspace PAT integration
  const integration = await getForgeIntegration(map.workspaceId);
  if (integration) {
    const forge = forgeFromIntegration(integration);
    if (!forge) return null;
    return {
      owner: integration.config.owner,
      repo: integration.config.repo,
      token: integration.config.token,
      forge,
    };
  }

  return null;
}

/** Forge-neutral name for `getGitHubContextForMap` — same function. */
export const getForgeContextForMap = getGitHubContextForMap;

/**
 * The forge endpoint a map's binding points at, WITHOUT minting a token —
 * for building web URLs (triage rows carry only an externalId). An
 * App-bound map is github.com; a PAT row decides by its kind + URLs; an
 * unbound map falls back to github.com, which is what every link written
 * before #368 assumed.
 */
export async function getForgeEndpointForMap(mapId: string): Promise<ForgeEndpoint> {
  const hit = cachedForgeEndpointForMap(mapId);
  if (hit) return hit;
  const endpoint = await lookupForgeEndpointForMap(mapId);
  rememberForgeEndpointForMap(mapId, endpoint);
  return endpoint;
}

async function lookupForgeEndpointForMap(mapId: string): Promise<ForgeEndpoint> {
  const [map] = await db
    .select({
      githubInstallationId: maps.githubInstallationId,
      workspaceId: maps.workspaceId,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  if (!map) return GITHUB_ENDPOINT;
  if (map.githubInstallationId) return GITHUB_ENDPOINT;
  const integration = await getForgeIntegration(map.workspaceId);
  if (!integration) return GITHUB_ENDPOINT;
  return forgeEndpointFromIntegration(integration) ?? GITHUB_ENDPOINT;
}
