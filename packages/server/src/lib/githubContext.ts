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
 *   2. The workspace's PAT/OAuth integration row (any forge kind; the
 *      row's `provider` column is the kind, `config` may carry base URLs)
 *      — but only for a map whose own `github_repo_owner/name` names the
 *      row's repo (#421). The row supplies credentials and endpoint; the
 *      map says which repo it plans. Before #421 every map of the
 *      workspace inherited the row's repo, so re-binding the row to
 *      another repo silently re-pointed every non-App map at it.
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
import { GITHUB_ENDPOINT, mintScopedRepoToken, type ForgeClient, type ForgeEndpoint } from '@mindblown/integrations';
import type { TicketRepo } from '@mindblown/tool-kit';
import {
  FORGE_PROVIDERS,
  cachedForgeEndpointForMap,
  forgeEndpointFromIntegration,
  forgeFromInstallation,
  forgeFromIntegration,
  isServableIntegrationConfig,
  pickForgeRow,
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

/**
 * A workspace's forge row: the one for `owner/repo` when given, else the
 * newest enabled one. Rule in `pickForgeRow` (one row per repo).
 */
export async function getForgeIntegration(
  workspaceId: string,
  owner?: string | null,
  repo?: string | null,
): Promise<{ id: string; provider: string; config: ForgeIntegrationConfig } | null> {
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, workspaceId),
        inArray(integrations.provider, FORGE_PROVIDERS),
      ),
    );
  const row = pickForgeRow(rows, owner || repo ? { owner, repo } : {});
  if (!row) return null;
  return { id: row.id, provider: row.provider, config: row.config as unknown as ForgeIntegrationConfig };
}

interface MapBindingRow {
  githubInstallationId: string | null;
  githubRepoOwner: string | null;
  githubRepoName: string | null;
  workspaceId: string;
}

async function loadMapBinding(mapId: string): Promise<MapBindingRow | undefined> {
  const [map] = await db
    .select({
      githubInstallationId: maps.githubInstallationId,
      githubRepoOwner: maps.githubRepoOwner,
      githubRepoName: maps.githubRepoName,
      workspaceId: maps.workspaceId,
    })
    .from(maps)
    .where(eq(maps.id, mapId));
  return map;
}

/**
 * The workspace's forge row for THIS map's repo. A map without a repo of
 * its own is unbound (#421).
 */
async function patIntegrationForMap(
  map: MapBindingRow,
): Promise<{ id: string; provider: string; config: ForgeIntegrationConfig } | null> {
  if (!map.githubRepoOwner || !map.githubRepoName) return null;
  return getForgeIntegration(map.workspaceId, map.githubRepoOwner, map.githubRepoName);
}

/**
 * The map's forge kind for labels — cheap (no token minted, no network):
 * a GitHub App installation binding is GitHub; otherwise the workspace
 * forge row that binds this map decides; nothing bound → null.
 */
export async function getMapForgeKind(mapId: string): Promise<'github' | 'gitea' | null> {
  const map = await loadMapBinding(mapId);
  if (!map) return null;
  if (map.githubInstallationId) return 'github';
  const integration = await patIntegrationForMap(map);
  if (!integration) return null;
  return integration.provider === 'gitea' ? 'gitea' : 'github';
}

export async function getGitHubContextForMap(
  mapId: string,
): Promise<ForgeMapContext | null> {
  const map = await loadMapBinding(mapId);
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

  // Fallback: the workspace PAT/OAuth row — only if it binds this map.
  const integration = await patIntegrationForMap(map);
  if (integration) {
    const forge = await forgeFromIntegration(integration);
    if (!forge) return null;
    return {
      owner: integration.config.owner,
      repo: integration.config.repo,
      // The resolved token, not the raw config one — an OAuth-bound row
      // (#369) stores `token: ''` and authenticates through its identity.
      token: forge.token,
      forge,
    };
  }

  return null;
}

/** Forge-neutral name for `getGitHubContextForMap` — same function. */
export const getForgeContextForMap = getGitHubContextForMap;

/** Where a map's code lives, from its endpoint — no token. */
export function ticketRepo(endpoint: ForgeEndpoint, owner: string, name: string): TicketRepo {
  const web = endpoint.webBaseUrl.replace(/\/+$/, '');
  return {
    forge: endpoint.kind === 'gitea' ? 'gitea' : 'github',
    owner,
    name,
    webUrl: `${web}/${owner}/${name}`,
    cloneUrl: `${web}/${owner}/${name}.git`,
    apiBaseUrl: endpoint.apiBaseUrl,
  };
}

/**
 * The map's repo for a worker (#507), resolved like `getForgeContextForMap`
 * but without minting a token: the App binding first, else the workspace
 * row that binds this map. null = no repo connected.
 */
export async function getForgeRepoForMap(mapId: string): Promise<TicketRepo | null> {
  const map = await loadMapBinding(mapId);
  if (!map) return null;
  if (map.githubInstallationId && map.githubRepoOwner && map.githubRepoName) {
    return ticketRepo(GITHUB_ENDPOINT, map.githubRepoOwner, map.githubRepoName);
  }
  const integration = await patIntegrationForMap(map);
  if (!integration || !isServableIntegrationConfig(integration.config)) return null;
  const endpoint = forgeEndpointFromIntegration(integration);
  return endpoint ? ticketRepo(endpoint, integration.config.owner, integration.config.repo) : null;
}

/**
 * The repo and a token for a fleet worker (#507) — the same binding
 * `getForgeRepoForMap` reports, so the pull and the credentials never
 * disagree (no PAT fallback when an App mint fails). An App-bound map
 * gets a fresh token narrowed to this one repo (contents + pull requests);
 * a PAT/OAuth row can't be narrowed, so its token goes out as is.
 */
export async function getFleetRepoCredentials(mapId: string): Promise<{ repo: TicketRepo; token: string } | null> {
  const map = await loadMapBinding(mapId);
  if (!map) return null;
  if (map.githubInstallationId && map.githubRepoOwner && map.githubRepoName) {
    const minted = await mintScopedRepoToken(map.githubInstallationId, map.githubRepoName);
    return { repo: ticketRepo(GITHUB_ENDPOINT, map.githubRepoOwner, map.githubRepoName), token: minted.token };
  }
  const integration = await patIntegrationForMap(map);
  if (!integration || !isServableIntegrationConfig(integration.config)) return null;
  const forge = await forgeFromIntegration(integration);
  if (!forge) return null;
  return { repo: ticketRepo(forge.endpoint, integration.config.owner, integration.config.repo), token: forge.token };
}

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
  const map = await loadMapBinding(mapId);
  if (!map) return GITHUB_ENDPOINT;
  if (map.githubInstallationId) return GITHUB_ENDPOINT;
  const integration = await patIntegrationForMap(map);
  if (!integration) return GITHUB_ENDPOINT;
  return forgeEndpointFromIntegration(integration) ?? GITHUB_ENDPOINT;
}
