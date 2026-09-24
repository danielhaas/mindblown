/**
 * Server-side glue between DB rows and `ForgeClient` instances (#367).
 *
 * Two kinds of binding exist:
 *   - a GitHub App installation on the map (`maps.github_installation_id`)
 *     → always github.com, token minted per call;
 *   - a PAT row in `integrations` → `provider` is the forge kind
 *     (`github` | `gitea`), `config` carries owner/repo/token and, for a
 *     self-hosted forge, `apiBaseUrl` / `webBaseUrl`.
 *
 * Kept separate from `lib/githubContext.ts` so tests that mock that module
 * by path (nine of them) don't have to know about these helpers.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  createForgeClient,
  githubForge,
  isForgeKind,
  mintInstallationToken,
  resolveForgeEndpoint,
  GITHUB_ENDPOINT,
  type ForgeClient,
  type ForgeEndpoint,
  type ForgeKind,
} from '@mindblown/integrations';
import { db } from '../db/connection.js';
import { integrations, maps } from '../db/schema.js';
import { findGiteaIdentityById, giteaAccessTokenFor } from './giteaOAuth.js';

/**
 * Shape of `integrations.config` for a PAT-backed forge row. `apiBaseUrl`
 * and `webBaseUrl` are optional: rows written before #367 have neither
 * and mean github.com.
 */
export interface ForgeIntegrationConfig {
  owner: string;
  repo: string;
  /** PAT. Empty when the row is bound to an OAuth identity instead (#369). */
  token: string;
  webhookSecret?: string;
  apiBaseUrl?: string | null;
  webBaseUrl?: string | null;
  /**
   * `user_github_identities.id` of the Gitea OAuth identity whose (refreshed)
   * access token authenticates this binding. Set by the repo picker flow.
   */
  oauthIdentityId?: string | null;
}

/**
 * `provider` values that denote a forge. Querying with this list instead of
 * `'github'` keeps every existing row selected and lets a `gitea` row join
 * without touching the callers again. A literal (not `FORGE_KINDS` from
 * the integrations package) so it is safe under test mocks of that module;
 * the `satisfies` keeps it honest against the kind union.
 */
export const FORGE_PROVIDERS: string[] = ['github', 'gitea'] satisfies ForgeKind[];

/**
 * Can a forge integration row authenticate against its repo? A PAT row
 * carries `token`; an OAuth-bound row (#369) carries `token: ''` and an
 * `oauthIdentityId` whose access token `forgeFromIntegration` resolves. The
 * catch-up, drift-audit, ingest and route call sites all gate on this
 * instead of `cfg.token`, so OAuth rows are not silently skipped.
 */
export function isServableIntegrationConfig(cfg: Partial<ForgeIntegrationConfig> | null | undefined): boolean {
  return !!cfg && !!cfg.owner && !!cfg.repo && (!!cfg.token || !!cfg.oauthIdentityId);
}

/**
 * Build a client for a PAT integration row, or `null` when the row's kind
 * cannot be served by this build (a `gitea` row before #368 lands, or a
 * self-hosted row missing its URLs). Never throws: one bad row must skip
 * that repo, not fail the whole catch-up tick / drift audit it sits in.
 */
export async function forgeFromIntegration(row: { id?: string; provider: string; config: unknown }): Promise<ForgeClient | null> {
  const cfg = row.config as ForgeIntegrationConfig;
  try {
    let token = cfg.token;
    if (cfg.oauthIdentityId) {
      // OAuth-bound (Gitea sign-in, #369): a live token from the identity,
      // refreshed and re-stored when the stored one is about to expire.
      const identity = await findGiteaIdentityById(cfg.oauthIdentityId);
      if (!identity) {
        console.warn(`[forge] integration ${row.id ?? '?'} skipped: OAuth identity ${cfg.oauthIdentityId} is gone (user disconnected?)`);
        return null;
      }
      token = await giteaAccessTokenFor(identity);
    }
    return createForgeClient({
      kind: isForgeKind(row.provider) ? row.provider : 'github',
      apiBaseUrl: cfg.apiBaseUrl,
      webBaseUrl: cfg.webBaseUrl,
      token,
    });
  } catch (err) {
    console.warn(
      `[forge] integration ${row.id ?? '?'} (provider=${row.provider}) skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Build a github.com client from a freshly minted App installation token. */
export async function forgeFromInstallation(installationId: string): Promise<ForgeClient> {
  const token = await mintInstallationToken(installationId);
  return githubForge(token);
}

/** The endpoint a PAT integration row points at, without a token (for web URLs). */
export function forgeEndpointFromIntegration(row: { provider: string; config: unknown }): ForgeEndpoint | null {
  const cfg = row.config as ForgeIntegrationConfig;
  try {
    return resolveForgeEndpoint({
      kind: isForgeKind(row.provider) ? row.provider : 'github',
      apiBaseUrl: cfg.apiBaseUrl,
      webBaseUrl: cfg.webBaseUrl,
    });
  } catch {
    return null;
  }
}

/**
 * Which forge kind owns `owner/repo`: an App-bound map means github.com,
 * otherwise the enabled PAT row that names the repo decides. Defaults to
 * `github` when nothing is bound (a link written before the binding exists
 * keeps the historical value). Cached for a minute — this is read on every
 * ingested issue.
 */
const kindCache = new Map<string, { kind: ForgeKind; at: number }>();
const KIND_CACHE_MS = 60_000;

export async function forgeKindForRepo(owner: string, repo: string): Promise<ForgeKind> {
  const key = `${owner}/${repo}`;
  const hit = kindCache.get(key);
  if (hit && Date.now() - hit.at < KIND_CACHE_MS) return hit.kind;

  let kind: ForgeKind = 'github';
  try {
    const appBound = await db
      .select({ id: maps.id })
      .from(maps)
      .where(and(eq(maps.githubRepoOwner, owner), eq(maps.githubRepoName, repo), isNotNull(maps.githubInstallationId)))
      .limit(1);
    if (!Array.isArray(appBound) || appBound.length === 0) {
      const rows = await db
        .select({ provider: integrations.provider, config: integrations.config })
        .from(integrations)
        .where(and(inArray(integrations.provider, FORGE_PROVIDERS), eq(integrations.enabled, true)));
      const match = (Array.isArray(rows) ? rows : []).find((r) => {
        const cfg = r.config as ForgeIntegrationConfig | null;
        return cfg?.owner === owner && cfg?.repo === repo;
      });
      if (match && isForgeKind(match.provider)) kind = match.provider;
    }
  } catch (err) {
    // A lookup failure must not block an ingest; the historical value wins.
    console.warn(`[forge] kind lookup for ${key} failed, assuming github:`, err instanceof Error ? err.message : err);
  }
  kindCache.set(key, { kind, at: Date.now() });
  return kind;
}

/**
 * Synchronous read for code running inside a DB transaction (an extra
 * query there would take a second pool connection per ingest). Callers
 * warm the cache with `forgeKindForRepo` before opening the transaction;
 * an unwarmed read yields the historical `github`.
 */
export function forgeKindForRepoCached(owner: string, repo: string): ForgeKind {
  return kindCache.get(`${owner}/${repo}`)?.kind ?? 'github';
}

/** Test hook: forget cached repo → kind lookups. */
export function _resetForgeKindCacheForTests(): void {
  kindCache.clear();
}

// ── Per-map endpoint cache (web URLs) ─────────────────────────────
//
// Filled by `getForgeEndpointForMap` (lib/githubContext.ts); read
// synchronously by code that builds issue URLs inside sync callbacks.
// Lives here rather than next to the resolver because nine test files
// mock that module by path and the sync reader must keep working there.

const endpointCache = new Map<string, { endpoint: ForgeEndpoint; at: number }>();
const ENDPOINT_CACHE_MS = 60_000;

export function rememberForgeEndpointForMap(mapId: string, endpoint: ForgeEndpoint): void {
  endpointCache.set(mapId, { endpoint, at: Date.now() });
}

/** The cached endpoint if it is fresh, else null. */
export function cachedForgeEndpointForMap(mapId: string): ForgeEndpoint | null {
  const hit = endpointCache.get(mapId);
  return hit && Date.now() - hit.at < ENDPOINT_CACHE_MS ? hit.endpoint : null;
}

/**
 * Synchronous read of the last resolved endpoint for a map. Falls back to
 * github.com when nothing has been resolved yet; route plugins prime it in
 * a preHandler.
 */
export function forgeEndpointForMapCached(mapId: string): ForgeEndpoint {
  return endpointCache.get(mapId)?.endpoint ?? GITHUB_ENDPOINT;
}

/** `owner/repo#N` → the kind that owns the repo (see `forgeKindForRepo`). */
export async function forgeKindForExternalId(externalId: string): Promise<ForgeKind> {
  const m = externalId.match(/^([^/]+)\/([^/#]+)#\d+$/);
  if (!m) return 'github';
  return forgeKindForRepo(m[1], m[2]);
}
